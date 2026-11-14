#!/usr/bin/env node
/**
 * Contract test for the board-lab tool definitions, without a Harness.
 *
 * The Host plugin is loaded with a stub `ctx`, so every tool can be executed
 * directly and its result checked against the schema it declares. This is the
 * regression test for the bug class the Harness reported as
 * `tool "board_monitor" returned invalid output`: results carried undeclared
 * keys (`stopped`, `log`, `sock`, `pid`, …) and `undefined`/`null` values.
 *
 * The serial side runs against a pseudo-terminal, so no board is needed: the
 * monitor opens the pty exactly like a real port, and a small echo helper feeds
 * writes back as device output.
 *
 *   node tests/plugin_contract.mjs            # self-contained, uses a pty
 *   node tests/plugin_contract.mjs --port X   # also checks the real board
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, name } from '../index.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
// Firmware projects live in the workspace that contains the plugin directory.
const ROOT = dirname(PLUGIN)
// Keep the test out of the runtime state: a pty monitor must not leave log or
// offset files behind for the ports the real session uses.
const STATE_DIR = mkdtempSync(join(tmpdir(), 'board-lab-contract-'))
const PORT_ARG = process.argv.indexOf('--port')
const REAL_PORT = PORT_ARG > -1 ? process.argv[PORT_ARG + 1] : undefined

const problems = []
const fail = (message) => problems.push(message)

// ------------------------------------------------------------------ validator
function typeOf(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

function validate(schema, value, path = 'value') {
  if (schema.type !== undefined) {
    const actual = typeOf(value)
    const expected = schema.type === 'integer' ? 'number' : schema.type
    if (actual !== expected) {
      fail(`${path}: expected ${schema.type}, got ${actual}`)
      return
    }
    if (schema.type === 'integer' && !Number.isInteger(value)) fail(`${path}: expected integer, got ${value}`)
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    fail(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`)
  }
  if (schema.type === 'object' || schema.properties !== undefined) {
    if (typeOf(value) !== 'object') return
    for (const key of schema.required ?? []) {
      if (!(key in value)) fail(`${path}: missing required "${key}"`)
    }
    const properties = schema.properties ?? {}
    for (const [key, item] of Object.entries(value)) {
      if (properties[key] === undefined) {
        if (schema.additionalProperties === false) fail(`${path}: undeclared property "${key}"`)
        continue
      }
      validate(properties[key], item, `${path}.${key}`)
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`))
  }
}

/** A result must survive JSON: no undefined, NaN, Infinity or functions. */
function assertLossless(value, path = 'value') {
  if (value === undefined) return fail(`${path}: undefined is not JSON`)
  if (typeof value === 'number' && !Number.isFinite(value)) return fail(`${path}: ${value} is not JSON`)
  if (typeof value === 'function' || typeof value === 'bigint') return fail(`${path}: ${typeof value} is not JSON`)
  if (Array.isArray(value)) return value.forEach((item, index) => assertLossless(item, `${path}[${index}]`))
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertLossless(item, `${path}.${key}`)
  }
}

function assertContract(definition, result) {
  assertLossless(result)
  validate(definition.output.schema, result, definition.name)
}

// ---------------------------------------------------------------- fake harness
const definitions = new Map()
const ctx = {
  tools: { register: (definition) => { definitions.set(definition.name, definition); return () => {} } },
  effect: (fn) => { fn(); return () => {} },
  inject: () => {},
}

apply(ctx, {
  workspaceRoot: ROOT,
  toolchainDir: '.toolchain',
  projectsDir: 'firmware',
  stateDir: STATE_DIR,
})

const call = async (tool, args) => {
  const definition = definitions.get(tool)
  if (definition === undefined) throw new Error(`tool ${tool} was not registered`)
  const result = await definition.execute(args)
  assertContract(definition, result)
  return result
}

// ------------------------------------------------------- pseudo-terminal device
const PTY_HELPER = `
import os, pty, sys, time
master, slave = pty.openpty()
print(os.ttyname(slave), flush=True)
while True:
    data = os.read(master, 4096)
    if not data:
        break
    os.write(master, data)
`

async function startPty() {
  const child = spawn('python3', ['-c', PTY_HELPER], { stdio: ['ignore', 'pipe', 'inherit'] })
  const path = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('pty helper did not report its device')), 5000)
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.includes('\n')) {
        clearTimeout(timer)
        resolvePromise(buffer.split('\n')[0].trim())
      }
    })
    child.on('error', reject)
  })
  return { path, stop: () => child.kill('SIGKILL') }
}

// ---------------------------------------------------------------------- checks
const ports = await call('board_ports', {})
if (!Array.isArray(ports.ports)) fail('board_ports: ports must be an array')
console.log(`board_ports: ${ports.ports.map((item) => item.path).join(', ') || '(none visible here)'}`)

const status = await call('board_monitor', { action: 'status' })
if (!Array.isArray(status.monitors)) fail('status: monitors must be an array')

// 1. The monitor lifecycle against a pseudo-terminal: start → write → read → stop.
const pty = await startPty()
try {
  const started = await call('board_monitor', { action: 'start', port: pty.path, reset: 'none' })
  console.log(`start: running=${started.running} reused=${started.reused}`)
  if (started.running !== true) fail(`start: monitor did not open ${pty.path}`)

  const again = await call('board_monitor', { action: 'start', port: pty.path, reset: 'none' })
  if (again.reused !== true) fail('start: a second start did not reuse the running monitor')

  const written = await call('board_write', { port: pty.path, text: 'PING' })
  if (written.ok !== true) fail('write: the pty refused a line')

  const read = await call('board_monitor', { action: 'read', port: pty.path, waitMs: 2000 })
  console.log(`read: ${JSON.stringify(read.text.slice(0, 40))} (${read.bytes} byte(s))`)
  if (!read.text.includes('PING')) fail('read: the echoed write never reached the log')

  const silent = await call('board_monitor', { action: 'read', port: pty.path, waitMs: 200 })
  if (silent.text !== '') fail('read: a second read must not repeat the same bytes')

  const stopped = await call('board_monitor', { action: 'stop', port: pty.path })
  console.log(`stop: stopped=${stopped.stopped}`)
  if (stopped.stopped !== true) fail('stop: the running monitor did not stop')

  const after = await call('board_monitor', { action: 'status' })
  if (after.monitors.some((item) => item.port === pty.path && item.running)) {
    fail('status: a stopped monitor is still reported as running')
  }
} finally {
  pty.stop()
}

// 2. board_watch: poll new output until a pattern appears.
const PTY_READY = `
import os, pty
master, slave = pty.openpty()
print(os.ttyname(slave), flush=True)
while True:
    data = os.read(master, 4096)
    if not data:
        break
    if b"GO" in data:
        os.write(master, b"READY\\n")
    os.write(master, data)
`
{
  const child = spawn('python3', ['-c', PTY_READY], { stdio: ['ignore', 'pipe', 'inherit'] })
  const device = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('ready-pty helper did not report its device')), 5000)
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.includes('\n')) {
        clearTimeout(timer)
        resolvePromise(buffer.split('\n')[0].trim())
      }
    })
    child.on('error', reject)
  })
  try {
    await call('board_monitor', { action: 'start', port: device, reset: 'none' })
    const watching = call('board_watch', { port: device, pattern: 'READY', timeoutMs: 6000 })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    await call('board_write', { port: device, text: 'GO' })
    const watched = await watching
    console.log(`watch: matched=${watched.matched} line=${JSON.stringify(watched.line)}`)
    if (watched.matched !== true) fail('watch: the pattern the device printed was never matched')
    await call('board_monitor', { action: 'stop', port: device })
  } finally {
    child.kill('SIGKILL')
  }
}

// 3. Stale state must never look like a running monitor.
const ghostPath = join(STATE_DIR, 'monitor-_dev_ttyFAKE.json')
writeFileSync(ghostPath, JSON.stringify({ pid: 999_999, port: '/dev/ttyFAKE', baud: 115200, startedAt: 0, open: true }))
try {
  const stale = await call('board_monitor', { action: 'status' })
  const ghost = stale.monitors.find((item) => item.port === '/dev/ttyFAKE')
  if (ghost === undefined) fail('status: the stale state file was not listed')
  else {
    console.log(`stale: running=${ghost.running} stale=${ghost.stale}`)
    if (ghost.running !== false) fail('status: a monitor with a dead pid is reported as running')
    if (ghost.stale !== true) fail('status: a dead monitor is not marked stale')
  }
} finally {
  rmSync(ghostPath, { force: true })
}

// 4. Optional: the attached board, when this process can see the device node.
if (REAL_PORT !== undefined) {
  try {
    const info = await call('board_info', { port: REAL_PORT })
    console.log(`board info: chip=${info.chip}${info.revision ? ` ${info.revision}` : ''} flash=${info.flashSize} psram=${info.psram} mac=${info.mac} ok=${info.ok}`)
    if (info.ok !== true) fail(`board_info: esptool failed — ${info.summary}`)
    const started = await call('board_monitor', { action: 'start', port: REAL_PORT, reset: 'esp' })
    console.log(`board start (${REAL_PORT}): running=${started.running}`)
    if (started.running !== true) fail(`board start: monitor did not open ${REAL_PORT}`)
    const boot = await call('board_monitor', { action: 'read', port: REAL_PORT, waitMs: 3000 })
    console.log(`board read: ${boot.bytes} byte(s)`)
    try {
      await call('board_write', { port: REAL_PORT, text: 'PING' })
      console.log('board write: accepted')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`board write: rejected — ${message}`)
      if (message === 'Write timeout') fail('write: the raw pyserial message is not actionable')
    }
  } finally {
    // Never leave a monitor holding the real port behind: this test owns it.
    await call('board_monitor', { action: 'stop', port: REAL_PORT }).catch(() => {})
  }
}

// 5. A watch is about the future: a line printed before the call must not match,
// unless fromStart explicitly asks for the whole log.
{
  const pty = await startPty()
  try {
    await call('board_monitor', { action: 'start', port: pty.path, reset: 'none' })
    await call('board_write', { port: pty.path, text: 'READY' })
    await call('board_monitor', { action: 'read', port: pty.path, waitMs: 1500 })
    const fresh = await call('board_watch', { port: pty.path, pattern: 'READY', timeoutMs: 1200 })
    console.log(`watch (backlog ignored): matched=${fresh.matched}`)
    if (fresh.matched !== false) fail('watch: a line printed before the call was matched as new output')
    const historical = await call('board_watch', { port: pty.path, pattern: 'READY', timeoutMs: 1200, fromStart: true })
    console.log(`watch (fromStart): matched=${historical.matched}`)
    if (historical.matched !== true) fail('watch: fromStart did not search the earlier log')

    // fromStart is a dump, not a rewind: the next normal read must stay empty.
    const dumped = await call('board_monitor', { action: 'read', port: pty.path, fromStart: true, maxBytes: 1024 })
    if (dumped.bytes === 0) fail('read: fromStart returned nothing from a non-empty log')
    const afterDump = await call('board_monitor', { action: 'read', port: pty.path })
    if (afterDump.text !== '') fail('read: fromStart rewound the cursor and the log replayed')

    const stopped = await call('board_monitor', { action: 'stop', port: pty.path })
    if (stopped.stopped !== true) fail('stop: the pty monitor did not stop')
    const buffered = await call('board_monitor', { action: 'read', port: pty.path, fromStart: true })
    if (buffered.running !== false) fail('read: a stopped monitor still reports running')
  } finally {
    pty.stop()
  }
}

// 6. A start that cannot open the port is a failure, not a running monitor.
{
  const failed = await call('board_monitor', { action: 'start', port: '/dev/ttyNOPE', reset: 'none' })
  console.log(`start (missing port): ok=${failed.ok} running=${failed.running}`)
  if (failed.ok !== false) fail('start: a missing serial port was reported as success')
  if (failed.running !== false) fail('start: a failed start still reports a running monitor')
  const listed = await call('board_monitor', { action: 'status' })
  if (listed.monitors.some((item) => item.port === '/dev/ttyNOPE')) {
    fail('status: a failed start left its bookkeeping behind')
  }
}

// 7. A typo in `project` must name the projects that do exist.
try {
  await call('board_build', { project: 'firmware/does-not-exist' })
  fail('build: a missing project directory was accepted')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.log(`build (missing project): ${message.slice(0, 120)}`)
}


// 8. Panic decoding: a synthetic ESP32-S3 dump resolved against the real ELF.
const PTY_PANIC = `
import os, pty
master, slave = pty.openpty()
print(os.ttyname(slave), flush=True)
panic = (
    "Guru Meditation Error: Core  0 panic'ed (LoadProhibited). Exception was unhandled.\\n"
    "Backtrace: 0x42009ac8:0x3fcebd50 0x42001234:0x3fcebd80\\n"
)
while True:
    data = os.read(master, 4096)
    if not data:
        break
    if b"GO" in data:
        os.write(master, panic.encode())
    os.write(master, data)
`
{
  const panicText = [
    "Guru Meditation Error: Core  0 panic'ed (LoadProhibited). Exception was unhandled.",
    'Core  0 register dump:',
    'PC      : 0x42009ac8  PS      : 0x00060d30  A0      : 0x8200e9a0  A1      : 0x3fcebd50',
    'Backtrace: 0x42009ac8:0x3fcebd50 0x42001234:0x3fcebd80',
  ].join('\n')
  const decoded = await call('board_decode', { project: 'firmware/esp32s3-hello', text: panicText })
  console.log(`decode: ${String(decoded.summary).slice(0, 100)}`)
  if (decoded.ok !== true) fail('decode: a valid panic was not decoded')
  if (!String(decoded.summary).includes('LoadProhibited')) fail('decode: the exception name was lost')
  if (!decoded.frames.join('\n').includes('app_main')) fail('decode: the app_main frame did not resolve')
  if (!String(decoded.elf ?? '').endsWith('firmware.elf')) fail('decode: the ELF path is not reported')

  const child = spawn('python3', ['-c', PTY_PANIC], { stdio: ['ignore', 'pipe', 'inherit'] })
  const device = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('panic-pty helper did not report its device')), 5000)
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.includes('\n')) {
        clearTimeout(timer)
        resolvePromise(buffer.split('\n')[0].trim())
      }
    })
    child.on('error', reject)
  })
  try {
    const watching = call('board_watch', {
      port: device,
      pattern: 'Guru Meditation',
      timeoutMs: 6000,
      project: 'firmware/esp32s3-hello',
    })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
    await call('board_write', { port: device, text: 'GO' })
    const watched = await watching
    console.log(`watch panic: panic=${watched.panic} decode=${watched.decode?.ok}`)
    if (watched.panic !== true) fail('watch: a panic match was not flagged')
    if (watched.decode?.ok !== true) fail(`watch: the panic was not auto-decoded — ${watched.decode?.summary}`)
    await call('board_monitor', { action: 'stop', port: device })
  } finally {
    child.kill('SIGKILL')
  }
}

// 9. Detection: a non-ESP device must come back as a reasoned "none", not a crash.
{
  const pty = await startPty()
  try {
    const detected = await call('board_detect', { port: pty.path })
    const entry = detected.ports[0]
    console.log(`detect: confidence=${entry.confidence} reason=${String(entry.reason).slice(0, 80)}`)
    if (entry.confidence !== 'none') fail('detect: a pty was presented as an identified board')
    if (typeof entry.reason !== 'string') fail('detect: no reason was given')
  } finally {
    pty.stop()
  }
  if (REAL_PORT !== undefined) {
    const detected = await call('board_detect', { port: REAL_PORT })
    const entry = detected.ports[0]
    console.log(`detect (board): chip=${entry.chip} family=${entry.family} project=${entry.project} confidence=${entry.confidence}`)
    if (entry.chip === undefined) fail('detect: the real board did not report a chip')
  }
}

// 10. Scenario runner: steps execute in order and a pass is a pass.
{
  const child = spawn('python3', ['-c', PTY_READY], { stdio: ['ignore', 'pipe', 'inherit'] })
  const device = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('scenario-pty helper did not report its device')), 5000)
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.includes('\n')) {
        clearTimeout(timer)
        resolvePromise(buffer.split('\n')[0].trim())
      }
    })
    child.on('error', reject)
  })
  const scenario = join(STATE_DIR, 'scenario.json')
  writeFileSync(scenario, JSON.stringify({
    name: 'pty smoke',
    steps: [
      { write: { text: 'GO' } },
      { watch: { pattern: 'READY', timeoutMs: 3000 } },
      { absent: { pattern: 'Guru Meditation', withinMs: 300 } },
      { sleep: { ms: 10 } },
    ],
  }))
  try {
    const run = await call('board_test', { project: 'firmware/esp32s3-hello', port: device, file: scenario })
    console.log(`test: ok=${run.ok} steps=${run.steps.length} run=${run.run !== undefined}`)
    if (run.ok !== true) fail(`test: a passing scenario failed — ${run.steps.map((step) => `${step.action}:${step.detail}`).join(' | ')}`)
    if (run.steps.length !== 4) fail('test: not every step ran')
    if (run.steps[0].action !== 'write' || run.steps[1].action !== 'watch') fail('test: steps ran out of order')
    if (run.run === undefined) fail('test: no report directory was written')
    await call('board_monitor', { action: 'stop', port: device })
  } finally {
    child.kill('SIGKILL')
  }
}

rmSync(STATE_DIR, { recursive: true, force: true })

if (problems.length > 0) {
  console.error(`\n${name}: ${problems.length} contract problem(s)`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`\nOK: ${name} tools match their declared output schemas`)
