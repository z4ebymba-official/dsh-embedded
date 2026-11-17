/**
 * @local/board-lab — the embedded closed loop for the dsh web profile.
 *
 * Host half:
 *   tools     board_ports / board_build / board_flash / board_monitor /
 *             board_write / board_cycle
 *   HTTP      /board-lab/* routes the Board lab panel calls from the browser
 *
 * The monitor is a detached process (monitor.py) that owns the serial port
 * across tool calls: flashing stops it, uploads, and restarts it, so the boot
 * log of the new firmware is captured without unplugging the board.
 *
 * Everything runs through the workspace-local toolchain under `<toolchainDir>`
 * (see the `board_tools` install action): no root, no writes to $HOME.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  forgetPorts,
  hasCommand,
  isWindows,
  killTree,
  listPorts as hostListPorts,
  pathListSeparator,
  pidAlive as hostPidAlive,
  platformioCoreDir,
  platformioPio,
  platformioPython,
} from './host.js'

export const name = 'board-lab'
export const inject = ['tools']

const BUNDLE_DIR = dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  /** Absolute workspace root; empty means the Harness process working directory. */
  workspaceRoot: '',
  /** Toolchain directory relative to workspaceRoot (or absolute). */
  toolchainDir: '.toolchain',
  /** Directory scanned for firmware projects, relative to workspaceRoot. */
  projectsDir: 'firmware',
  /** Monitor logs, sockets and offsets. */
  stateDir: '.board-lab',
  /** Python interpreter for PlatformIO/esptool; empty means auto-detect (PATH, then PlatformIO's penv). */
  python: '',
  /** Default UART baud rate. */
  defaultBaud: 115200,
  /** Cap for captured subprocess output, in characters. */
  maxOutputBytes: 64 * 1024,
}

const ANSI = /\u001B\[[0-9;]*m/g
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Strip ANSI escapes so captured logs stay readable. */
function clean(text) {
  return text.replace(ANSI, '')
}

/** Keep the tail of a long log; the end carries the verdict. */
function tail(text, limit) {
  const value = clean(text)
  return value.length <= limit ? value : `…\n${value.slice(value.length - limit)}`
}

/**
 * Keep only the last `lines` lines of a monitor chunk.
 *
 * The read cursor has already advanced past the whole chunk, so the dropped
 * part is gone on purpose: a debug read is one glance at the tail, not a
 * transcript the agent re-reads until it runs out of context.
 * @param {{ text?: string }} chunk
 * @param {number} lines
 */
export function lastLines(chunk, lines) {
  const text = typeof chunk.text === 'string' ? chunk.text : ''
  if (text === '' || lines < 1) return chunk
  const parts = text.split('\n')
  const trailingBreak = parts[parts.length - 1] === ''
  const rows = trailingBreak ? parts.slice(0, -1) : parts
  if (rows.length <= lines) return chunk
  const kept = rows.slice(-lines).join('\n')
  return { ...chunk, text: trailingBreak ? `${kept}\n` : kept, droppedLines: rows.length - lines }
}

/** Read the first readable file from a list of candidates. */
function readFirst(paths) {
  for (const file of paths) {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

/** USB-UART bridges and native Espressif USB commonly used by these boards. */
const KNOWN_BRIDGES = /^(303a|10c4|1a86|0403|2e3c|0483|1366)$/i

const PROJECT_PARAM = {
  type: 'string',
  description: 'Firmware project directory — absolute, or relative to the workspace root.',
}

const ENV_PARAM = {
  type: 'string',
  description: 'PlatformIO environment name; omit for the project default.',
}

/** Shape of one checkpoint row, shared by every action that returns them. */
const CHECKPOINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'project', 'createdAt', 'files', 'bytes'],
  properties: {
    id: { type: 'string' },
    project: { type: 'string' },
    name: { type: 'string' },
    dir: { type: 'string' },
    env: { type: 'string' },
    label: { type: 'string' },
    files: { type: 'integer' },
    bytes: { type: 'integer' },
    createdAt: { type: 'string' },
    restoredAt: { type: 'string' },
    guard: { type: 'boolean' },
    /** Does this snapshot still equal the working tree, and what drifted. */
    state: {
      type: 'object',
      additionalProperties: false,
      properties: {
        same: { type: 'boolean' },
        changed: { type: 'integer' },
        added: { type: 'integer' },
        removed: { type: 'integer' },
        other: { type: 'boolean' },
        missing: { type: 'boolean' },
      },
    },
  },
}

const PORT_PARAM = {
  type: 'string',
  description: 'Serial port, e.g. /dev/ttyACM0. Omit to auto-select the only attached board.',
}

/** Toolchains a fresh machine needs; the panel settings page installs them on demand. */
const TOOL_CATALOG = [
  { id: 'platformio', name: 'PlatformIO Core', group: 'core', kind: 'pip', pkg: 'platformio', why: 'Build and upload for ESP32, AVR, STM32 and AT32.' },
  { id: 'pyserial', name: 'pyserial', group: 'common', kind: 'pip', pkg: 'pyserial', module: 'serial', why: 'UART monitor and port listing.' },
  { id: 'esptool', name: 'esptool', group: 'esp32', kind: 'pip', pkg: 'esptool', why: 'ESP32 chip info, erase and upload fallback.' },
  { id: 'espressif32', name: 'Platform espressif32', group: 'esp32', kind: 'platform', pkg: 'espressif32', why: 'ESP32/S2/S3 compilers and frameworks.' },
  { id: 'atmelavr', name: 'Platform atmelavr', group: 'avr', kind: 'platform', pkg: 'atmelavr', why: 'Arduino Uno/Nano/Mega compilers and avrdude.' },
  { id: 'avrdude', name: 'avrdude', group: 'avr', kind: 'tool', pkg: 'tool-avrdude', why: 'Upload to Arduino AVR boards.' },
  { id: 'ststm32', name: 'Platform ststm32', group: 'stm32', kind: 'platform', pkg: 'ststm32', why: 'STM32 compilers and frameworks.' },
  { id: 'stlink', name: 'ST-Link tools', group: 'stm32', kind: 'tool', pkg: 'tool-stlink', why: 'ST-Link probes: st-flash and st-info.' },
  { id: 'dfu', name: 'dfu-util', group: 'stm32', kind: 'tool', pkg: 'tool-dfuutil', why: 'STM32/AT32 DFU uploads.' },
  { id: 'openocd', name: 'OpenOCD', group: 'at32', kind: 'tool', pkg: 'tool-openocd', why: 'ST-Link/CMSIS-DAP uploads for AT32 and STM32.' },
  { id: 'armgcc', name: 'ARM GCC', group: 'at32', kind: 'tool', pkg: 'toolchain-gccarmnoneeabi', why: 'AT32 and Makefile projects (arm-none-eabi-gcc).' },
]

/** Symbolized panic frames, shared by board_decode and board_watch. */
const DECODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'summary'],
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    elf: { type: 'string' },
    elfModified: { type: 'string' },
    exception: { type: 'string' },
    core: { type: 'integer' },
    frames: { type: 'array', items: { type: 'string' } },
    output: { type: 'string' },
  },
}

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }
  // The bundle usually sits inside the workspace (`<root>/board-lab`, or
  // `<root>/tools/board-lab`), so the default root travels with the repository
  // and needs no absolute path in the profile — that is what makes one bundle
  // work on every machine. A standalone install can pin `workspaceRoot`.
  const workspaceGuess = [resolvePath(BUNDLE_DIR, '..'), resolvePath(BUNDLE_DIR, '..', '..')]
    .find((candidate) => existsSync(join(candidate, settings.projectsDir)))
  const baseDir = settings.workspaceRoot !== ''
    ? resolvePath(settings.workspaceRoot)
    : workspaceGuess ?? process.cwd()
  const toolchainDir = isAbsolute(settings.toolchainDir)
    ? settings.toolchainDir
    : resolvePath(baseDir, settings.toolchainDir)
  const pythonLib = join(toolchainDir, 'pylib')
  const projectsRoot = resolvePath(baseDir, settings.projectsDir)
  const stateRoot = isAbsolute(settings.stateDir) ? settings.stateDir : resolvePath(baseDir, settings.stateDir)

  const workspacePython = existsSync(pythonLib)
  const workspacePio = existsSync(join(toolchainDir, 'pio'))
  let pythonCache

  /**
   * Interpreter that owns pyserial/esptool.
   *
   * Order: explicit config → an installed PlatformIO virtualenv (Windows offices
   * already have one) → system python with the workspace site-packages.
   */
  function pythonCommand() {
    if (pythonCache !== undefined) return pythonCache
    let command = settings.python
    let source = 'config'
    if (command === '') {
      const external = platformioPython()
      if (external !== undefined) {
        command = external
        source = 'platformio'
      } else {
        command = isWindows ? 'python' : 'python3'
        source = 'path'
      }
    }
    pythonCache = { command, source }
    return pythonCache
  }

  /** Attached ports, listed with the interpreter that owns pyserial. */
  function attachedPorts() {
    return hostListPorts(pythonCommand().command, workspacePython ? pythonLib : undefined)
  }

  /** Environment for Python children: workspace site-packages only when we own the interpreter. */
  function pythonEnv() {
    const env = { ...process.env }
    const external = pythonCommand().source === 'platformio'
    if (workspacePython && !external) {
      env.PYTHONPATH = [pythonLib, env.PYTHONPATH].filter(Boolean).join(pathListSeparator)
    }
    if (workspacePio) {
      env.PLATFORMIO_CORE_DIR = join(toolchainDir, 'pio')
      env.XDG_CACHE_HOME = join(toolchainDir, 'cache')
    }
    env.PLATFORMIO_SETTING_ENABLE_TELEMETRY = 'no'
    env.PLATFORMIO_SETTING_CHECK_PLATFORMIO_UPGRADE = 'no'
    return env
  }

  /** Run one Python module (esptool, platformio) with the resolved interpreter. */
  function runPython(args, options = {}) {
    return runProcess(pythonCommand().command, args, {
      env: pythonEnv(),
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      cwd: options.cwd,
    })
  }

  /** Resolve a firmware project path; absolute stays absolute, relative joins the workspace root. */
  function projectDir(project) {
    const value = typeof project === 'string' && project.trim() !== '' ? project.trim() : ''
    if (value === '') throw new Error('`project` must name a firmware project directory')
    return isAbsolute(value) ? value : resolvePath(baseDir, value)
  }

  /** Run one child process and capture capped output. */
  function runProcess(command, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? 600_000
    const limit = options.maxOutputBytes ?? settings.maxOutputBytes
    return new Promise((resolvePromise) => {
      const started = Date.now()
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      let child
      try {
        child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        resolvePromise({
          ok: false, exitCode: null, stdout: '', stderr: String(error),
          timedOut: false, durationMs: 0, spawnError: error,
        })
        return
      }
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      const keep = (current, chunk) => {
        const next = current + chunk
        return next.length <= limit * 2 ? next : next.slice(next.length - limit * 2)
      }
      child.stdout?.on('data', (chunk) => { stdout = keep(stdout, chunk.toString()) })
      child.stderr?.on('data', (chunk) => { stderr = keep(stderr, chunk.toString()) })
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({
          ok: false, exitCode: null, stdout, stderr: String(error),
          timedOut, durationMs: Date.now() - started, spawnError: error,
        })
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({
          ok: code === 0 && !timedOut, exitCode: code, stdout, stderr,
          timedOut, durationMs: Date.now() - started,
        })
      })
    })
  }

  /** Run PlatformIO: a `pio` console script when installed, else `python -m platformio`. */
  async function runPio(args, options = {}) {
    const binary = platformioPio()
    let result
    if (binary !== undefined) {
      result = await runProcess(binary, args, {
        env: pythonEnv(),
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        cwd: options.cwd,
      })
      if (result.spawnError?.code === 'ENOENT') result = undefined
    }
    if (result === undefined) {
      if (!workspacePython && platformioPython() === undefined) {
        throw new Error(
          `PlatformIO was not found: no ${join(toolchainDir, 'pylib')} and no PlatformIO virtualenv. `
          + 'Install it with `board_tools` action `install` id `platformio`, or from platformio.org/install, '
          + 'then set the plugin config `python`/`toolchainDir` if they live elsewhere.',
        )
      }
      result = await runPython(['-m', 'platformio', ...args], {
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        cwd: options.cwd,
      })
    }
    if (result.spawnError?.code === 'ENOENT') {
      throw new Error(
        `Python executable "${pythonCommand().command}" was not found. Install Python 3, PlatformIO, or set the plugin's \`python\` config.`,
      )
    }
    return result
  }

  /** Which build backend a project directory uses. */
  function projectKind(dir) {
    if (!existsSync(dir)) {
      // A typo is the common case, and the fix is to name an existing project:
      // list them instead of making the caller guess or run board_projects.
      const available = listProjects().map((project) => project.name)
      throw new Error(
        `Project directory ${dir} does not exist; ${available.length === 0
          ? `no firmware projects were found under ${projectsRoot}`
          : `available projects: ${available.join(', ')}`}`,
      )
    }
    if (existsSync(join(dir, 'platformio.ini'))) return 'pio'
    if (existsSync(join(dir, 'Makefile'))) return 'make'
    throw new Error(`No platformio.ini or Makefile in ${dir}; cannot tell how to build it.`)
  }

  /** Environment for make-based projects: the PlatformIO-installed ARM toolchain. */
  function makeEnv() {
    const env = pythonEnv()
    if (workspacePio) {
      env.TOOLCHAIN = join(toolchainDir, 'pio', 'packages', 'toolchain-gccarmnoneeabi')
    }
    return env
  }

  /** Run make in a project directory. */
  async function runMake(dir, targets, options = {}) {
    const result = await runProcess('make', ['-C', dir, ...targets], {
      env: { ...makeEnv(), ...(options.extraEnv ?? {}) },
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    })
    if (result.spawnError?.code === 'ENOENT') {
      throw new Error(isWindows
        ? '`make` was not found. AT32 builds on Windows need MSYS2 (pacman -S make) and arm-none-eabi-gcc on PATH.'
        : '`make` was not found. Install it with `sudo apt install build-essential`.')
    }
    return result
  }

  /** Compose a build/flash summary from a run. */
  function summarise(label, result) {
    const output = tail(`${result.stdout}\n${result.stderr}`, settings.maxOutputBytes)
    const verdict = result.timedOut
      ? `timed out after ${result.durationMs} ms`
      : result.ok
        ? 'succeeded'
        : `failed with exit code ${String(result.exitCode)}`
    const ram = /RAM:\s*\[[^\]]*\]\s*([0-9.]+%[^\n]*)/.exec(clean(result.stdout))
    const flash = /Flash:\s*\[[^\]]*\]\s*([0-9.]+%[^\n]*)/.exec(clean(result.stdout))
    const facts = [ram ? `RAM ${ram[1].trim()}` : '', flash ? `Flash ${flash[1].trim()}` : '']
      .filter(Boolean)
      .join(' · ')
    const errorHint = !result.ok
      ? /could not open port[^\n]*|Permission denied[^\n]*|Failed to connect[^\n]*|Wrong chip[^\n]*/i.exec(clean(`${result.stdout}\n${result.stderr}`))?.[0]
      : undefined
    return {
      ok: result.ok,
      exitCode: result.exitCode ?? -1,
      durationMs: result.durationMs,
      output,
      summary: `${label} ${verdict}${facts === '' ? '' : ` (${facts})`}${errorHint ? ` — ${errorHint}` : ''}`,
    }
  }

  /** Choose the requested port or the only plausible attached one. */
  function selectPort(requested) {
    if (typeof requested === 'string' && requested.trim() !== '') return requested.trim()
    const ports = attachedPorts()
    const preferred = ports.filter((port) => port.vendorId === undefined || KNOWN_BRIDGES.test(port.vendorId))
    const pool = preferred.length > 0 ? preferred : ports
    if (pool.length === 0) {
      throw new Error(
        isWindows
          ? 'No serial port is attached. Connect the board and run board_ports; Windows shows it as COM1, COM3, … — check Device Manager if nothing appears.'
          : 'No serial port is attached. Connect the board and run board_ports; on Linux the user must be able to open the device (dialout group or a udev rule).',
      )
    }
    if (pool.length > 1) {
      throw new Error(
        `Several serial ports are attached (${pool.map((port) => port.path).join(', ')}); pass \`port\` explicitly.`,
      )
    }
    return pool[0].path
  }

  /** Firmware projects discovered under the projects directory. */
  function listProjects() {
    if (!existsSync(projectsRoot)) return []
    const projects = []
    for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(projectsRoot, entry.name)
      const kind = existsSync(join(dir, 'platformio.ini'))
        ? 'pio'
        : existsSync(join(dir, 'Makefile'))
          ? 'make'
          : undefined
      if (kind === undefined) continue
      projects.push({ name: entry.name, path: `${settings.projectsDir}/${entry.name}`, kind })
    }
    return projects.sort((left, right) => left.name.localeCompare(right.name))
  }

  // ------------------------------------------------------ project introspection
  // A project directory is not enough to pick the right board: the PlatformIO
  // environment names the chip, and that name is what separates an ESP32-S3
  // from an ESP32-C6 when a board is plugged in.

  /** [env:NAME] sections of a platformio.ini, each with the chip family of its board. */
  function pioEnvs(dir) {
    const file = join(dir, 'platformio.ini')
    if (!existsSync(file)) return []
    const envs = []
    let current
    let defaultEnv
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '' || line.startsWith(';') || line.startsWith('#')) continue
      const header = /^\[([^\]]+)\]$/.exec(line)
      if (header !== null) {
        const section = header[1].trim()
        if (section === 'platformio') current = { global: true }
        else if (section.startsWith('env:')) {
          current = { name: section.slice(4).trim() }
          envs.push(current)
        } else current = undefined
        continue
      }
      if (current === undefined) continue
      const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line)
      if (pair === null) continue
      const key = pair[1].toLowerCase()
      const value = pair[2].trim().replace(/^["']|["']$/g, '')
      if (current.global === true) {
        if (key === 'default_envs') defaultEnv = value.split(',')[0].trim()
        continue
      }
      if (key === 'board') current.board = value
      else if (key === 'platform') current.platform = value
      else if (key === 'upload_protocol') current.uploadProtocol = value
    }
    for (const env of envs) {
      env.family = chipFamilyFromBoard(env.board)
      env.default = env.name === defaultEnv || (defaultEnv === undefined && envs[0] === env)
    }
    return envs
  }

  /** Chip family implied by a PlatformIO `board =` value. */
  function chipFamilyFromBoard(board) {
    const value = String(board ?? '').toLowerCase()
    if (value === '') return undefined
    if (value.includes('s3')) return 'esp32s3'
    if (value.includes('s2')) return 'esp32s2'
    if (value.includes('esp32c') || value.includes('esp32h') || /\bc[236]\b/.test(value)) return 'riscv32'
    if (value.includes('esp32')) return 'esp32'
    if (/^(uno|nano|mega|leonardo|micro|pro ?micro|atmega|attiny|arduino)/.test(value)) return 'avr'
    if (value.includes('stm32') || /^(bluepill|blackpill|f103|f401|f411|f405|g0|g4|l4|h7)/.test(value)) return 'stm32'
    return undefined
  }

  /** Chip family implied by an esptool "Chip type: …" value. */
  function chipFamily(chip) {
    const value = String(chip ?? '').toUpperCase()
    if (value.includes('ESP32-S3')) return 'esp32s3'
    if (value.includes('ESP32-S2')) return 'esp32s2'
    if (value.includes('ESP32-C') || value.includes('ESP32-H')) return 'riscv32'
    if (value.includes('ESP32')) return 'esp32'
    return undefined
  }

  /** Chip family hinted by the USB vendor id of an attached port. */
  function usbFamily(vendorId, productId) {
    const vendor = String(vendorId ?? '').toLowerCase()
    if (vendor === '2341' || vendor === '2a03') return 'avr'
    if (vendor === '0483') return 'stm32'
    if (vendor === '2e3c') return 'at32'
    if (vendor === '303a') return 'esp32'
    return undefined
  }

  /** STM32 over an ST-Link probe (st-info from the stlink tools). */
  async function probeStm32() {
    if (!hasCommand('st-info')) return undefined
    try {
      const result = await runProcess('st-info', ['--probe'], { timeoutMs: 15_000 })
      const output = clean(`${result.stdout}\n${result.stderr}`)
      if (result.ok !== true) return undefined
      const devType = /dev-type:\s*(\S+)/i.exec(output)?.[1]
      const chipId = /chipid:\s*(0x[0-9a-f]+)/i.exec(output)?.[1]
      if (devType === undefined && chipId === undefined) return undefined
      const flash = /flash:\s*(\d+)/i.exec(output)?.[1]
      const sram = /sram:\s*(\d+)/i.exec(output)?.[1]
      return {
        family: 'stm32',
        chip: devType ?? chipId,
        chipId,
        flashSize: flash === undefined ? undefined : `${Math.round(Number(flash) / 1024)}KB`,
        sramSize: sram === undefined ? undefined : `${Math.round(Number(sram) / 1024)}KB`,
        note: 'read with st-info --probe (ST-Link)',
        output,
      }
    } catch {
      return undefined
    }
  }

  /** One project with its environments and chip families. */
  function projectSummary(path) {
    const dir = projectDir(path)
    const kind = projectKind(dir)
    const envs = kind === 'pio' ? pioEnvs(dir) : []
    const families = [...new Set(envs.map((env) => env.family).filter(Boolean))]
    if (kind === 'make') families.push('at32')
    const name = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? dir
    return { name, path, dir, kind, envs, families }
  }

  /** Where the scenario runner writes its reports. */
  function projectLabel(dir) {
    if (dir === projectsRoot) return settings.projectsDir
    if (dir.startsWith(`${projectsRoot}/`)) return `${settings.projectsDir}/${dir.slice(projectsRoot.length + 1)}`
    return dir
  }

  // -------------------------------------------------------------- current project
  // `firmware/<name>` is a plain folder the user can open and drop libraries
  // into (`lib/`). Exactly one project is "current": the panel selects it, the
  // agent reads it, and a bare `board_flash` never has to guess between two
  // projects that target the same chip.

  const currentFile = join(stateRoot, 'current.json')

  function readCurrent() {
    if (!existsSync(currentFile)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(currentFile, 'utf8'))
      if (typeof parsed?.project !== 'string' || parsed.project.trim() === '') return undefined
      return {
        project: parsed.project,
        env: typeof parsed.env === 'string' && parsed.env !== '' ? parsed.env : undefined,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
      }
    } catch {
      return undefined
    }
  }

  function writeCurrent(value) {
    mkdirSync(stateRoot, { recursive: true })
    const temporary = `${currentFile}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
    renameSync(temporary, currentFile)
  }

  /** The current project with its environments, or undefined when it vanished. */
  function currentProject() {
    const saved = readCurrent()
    if (saved === undefined) return undefined
    let summary
    try {
      summary = projectSummary(saved.project)
    } catch {
      return undefined
    }
    const env = saved.env !== undefined && summary.envs.some((item) => item.name === saved.env)
      ? saved.env
      : summary.envs.find((item) => item.default === true)?.name ?? summary.envs[0]?.name
    const board = summary.envs.find((item) => item.name === env)?.board ?? summary.envs[0]?.board
    return {
      project: summary.path,
      name: summary.name,
      path: summary.path,
      dir: summary.dir,
      kind: summary.kind,
      env,
      board,
      envs: summary.envs.map((item) => item.name),
      families: summary.families,
      updatedAt: saved.updatedAt,
    }
  }

  function selectProject({ project, env } = {}) {
    if (typeof project !== 'string' || project.trim() === '') {
      throw new Error('Pass a project directory, for example "firmware/esp32s3-hello".')
    }
    const summary = projectSummary(project)
    let chosen = env
    if (chosen !== undefined && !summary.envs.some((item) => item.name === chosen)) {
      throw new Error(`${summary.name} has no environment "${chosen}"; available: ${summary.envs.map((item) => item.name).join(', ') || 'none'}.`)
    }
    if (chosen === undefined) chosen = summary.envs.find((item) => item.default === true)?.name ?? summary.envs[0]?.name
    writeCurrent({ project: summary.path, env: chosen, updatedAt: new Date().toISOString() })
    return currentProject()
  }

  // ------------------------------------------------------------- checkpoints
  // A checkpoint is a copy of one firmware project laid out as
  // `<stateDir>/checkpoints/<id>/files`, with the build output and VCS data
  // left out: source only, small enough to keep a dozen of them around.
  //
  // Restore means "put the tree back exactly as it was": snapshot files are
  // copied over the project and every file the snapshot does not know about is
  // removed (again, with the same exclusions). A restore takes its own
  // checkpoint first, so an accidental restore is itself undoable.

  const CHECKPOINT_SKIP = new Set(['.pio', '.git', '.venv', 'node_modules', '.board-lab', 'build', '.platformio'])

  function checkpointsRoot() {
    return join(stateRoot, 'checkpoints')
  }

  function checkpointStamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  }

  /** Copy one directory tree, skipping build output; returns what it copied. */
  function copyTree(source, target) {
    let files = 0
    let bytes = 0
    const walk = (from, to) => {
      mkdirSync(to, { recursive: true })
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        if (CHECKPOINT_SKIP.has(entry.name)) continue
        const src = join(from, entry.name)
        const dst = join(to, entry.name)
        if (entry.isDirectory()) walk(src, dst)
        else if (entry.isFile()) {
          bytes += statSync(src).size
          copyFileSync(src, dst)
          files += 1
        }
      }
    }
    walk(source, target)
    return { files, bytes }
  }

  /** Relative paths of every copied file, so restore knows what should exist. */
  function treeFiles(root, prefix = '', into = new Set()) {
    if (!existsSync(root)) return into
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) treeFiles(join(root, entry.name), rel, into)
      else if (entry.isFile()) into.add(rel)
    }
    return into
  }

  /** Delete everything under `dir` that the checkpoint did not contain. */
  function dropExtraneous(dir, prefix, keep) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (prefix === '' && CHECKPOINT_SKIP.has(entry.name)) continue
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (treeFiles(full, rel).size === 0 && !keep.has(rel)) {
          rmSync(full, { recursive: true, force: true })
          continue
        }
        dropExtraneous(full, rel, keep)
      } else if (entry.isFile() && !keep.has(rel)) {
        unlinkSync(full)
      }
    }
  }

  function readCheckpoint(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new Error(`"${String(id)}" is not a checkpoint id.`)
    }
    const file = join(checkpointsRoot(), id, 'meta.json')
    if (!existsSync(file)) throw new Error(`Checkpoint ${id} is gone.`)
    return JSON.parse(readFileSync(file, 'utf8'))
  }

  function checkpointList() {
    const root = checkpointsRoot()
    if (!existsSync(root)) return []
    const items = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        items.push(readCheckpoint(entry.name))
      } catch {
        // A half-written folder is not a checkpoint; ignore it.
      }
    }
    const current = currentProject()?.path
    return items
      .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
      .map((item) => ({ ...item, state: current === undefined ? undefined : checkpointState(item, current) }))
  }

  /**
   * What the project looks like right now, file by file. Used to say whether a
   * checkpoint still *is* the current state — the question the panel has to
   * answer before anyone presses restore.
   */
  function treeDigests(root, prefix = '', into = new Map()) {
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      return into
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || CHECKPOINT_SKIP.has(entry.name)) continue
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        treeDigests(join(root, entry.name), rel, into)
      } else if (entry.isFile()) {
        try {
          into.set(rel, createHash('sha1').update(readFileSync(join(root, entry.name))).digest('hex'))
        } catch {
          // An unreadable file is not a reason to fail the panel.
        }
      }
    }
    return into
  }

  const digestCache = new Map()

  /** Cheap "(count, bytes, newest mtime)" stamp: only re-hash when the tree moved. */
  function treeStamp(root) {
    let count = 0
    let bytes = 0
    let newest = 0
    const walk = (dir) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || CHECKPOINT_SKIP.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        try {
          const info = statSync(full)
          count += 1
          bytes += info.size
          newest = Math.max(newest, info.mtimeMs)
        } catch {
          // Vanished mid-walk: ignore.
        }
      }
    }
    walk(root)
    return `${count}:${bytes}:${Math.round(newest)}`
  }

  function digestFor(dir) {
    const stamp = treeStamp(dir)
    const cached = digestCache.get(dir)
    if (cached !== undefined && cached.stamp === stamp) return cached.digests
    const digests = treeDigests(dir)
    digestCache.set(dir, { stamp, digests })
    return digests
  }

  /** Compare a checkpoint with the working tree: same, or what drifted. */
  function checkpointState(meta, currentPath) {
    if (meta.project !== currentPath) return { other: true }
    if (!existsSync(meta.dir)) return { missing: true }
    const snapshot = join(checkpointsRoot(), meta.id, 'files')
    if (!existsSync(snapshot)) return { missing: true }
    const before = digestFor(snapshot)
    const after = digestFor(meta.dir)
    let changed = 0
    let added = 0
    let removed = 0
    for (const [rel, digest] of after) {
      if (!before.has(rel)) added += 1
      else if (before.get(rel) !== digest) changed += 1
    }
    for (const rel of before.keys()) if (!after.has(rel)) removed += 1
    return { same: changed === 0 && added === 0 && removed === 0, changed, added, removed }
  }

  function checkpointCreate({ project, label, guard } = {}) {
    const pinned = currentProject()
    const path = typeof project === 'string' && project.trim() !== '' ? project.trim() : pinned?.path
    if (path === undefined) throw new Error('No current project: select one first (board_project action "select").')
    const summary = projectSummary(path)
    if (!existsSync(summary.dir)) throw new Error(`Project directory is missing: ${summary.dir}`)
    const createdAt = new Date()
    const id = `${checkpointStamp(createdAt)}-${Math.random().toString(36).slice(2, 6)}`
    const dir = join(checkpointsRoot(), id)
    const copied = copyTree(summary.dir, join(dir, 'files'))
    const meta = {
      id,
      project: summary.path,
      name: summary.name,
      dir: summary.dir,
      env: pinned?.project === summary.path ? pinned.env : undefined,
      label: typeof label === 'string' && label.trim() !== '' ? label.trim().slice(0, 80) : undefined,
      guard: guard === true ? true : undefined,
      files: copied.files,
      bytes: copied.bytes,
      createdAt: createdAt.toISOString(),
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
    return meta
  }

  function checkpointRestore({ id } = {}) {
    const meta = readCheckpoint(id)
    if (!existsSync(meta.dir)) throw new Error(`Project directory is missing: ${meta.dir}`)
    const filesRoot = join(checkpointsRoot(), meta.id, 'files')
    if (!existsSync(filesRoot)) throw new Error(`Checkpoint ${meta.id} has no files: the snapshot is damaged.`)
    // Snapshot the "before" state first: the restore stays undoable.
    const guard = checkpointCreate({ project: meta.project, guard: true })
    const keep = treeFiles(filesRoot)
    dropExtraneous(meta.dir, '', keep)
    const copied = copyTree(filesRoot, meta.dir)
    return { ...meta, files: copied.files, restoredAt: new Date().toISOString(), guard: guard.id }
  }

  function checkpointDelete({ id } = {}) {
    const meta = readCheckpoint(id)
    rmSync(join(checkpointsRoot(), meta.id), { recursive: true, force: true })
    return meta
  }

  // ---------------------------------------------------------------- board maps
  // Pin tables live in the bundle (maps/*.json), one file per board, so a
  // board's layout travels with the plugin and stays editable in the repo.
  // Where the pins are wired is per machine and lives in .board-lab/wiring.json.
  function mapsDir() {
    return join(BUNDLE_DIR, 'maps')
  }

  /**
   * Pin tables shipped with the plugin, plus the ones composed on this machine.
   * A locally composed map with the same id wins: it is the newer truth.
   */
  function boardMaps() {
    const maps = []
    const seen = new Set()
    const addFrom = (dir) => {
      if (!existsSync(dir)) return
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json') || seen.has(name)) continue
        try {
          const map = JSON.parse(readFileSync(join(dir, name), 'utf8'))
          if (map !== null && typeof map === 'object' && typeof map.id === 'string') {
            maps.push(map)
            seen.add(name)
          }
        } catch {
          // A broken pin table must not take the panel down.
        }
      }
    }
    addFrom(join(stateRoot, 'maps'))
    addFrom(mapsDir())
    return maps.sort((left, right) => String(left.name ?? left.id).localeCompare(String(right.name ?? right.id)))
  }

  /** Write into the bundle (the repo) when it is writable, else next to the state. */
  function writeMapFile(slug, map) {
    const data = `${JSON.stringify(map, null, 2)}\n`
    const local = join(stateRoot, 'maps')
    for (const dir of [mapsDir(), local]) {
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${slug}.json`), data)
        // Only one copy may exist, or an older one would shadow the new one.
        const other = dir === local ? join(mapsDir(), `${slug}.json`) : join(local, `${slug}.json`)
        if (existsSync(other)) rmSync(other, { force: true })
        return join(dir, `${slug}.json`)
      } catch {
        // A read-only bundle is normal for an installed package: fall through.
      }
    }
    throw new Error('Cannot write the board map: neither maps/ nor .board-lab/maps is writable.')
  }

  /**
   * A map for a board nobody drew yet: the four shipped tables are not a closed
   * list, and the panel needs a way to add its own.
   */
  function createBlankMap({ id, name, board } = {}) {
    const wanted = String(id ?? '').trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9._-]{0,48}$/.test(wanted)) {
      throw new Error('A board map id is lowercase letters, digits, dot, dash or underscore, e.g. "nano-v3".')
    }
    if (findMap(wanted) !== undefined) throw new Error(`Board map "${wanted}" already exists.`)
    const alias = String(board ?? wanted).trim() || wanted
    const label = String(name ?? '').trim() || wanted
    const map = {
      id: wanted,
      name: label.slice(0, 60),
      board: [alias],
      verified: false,
      sides: {},
      pads: [],
      note: 'Пустая таблица: ножки добавит агент или форма в панели.',
    }
    writeMapFile(wanted, map)
    return map
  }

  function findMap(id) {
    if (typeof id !== 'string' || id === '') return undefined
    return boardMaps().find((map) => map.id === id)
  }

  /** Guess the board map from a PlatformIO board id, e.g. "esp32-s3-devkitc-1". */
  function matchMap(board) {
    const wanted = typeof board === 'string' ? board.toLowerCase() : ''
    if (wanted === '') return undefined
    const maps = boardMaps()
    for (const map of maps) {
      if (map.id.toLowerCase() === wanted) return map
    }
    for (const map of maps) {
      for (const alias of Array.isArray(map.board) ? map.board : []) {
        if (typeof alias === 'string' && wanted.includes(alias.toLowerCase())) return map
      }
    }
    return undefined
  }

  function wiringFile() {
    return join(stateRoot, 'wiring.json')
  }

  function readWiringFile() {
    const file = wiringFile()
    if (!existsSync(file)) return {}
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function writeWiringFile(all) {
    mkdirSync(stateRoot, { recursive: true })
    const tmp = `${wiringFile()}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`)
    renameSync(tmp, wiringFile())
  }

  /**
   * A pasted datasheet table → pin rows. Every vendor lays the columns out
   * differently, but they all start with a physical pin number in one column,
   * then the pin name, then the functions. So: find the column that is mostly
   * numbers, take the cell after it as the name, and keep the cells after that
   * as functions — minus the type/level columns (I/O, FT, S, "3.6V"), which are
   * never functions. Bare names, one per line, still work.
   */
  const NOT_A_FUNCTION = new Set(['I/O', 'I', 'O', 'S', 'FT', 'FTa', 'TC', 'FTF', '-', ''])
  function parsePinRows(text) {
    const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
    const table = lines.map((line) => line.split(/\t|\s{2,}/).map((cell) => cell.trim()))
    const numeric = (cell) => /^\d{1,3}$/.test(cell ?? '') && Number(cell) >= 1 && Number(cell) <= 256
    let numberColumn = -1
    let best = 0
    for (let column = 0; column < 4; column += 1) {
      const hits = table.filter((cells) => numeric(cells[column])).length
      if (hits > best) {
        best = hits
        numberColumn = column
      }
    }
    const rows = []
    if (best >= Math.max(2, Math.ceil(table.length * 0.4))) {
      for (const cells of table) {
        if (!numeric(cells[numberColumn])) continue
        const name = String(cells[numberColumn + 1] ?? '').split(/[ ,/]/)[0]
        if (!/^[A-Za-z0-9_+./-]{1,18}$/.test(name)) continue
        const func = []
        for (const cell of cells.slice(numberColumn + 2)) {
          // Prose sits in its own wide cell ("Battery supply for RTC") and is
          // never a function list; a list is comma/space separated capitals.
          if (/\s/.test(cell) && !/[,;]/.test(cell)) continue
          for (const token of cell.split(/[,;]+|\s+/)) {
            if (token === '' || NOT_A_FUNCTION.has(token) || /^\d+(\.\d+)?V?$/.test(token)) continue
            if (!/^[A-Z][A-Z0-9_+./-]{0,19}$/.test(token)) continue
            if (token !== name && !func.includes(token)) func.push(token)
          }
        }
        rows.push({ number: Number(cells[numberColumn]), name, func })
      }
    }
    if (rows.length === 0) {
      // No table: a plain list of names, one per line, is still a pin table.
      for (const line of lines) {
        const name = line.split(/[\s,;]+/)[0]
        if (!/^[A-Za-z0-9_+./-]{1,18}$/.test(name)) continue
        rows.push({ number: rows.length + 1, name, func: [] })
      }
      return rows
    }
    rows.sort((left, right) => left.number - right.number)
    const seen = new Set()
    const unique = rows.filter((row) => {
      if (seen.has(row.number)) return false
      seen.add(row.number)
      return true
    })
    const broken = unique.findIndex((row) => row.number !== unique.indexOf(row) + 1)
    if (unique.length > 0 && broken !== -1) {
      throw new Error(`the table jumps: pin ${unique[broken].number} is in row ${broken + 1}, so a pin is missing before it — paste one package column, not two.`)
    }
    return unique
  }

  /** Alternative functions of one pin: trimmed, deduped, short enough for a label. */
  function funcList(value) {
    if (!Array.isArray(value)) return undefined
    const out = []
    for (const item of value) {
      const text = String(item ?? '').trim().replace(/\s+/g, '_').slice(0, 28)
      if (text === '' || out.includes(text)) continue
      out.push(text)
      if (out.length >= 12) break
    }
    return out.length === 0 ? undefined : out
  }

  /**
   * Pins of a map in physical order. A chip map carries `pins` (index 0 is pin
   * 1) and is keyed by the pin number; a board map carries `sides` and is keyed
   * by the pin name. `name` is what the pin is called, `key` is what wiring.json
   * stores.
   */
  function pinEntries(map) {
    if (map === undefined) return []
    if (Array.isArray(map.pins) && map.pins.length > 0) {
      return map.pins.map((entry, index) => {
        const name = typeof entry === 'string' ? entry : String(entry?.name ?? '')
        const func = Array.isArray(entry?.func) ? entry.func.map(String) : undefined
        return func === undefined
          ? { key: String(index + 1), name, number: index + 1 }
          : { key: String(index + 1), name, number: index + 1, func }
      })
    }
    const sides = map.sides !== null && typeof map.sides === 'object' ? map.sides : {}
    const out = []
    for (const side of ['top', 'bottom', 'left', 'right']) {
      for (const entry of Array.isArray(sides[side]) ? sides[side] : []) {
        const name = typeof entry === 'string' ? entry : entry?.pin
        if (typeof name === 'string' && !out.some((pin) => pin.key === name)) out.push({ key: name, name })
      }
    }
    return out
  }

  function pinList(map) {
    return pinEntries(map).map((pin) => pin.key)
  }

  /** The key wiring.json uses for a pin the user or an agent named. */
  function pinKeyOf(map, wanted) {
    const entries = pinEntries(map)
    const direct = entries.find((pin) => pin.key === wanted)
    if (direct !== undefined) return direct.key
    const named = entries.filter((pin) => pin.name.toLowerCase() === String(wanted).toLowerCase())
    if (named.length === 1) return named[0].key
    if (named.length > 1) {
      throw new Error(`"${wanted}" sits on ${named.length} pins of ${map.name} (${named.map((pin) => pin.key).join(', ')}): pass the pin number instead.`)
    }
    return undefined
  }

  /** Wired pins in layout order, with the human name next to the key. */
  function pinReport(map, source) {
    const order = new Map(pinEntries(map).map((pin, index) => [pin.key, { index, name: pin.name, func: pin.func }]))
    const rank = (pin) => order.get(pin)?.index ?? 1e6
    return Object.entries(source !== null && typeof source === 'object' ? source : {})
      .map(([pin, entry]) => {
        const meta = order.get(pin)
        const out = {
          pin,
          name: meta?.name ?? pin,
          label: typeof entry?.label === 'string' ? entry.label : String(entry),
          source: entry?.source,
        }
        if (meta?.func !== undefined) out.func = meta.func
        return out
      })
      .sort((left, right) => rank(left.pin) - rank(right.pin))
  }

  /** The board a project targets, as PlatformIO spells it (env.board). */
  function projectBoard(summary) {
    if (summary === undefined || !Array.isArray(summary.envs) || summary.envs.length === 0) return undefined
    return summary.envs.find((env) => env.default === true)?.board ?? summary.envs[0]?.board
  }

  function wiringGet({ project } = {}) {
    const pinned = currentProject()
    const path = typeof project === 'string' && project.trim() !== '' ? project.trim() : pinned?.path
    const summary = path === undefined ? undefined : projectSummary(path)
    const all = readWiringFile()
    const saved = summary === undefined ? undefined : all[summary.path]
    const map = findMap(saved?.board) ?? matchMap(projectBoard(summary))
    const known = pinList(map)
    const pins = {}
    for (const [pin, entry] of Object.entries(saved?.pins !== null && typeof saved?.pins === 'object' ? saved.pins : {})) {
      // A pin that the chosen map does not have is kept in the file, not shown.
      if (known.length === 0) {
        pins[pin] = entry
        continue
      }
      let key
      try {
        key = pinKeyOf(map, pin)
      } catch {
        key = undefined
      }
      if (key !== undefined) pins[key] = entry
    }
    return {
      project: summary?.path,
      board: map?.id,
      map,
      maps: boardMaps().map((item) => ({ id: item.id, name: item.name, verified: item.verified !== false })),
      pins,
    }
  }

  function wiringSet({ project, board, pin, label } = {}) {
    if (typeof board !== 'string' || board === '') throw new Error('wiring needs the "board" map id.')
    if (typeof pin !== 'string' || pin === '') throw new Error('wiring needs the "pin" name.')
    const map = findMap(board)
    if (map === undefined) throw new Error(`Unknown board map "${board}": run board_maps to see them.`)
    const key = pinKeyOf(map, pin)
    if (key === undefined) throw new Error(`${map.name} has no pin "${pin}".`)
    const pinned = currentProject()
    const path = typeof project === 'string' && project.trim() !== '' ? project.trim() : pinned?.path
    if (path === undefined) throw new Error('No current project: select one first (board_project action "select").')
    const summary = projectSummary(path)
    const all = readWiringFile()
    const entry = all[summary.path] ?? { board: map.id, pins: {} }
    entry.board = map.id
    entry.pins = entry.pins !== null && typeof entry.pins === 'object' ? entry.pins : {}
    const text = typeof label === 'string' ? label.trim().slice(0, 60) : ''
    if (text === '') delete entry.pins[key]
    else entry.pins[key] = { label: text, source: 'manual', at: new Date().toISOString() }
    all[summary.path] = entry
    writeWiringFile(all)
    return wiringGet({ project: summary.path })
  }

  // ------------------------------------------------------------------ commands
  // The quick buttons send text to the board, and a sensor sketch and a motor
  // sketch talk differently: the set belongs to the project, not to the plugin.
  const DEFAULT_COMMANDS = ['PING', 'HELLO', 'VERSION', 'MODE 1', 'MODE 2']

  function commandsFile() {
    return join(stateRoot, 'commands.json')
  }

  function readCommandsAll() {
    const file = commandsFile()
    if (!existsSync(file)) return {}
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  function commandsProject(project) {
    return typeof project === 'string' && project.trim() !== '' ? project.trim() : currentProject()?.path
  }

  function commandsGet({ project } = {}) {
    const path = commandsProject(project)
    const saved = path === undefined ? undefined : readCommandsAll()[path]
    if (!Array.isArray(saved) || saved.length === 0) {
      return { project: path, commands: DEFAULT_COMMANDS.slice(), defaults: true }
    }
    return { project: path, commands: saved, defaults: false }
  }

  function commandsSet({ project, commands } = {}) {
    const path = commandsProject(project)
    if (path === undefined) throw new Error('No current project: select one first (board_project action "select").')
    if (!Array.isArray(commands)) throw new Error('`commands` must be an array of strings.')
    const clean = []
    for (const item of commands) {
      if (typeof item !== 'string') throw new Error('`commands` must be an array of strings.')
      const text = item.replace(/[\r\n]+/g, ' ').trim().slice(0, 32)
      if (text === '' || clean.includes(text)) continue
      clean.push(text)
      if (clean.length >= 12) break
    }
    const all = readCommandsAll()
    all[path] = clean
    mkdirSync(stateRoot, { recursive: true })
    const tmp = `${commandsFile()}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`)
    renameSync(tmp, commandsFile())
    return { project: path, commands: clean, defaults: false }
  }

  function wiringBoard({ project, board } = {}) {
    const map = findMap(board)
    if (map === undefined) throw new Error(`Unknown board map "${String(board)}": run board_maps to see them.`)
    const pinned = currentProject()
    const path = typeof project === 'string' && project.trim() !== '' ? project.trim() : pinned?.path
    if (path === undefined) throw new Error('No current project: select one first (board_project action "select").')
    const summary = projectSummary(path)
    const all = readWiringFile()
    const entry = all[summary.path] ?? { board: map.id, pins: {} }
    entry.board = map.id
    all[summary.path] = entry
    writeWiringFile(all)
    return wiringGet({ project: summary.path })
  }

  /**
   * Compose a board map in place — a chip from a datasheet pin table, a board
   * from its two headers, or a sketch. Written into maps/<id>.json, so the layout
   * lands in the repository and the next clone already has it.
   */
  function saveMap({ id, name, aliases, sides, note, verified, pads, draw, package: pkg, pins, funcs } = {}) {
    const slug = String(id ?? '').trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9._-]{0,48}$/.test(slug)) {
      throw new Error('A board map id is lowercase letters, digits, dot, dash or underscore, e.g. "nano-v3".')
    }
    // A chip: pin names in physical order, index 0 is pin 1. No coordinates —
    // the package kind says how the outline is cut into sides. `funcs` adds what
    // a pin can do (USART1_TX, TIM1_CH2) by pin number; a hand-written JSON may
    // also carry {name, func} objects instead of bare names.
    const chipPins = []
    for (const entry of Array.isArray(pins) ? pins : []) {
      const pin = typeof entry === 'string' ? entry.trim() : String(entry?.name ?? '').trim()
      if (pin === '') continue
      if (!/^[A-Za-z0-9_+./-]{1,18}$/.test(pin)) {
        throw new Error(`"${pin}" is not a pin name: letters, digits, _ + . / - up to 18 characters.`)
      }
      const funcs = funcList(entry?.func)
      chipPins.push(funcs === undefined ? pin : { name: pin, func: funcs })
    }
    for (const [number, list] of Object.entries(funcs !== null && typeof funcs === 'object' ? funcs : {})) {
      const index = Number(number) - 1
      if (!Number.isInteger(index) || index < 0 || index >= chipPins.length) {
        throw new Error(`funcs has "${number}" but the chip has ${chipPins.length} pins (1…${chipPins.length}).`)
      }
      const cleaned = funcList(list)
      if (cleaned === undefined) continue
      const name = typeof chipPins[index] === 'string' ? chipPins[index] : chipPins[index].name
      chipPins[index] = { name, func: cleaned }
    }
    const QUAD = ['qfp', 'qfn']
    const DUAL = ['dip', 'soic', 'tssop']
    const kind = String(pkg?.kind ?? '').trim().toLowerCase()
    if (chipPins.length > 0) {
      if (![...QUAD, ...DUAL].includes(kind)) {
        throw new Error('A chip map needs package.kind: qfp, qfn, dip, soic or tssop.')
      }
      const sidesCount = QUAD.includes(kind) ? 4 : 2
      if (chipPins.length < sidesCount * 2 || chipPins.length % sidesCount !== 0) {
        throw new Error(`${kind.toUpperCase()} with ${chipPins.length} pins is not a real package: the count must be a multiple of ${sidesCount} and at least ${sidesCount * 2}.`)
      }
    }
    const clean = {}
    for (const side of ['top', 'bottom', 'left', 'right']) {
      const list = Array.isArray(sides?.[side]) ? sides[side] : []
      const pins = []
      for (const entry of list) {
        const pin = String(entry ?? '').trim()
        if (pin === '') continue
        if (!/^[A-Za-z0-9_+./-]{1,18}$/.test(pin)) {
          throw new Error(`"${pin}" is not a pin name: letters, digits, _ + . / - up to 18 characters.`)
        }
        // Positional repeats are legitimate pins: two 3V3 and three GND on the
        // ESP32-S3-DevKitC-1 headers. Dropping them shifts every later pad.
        pins.push(pin)
      }
      if (pins.length > 0) clean[side] = pins
    }
    const total = Object.values(clean).reduce((sum, list) => sum + list.length, 0)
    if (chipPins.length === 0 && total < 2) {
      throw new Error('A board map needs pins: pass at least two names in sides.left/right/top/bottom, or `pins` with a `package` for a chip.')
    }
    const listFrom = (value) => {
      if (Array.isArray(value)) return value.map((item) => String(item).trim().toLowerCase()).filter((item) => item !== '')
      if (typeof value === 'string') return value.split(',').map((item) => item.trim().toLowerCase()).filter((item) => item !== '')
      return []
    }
    const map = {
      id: slug,
      name: typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 60) : slug,
      board: listFrom(aliases).length === 0 ? [slug] : listFrom(aliases),
      verified: verified !== false,
    }
    if (chipPins.length > 0) {
      map.package = { kind }
      map.pins = chipPins
    }
    if (total > 0) map.sides = clean
    const trimmed = typeof note === 'string' ? note.trim().slice(0, 240) : ''
    if (trimmed !== '') map.note = trimmed
    const known = chipPins.length > 0
      ? new Set(chipPins.map((_, index) => String(index + 1)))
      : new Set(Object.values(clean).flat())
    const placed = []
    for (const entry of Array.isArray(pads) ? pads : []) {
      const pin = String(entry?.pin ?? '').trim()
      const x = Number(entry?.x)
      const y = Number(entry?.y)
      if (pin === '' || !known.has(pin)) throw new Error(`Pad "${pin}" is not a pin of this map: place only pins from sides.`)
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        throw new Error(`Pad "${pin}" needs x and y between 0 and 1 (a share of the drawing).`)
      }
      placed.push({ pin, x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 })
    }
    if (placed.length > 0) map.pads = placed
    const shapes = []
    const share = (value) => Math.round(Number(value) * 10000) / 10000
    for (const entry of Array.isArray(draw) ? draw : []) {
      const type = String(entry?.type ?? '').trim()
      const x = Number(entry?.x)
      const y = Number(entry?.y)
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        throw new Error('Every draw shape needs x and y as shares of the drawing, 0 (top/left) to 1 (bottom/right).')
      }
      if (type === 'rect') {
        const w = Number(entry?.w)
        const hgt = Number(entry?.h)
        if (!Number.isFinite(w) || !Number.isFinite(hgt) || w <= 0 || hgt <= 0 || x + w > 1.002 || y + hgt > 1.002) {
          throw new Error('A draw rect needs w and h greater than 0, and x+w, y+h must stay inside 1.')
        }
        const shape = { type: 'rect', x: share(x), y: share(y), w: share(w), h: share(hgt) }
        if (['board', 'chip', 'metal', 'accent', 'hole'].includes(String(entry?.fill ?? ''))) shape.fill = String(entry.fill)
        const label = typeof entry?.label === 'string' ? entry.label.trim().slice(0, 40) : ''
        if (label !== '') shape.label = label
        shapes.push(shape)
        continue
      }
      if (type === 'text') {
        const content = typeof entry?.text === 'string' ? entry.text.trim().slice(0, 40) : ''
        if (content === '') throw new Error('A draw text shape needs "text".')
        const shape = { type: 'text', x: share(x), y: share(y), text: content }
        const size = Number(entry?.size)
        if (Number.isFinite(size) && size >= 4 && size <= 40) shape.size = Math.round(size)
        if (['board', 'chip', 'metal', 'accent', 'hole'].includes(String(entry?.fill ?? ''))) shape.fill = String(entry.fill)
        shapes.push(shape)
        continue
      }
      throw new Error(`Unknown draw shape "${type}": use "rect" or "text".`)
    }
    if (shapes.length > 0) map.draw = shapes.slice(0, 400)
    writeMapFile(slug, map)
    return map
  }

  /** `#define DIO 4` and friends: turn numeric constants into pin suggestions. */
  function wiringDraft({ project, board } = {}) {
    const pinned = currentProject()
    const path = typeof project === 'string' && project.trim() !== '' ? project.trim() : pinned?.path
    if (path === undefined) throw new Error('No current project: select one first (board_project action "select").')
    const summary = projectSummary(path)
    const map = findMap(board) ?? findMap(readWiringFile()[summary.path]?.board) ?? matchMap(projectBoard(summary))
    const byNumber = new Map()
    const byPort = new Map()
    for (const pin of pinEntries(map)) {
      const port = /^P([A-K])(\d{1,2})$/.exec(pin.name)
      if (port !== null) {
        byPort.set(`${port[1]}${port[2]}`, pin.key)
        continue
      }
      const digits = /(\d+)$/.exec(pin.name)
      if (digits !== null && !byNumber.has(Number(digits[1]))) byNumber.set(Number(digits[1]), pin.key)
    }
    const found = []
    const seen = new Set()
    const skippedNames = /^(GND|VCC|VIN|3V3|5V|AREF|RESET|RST|NRST|IOREF|VBAT)$/i
    const files = []
    const walk = (dir, depth) => {
      if (depth > 4 || !existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || CHECKPOINT_SKIP.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full, depth + 1)
        else if (/\.(c|cc|cpp|cxx|h|hpp|ino|py)$/i.test(entry.name)) files.push(full)
      }
    }
    walk(summary.dir, 0)
    const numeric = [
      /#define\s+([A-Za-z_]\w*)\s+(\d+)\b/g,
      /(?:const|constexpr)\s+(?:int|uint8_t|uint16_t|byte|unsigned)\s+([A-Za-z_]\w*)\s*=\s*(\d+)\b/g,
    ]
    const ported = /#define\s+([A-Za-z_]\w*)\s+(P[A-K]\d{1,2})\b/g
    const note = (pin, label) => {
      if (pin === undefined || seen.has(pin) || skippedNames.test(label)) return
      seen.add(pin)
      found.push({ pin, label })
    }
    for (const file of files) {
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const pattern of numeric) {
        pattern.lastIndex = 0
        for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
          note(byNumber.get(Number(match[2])), match[1])
        }
      }
      ported.lastIndex = 0
      for (let match = ported.exec(text); match !== null; match = ported.exec(text)) {
        note(byPort.get(match[2].slice(1)), match[1])
      }
    }
    const all = readWiringFile()
    const entry = all[summary.path] ?? { board: map?.id, pins: {} }
    if (map !== undefined) entry.board = map.id
    entry.pins = entry.pins !== null && typeof entry.pins === 'object' ? entry.pins : {}
    let applied = 0
    for (const item of found) {
      if (entry.pins[item.pin] !== undefined) continue
      entry.pins[item.pin] = { label: item.label, source: 'code', at: new Date().toISOString() }
      applied += 1
    }
    all[summary.path] = entry
    writeWiringFile(all)
    return { applied, skipped: found.length - applied, project: summary.path, ...wiringGet({ project: summary.path }) }
  }

  /** Open a project folder (or its lib/ or src/) in the desktop file manager. */
  function openFolder({ project, target = 'root' } = {}) {
    const current = project === undefined ? currentProject() : projectSummary(project)
    if (current === undefined) throw new Error('No current project yet: select one first (board_project action "select").')
    const path = target === 'root' ? current.dir : join(current.dir, target)
    if (path !== current.dir && !path.startsWith(projectsRoot)) {
      throw new Error(`Refusing to open ${path}: it is outside ${projectsRoot}.`)
    }
    if (target !== 'root' && !existsSync(path)) {
      if (target === 'lib') mkdirSync(path, { recursive: true })
      else throw new Error(`${projectLabel(current.dir)} has no ${target}/ folder yet.`)
    }
    const opener = isWindows
      ? (existsSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'))
          ? join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe')
          : 'explorer')
      : process.platform === 'darwin'
        ? 'open'
        : hasCommand('xdg-open') ? 'xdg-open' : undefined
    if (opener === undefined) throw new Error('No file manager launcher found: install xdg-open.')
    const child = spawn(opener, [path], { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', () => {})
    child.unref()
    return { path, target, opener }
  }

  /** Newest ELF under `.pio/build/<env>` or `build`, preferring the named env. */
  function findElf(dir, env) {
    const found = []
    const walk = (root) => {
      if (!existsSync(root)) return
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const full = join(root, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.elf')) found.push(full)
      }
    }
    if (projectKind(dir) === 'pio') {
      const buildRoot = join(dir, '.pio', 'build')
      if (typeof env === 'string' && env !== '' && existsSync(join(buildRoot, env, 'firmware.elf'))) {
        const file = join(buildRoot, env, 'firmware.elf')
        return { path: file, modified: statSync(file).mtime }
      }
      walk(buildRoot)
    } else {
      walk(join(dir, 'build'))
    }
    if (found.length === 0) return undefined
    found.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    return { path: found[0], modified: statSync(found[0]).mtime }
  }

  /** The addr2line binary that matches the chip family of the project. */
  function addr2lineBinary(family) {
    const packages = join(toolchainDir, 'pio', 'packages')
    const choice = family === 'riscv32'
      ? ['toolchain-riscv32-esp', 'riscv32-esp-elf-addr2line']
      : family === 'esp32'
        ? ['toolchain-xtensa-esp-elf', 'xtensa-esp32-elf-addr2line']
        : family === 'esp32s2'
          ? ['toolchain-xtensa-esp-elf', 'xtensa-esp32s2-elf-addr2line']
          : ['toolchain-xtensa-esp-elf', 'xtensa-esp32s3-elf-addr2line']
    const binary = join(packages, choice[0], 'bin', choice[1])
    return existsSync(binary) ? binary : undefined
  }

  const PANIC_SIGNATURES = /Guru Meditation Error|abort\(\) was called|assert failed|Stack canary watchpoint|Task watchdog got triggered|Backtrace:/

  /** Pull the exception, core and program counters out of an ESP32 panic dump. */
  function parsePanic(text) {
    const source = String(text ?? '')
    const addresses = []
    const seen = new Set()
    const add = (value) => {
      const address = String(value ?? '').toLowerCase().replace(/^0x/, '')
      if (!/^[0-9a-f]{4,16}$/.test(address) || seen.has(address)) return
      seen.add(address)
      addresses.push(`0x${address}`)
    }
    const guru = /Guru Meditation Error:\s*Core\s+(\d+)\s+panic'ed\s*\(([^)]+)\)/.exec(source)
    const abort = /abort\(\) was called at PC\s+0x([0-9a-fA-F]+)(?:\s+on core\s+(\d+))?/.exec(source)
    if (abort !== null) add(abort[1])
    const pc = /^\s*PC\s*:\s*0x([0-9a-fA-F]+)/m.exec(source)
    if (pc !== null && (guru !== null || abort !== null)) add(pc[1])
    const backtrace = /Backtrace:\s*([^\n]+)/.exec(source)
    if (backtrace !== null) for (const token of backtrace[1].match(/0x[0-9a-fA-F]+/g) ?? []) add(token)
    const mepc = /^\s*MEPC\s*:\s*0x([0-9a-fA-F]+)/m.exec(source)
    if (mepc !== null) add(mepc[1])
    return {
      panic: PANIC_SIGNATURES.test(source),
      exception: guru?.[2],
      core: guru !== null ? Number(guru[1]) : abort?.[2] !== undefined ? Number(abort[2]) : undefined,
      addresses,
    }
  }

  /** Keep stack-trace paths readable: project-relative first, then the last segments. */
  function shortenFile(file, dir) {
    if (typeof file !== 'string' || file === '' || file === '??') return undefined
    if (file.startsWith(`${dir}/`)) return file.slice(dir.length + 1)
    const parts = file.split('/').filter(Boolean)
    return parts.slice(-3).join('/')
  }

  /** Resolve panic addresses against the ELF the project last built. */
  async function decodeText({ project, env, text, port, elf: elfOverride }) {
    const panic = parsePanic(text)
    if (panic.panic !== true && panic.addresses.length === 0) {
      throw new Error('No panic in the text: expected "Guru Meditation Error", "abort() was called", "assert failed" or a "Backtrace:" line.')
    }
    let dir
    if (typeof project === 'string' && project.trim() !== '') {
      dir = projectDir(project)
    } else {
      const resolved = port === undefined ? undefined : await resolveProjectForPort(port, { probe: false })
      if (resolved === undefined) {
        throw new Error('Cannot find the ELF for this panic: pass `project`, or flash this board through board-lab once so the project is remembered.')
      }
      dir = resolved.dir
      env = env ?? resolved.env
    }
    if (projectKind(dir) === 'make') {
      throw new Error('AT32 panic decoding is not implemented: the ARM ELF cannot be symbolized from a UART dump alone. Use a probe-based debug session.')
    }
    const envs = pioEnvs(dir)
    const chosenEnv = env ?? envs.find((entry) => entry.default)?.name ?? envs[0]?.name
    const found = findElf(dir, chosenEnv)
    if (found === undefined) throw new Error(`No .elf under ${dir}: build the project first (board_build).`)
    const elfPath = typeof elfOverride === 'string' && elfOverride !== ''
      ? (isAbsolute(elfOverride) ? elfOverride : resolvePath(baseDir, elfOverride))
      : found.path
    const family = chipFamilyFromBoard(envs.find((entry) => entry.name === chosenEnv)?.board)
      ?? chipFamilyFromBoard(envs.find((entry) => entry.default)?.board)
    const binary = addr2lineBinary(family)
    if (binary === undefined) throw new Error(`No addr2line for ${family ?? 'this chip'}: install the PlatformIO toolchain with \`board_tools\` action \`install\` id \`armgcc\`.` )
    if (panic.addresses.length === 0) {
      throw new Error('Panic found, but no addresses in it: the log was cut before "Backtrace:". Paste a longer log or enable core dumps.')
    }
    const result = await runProcess(binary, ['-pfiaC', '-e', elfPath, ...panic.addresses.slice(0, 40)], { timeoutMs: 30_000 })
    const frames = []
    for (const raw of result.stdout.split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '') continue
      const inline = /^\(inlined by\)\s+(.+?)\s+at\s+(.+?)(?::(\d+|\?\?))?$/.exec(line)
      if (inline !== null) {
        const file = shortenFile(inline[2], dir) ?? inline[2]
        frames.push(`(inlined) ${inline[1]} at ${file}${inline[3] !== undefined && inline[3] !== '??' ? `:${inline[3]}` : ''}`)
        continue
      }
      const frame = /^(0x[0-9a-fA-F]+):\s+(.+?)\s+at\s+(.+?)(?::(\d+|\?\?))?$/.exec(line)
      if (frame !== null) {
        const file = shortenFile(frame[3], dir) ?? frame[3]
        frames.push(`${frame[1].toLowerCase()} ${frame[2]} at ${file}${frame[4] !== undefined && frame[4] !== '??' ? `:${frame[4]}` : ''}`)
        continue
      }
      frames.push(line)
    }
    const primary = frames.find((entry) => entry.includes(' at ')) ?? frames[0]
    const summary = `${panic.exception ?? 'panic'}${panic.core !== undefined ? ` on core ${panic.core}` : ''}${primary !== undefined ? ` — ${primary}` : ''}`
    return {
      ok: true,
      summary,
      elf: elfPath.startsWith(`${baseDir}/`) ? elfPath.slice(baseDir.length + 1) : elfPath,
      elfModified: found.modified.toISOString(),
      exception: panic.exception,
      core: panic.core,
      frames,
      output: result.stdout.trim(),
    }
  }

  // -------------------------------------------------------------- board memory
  // Flashing through board-lab remembers which project belongs to which USB
  // serial, so a later session can flash that board without naming the project.

  const boardsFile = join(stateRoot, 'boards.json')

  function readBoards() {
    try {
      const parsed = JSON.parse(readFileSync(boardsFile, 'utf8'))
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  function rememberBoard(key, value) {
    if (typeof key !== 'string' || key === '') return
    try {
      mkdirSync(stateRoot, { recursive: true })
      const boards = readBoards()
      boards[key] = { ...value, seenAt: new Date().toISOString() }
      writeFileSync(boardsFile, JSON.stringify(boards, null, 2))
    } catch {
      // The cache is best effort; flashing must not fail because of it.
    }
  }

  function boardCacheKey(port) {
    if (port === undefined || port === null) return undefined
    if (typeof port.byId === 'string' && port.byId !== '') return port.byId
    if (typeof port.vendorId === 'string' && typeof port.productId === 'string') return `${port.vendorId}:${port.productId}`
    return undefined
  }

  // ------------------------------------------------------------- monitor layer
  // One detached monitor per port owns the serial device. It appends to a log
  // file and accepts writes over a loopback TCP socket (works on Linux and
  // Windows, no AF_UNIX path limit), so the agent reads incrementally and talks
  // to the running firmware without reopening the port.

  const monitorFile = (port, suffix) =>
    join(stateRoot, `monitor-${port.replace(/[^a-zA-Z0-9._-]+/g, '_')}.${suffix}`)

  const monitorPaths = (port) => ({
    log: monitorFile(port, 'log'),
    state: monitorFile(port, 'json'),
    offsets: join(stateRoot, 'offsets.json'),
  })

  /** Current size of the monitor log, 0 when nothing was captured yet. */
  function logSize(port) {
    const paths = monitorPaths(port)
    return existsSync(paths.log) ? statSync(paths.log).size : 0
  }

  function readJson(path) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return undefined
    }
  }

  function removeQuietly(path) {
    try {
      unlinkSync(path)
    } catch {
      // already gone
    }
  }

  // Tool results are validated against their declared schema and must survive a
  // JSON round trip: `undefined` and `null` are neither lossless nor typeable by
  // the schemas below, so they are dropped instead of leaking into a result.
  function compact(value) {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined && item !== null) out[key] = item
    }
    return out
  }

  /**
   * True when pid is a live `monitor.py`, not merely a live process. The host
   * layer knows the platform: /proc on Linux, an existence probe on Windows.
   */
  function pidAlive(pid) {
    return hostPidAlive(pid)
  }

  function monitorState(port) {
    const paths = monitorPaths(port)
    const state = readJson(paths.state)
    if (state === undefined) return undefined
    const processAlive = pidAlive(state.pid)
    const socketPresent = Number.isInteger(state.tcpPort)
    const running = processAlive && socketPresent
    // A state file that outlives its process (crash, kill -9, reboot) must never
    // be reported as a running monitor: that is what made `status` lie and
    // `read` answer "(no new output)" for a port that was actually dead.
    return { ...state, processAlive, socketPresent, running, stale: !running }
  }

  function listMonitors() {
    if (!existsSync(stateRoot)) return []
    return readdirSync(stateRoot)
      .filter((name) => name.endsWith('.json') && name.startsWith('monitor-'))
      .map((name) => {
        const raw = readJson(join(stateRoot, name))
        if (raw?.port === undefined) return undefined
        const state = monitorState(raw.port)
        if (state === undefined) return undefined
        return compact({
          port: state.port,
          baud: state.baud,
          running: state.running,
          stale: state.stale,
          open: state.open === true,
          error: state.error ?? undefined,
        })
      })
      .filter(Boolean)
  }

  /** Poll until the pid is gone; false means it survived the whole window. */
  async function waitForExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return true
      await sleep(100)
    }
    return !pidAlive(pid)
  }

  /**
   * Stop the monitor for one port. Graceful first (the monitor closes its own
   * TCP socket and the serial port), then SIGTERM/taskkill, then SIGKILL; a survivor is an error because the
   * port would stay held and the next flash would fail with a misleading
   * "permission denied".
   */
  async function stopMonitor(port) {
    const paths = monitorPaths(port)
    const state = monitorState(port)
    if (state === undefined) return false
    if (!state.processAlive) {
      // Nothing to stop: drop the leftover bookkeeping so `status` is honest.
      removeQuietly(paths.state)
      return false
    }
    try {
      await monitorCommand(port, { cmd: 'stop' }, 1500)
    } catch {
      // The socket may already be gone; signals below still stop the process.
    }
    if (await waitForExit(state.pid, 3000)) {
      removeQuietly(paths.state)
      return true
    }
    killTree(state.pid, false)
    if (await waitForExit(state.pid, 2000)) {
      removeQuietly(paths.state)
      return true
    }
    killTree(state.pid, true)
    if (await waitForExit(state.pid, 2000)) {
      removeQuietly(paths.state)
      return true
    }
    throw new Error(
      `monitor for ${port} (pid ${state.pid}) did not exit; the serial port is still held`,
    )
  }

  /**
   * Start (or reuse) the monitor for one port and wait until it owns the port.
   * A monitor that cannot open the device is stopped again: leaving it alive
   * would hold a retry loop nobody asked for and make the next start look busy.
   */
  async function startMonitor({ port, baud, reset = 'esp' }) {
    const chosenPort = port || selectPort(undefined)
    const chosenBaud = Number.isInteger(baud) ? baud : settings.defaultBaud
    const paths = monitorPaths(chosenPort)
    const existing = monitorState(chosenPort)
    if (existing?.running === true) {
      const open = existing.open === true
      return compact({
        port: chosenPort,
        baud: chosenBaud ?? existing.baud,
        running: true,
        open,
        log: paths.log,
        startedAt: existing.startedAt,
        error: open ? undefined : (existing.error ?? `serial port ${chosenPort} is not open`),
        reused: true,
      })
    }
    // A stale state file must not be mistaken for a live monitor: clear it so a
    // fresh process owns the port and `status` reports the restart.
    if (existing !== undefined && !existing.processAlive) {
      removeQuietly(paths.state)
    }
    mkdirSync(stateRoot, { recursive: true })
    // A reset wipes the context of every byte already in the log: remember the
    // size before the monitor can append anything, so the next read starts at
    // the boot banner instead of replaying the previous firmware's output.
    const baselineBytes = reset === 'esp' && existsSync(paths.log) ? statSync(paths.log).size : 0
    let spawnError
    let exitCode
    const child = spawn(pythonCommand().command, [
      join(BUNDLE_DIR, 'monitor.py'),
      '--port', chosenPort,
      '--baud', String(chosenBaud),
      '--log', paths.log,
      '--state', paths.state,
      '--reset', reset,
    ], {
      cwd: baseDir,
      env: pythonEnv(),
      detached: !isWindows,
      windowsHide: true,
      stdio: 'ignore',
    })
    child.on('error', (error) => { spawnError = error })
    child.on('exit', (code) => { exitCode = code })
    child.unref()

    const deadline = Date.now() + 8000
    let state
    while (Date.now() < deadline) {
      state = monitorState(chosenPort)
      if (state?.running === true && state.open === true) break
      if (spawnError !== undefined) break
      if (Number.isInteger(exitCode)) break
      await sleep(100)
    }
    const running = state?.running === true
    const open = state?.open === true
    const failure = spawnError !== undefined
      ? `could not start the monitor: ${spawnError.message}`
      : running && !open
        ? (state?.error ?? `serial port ${chosenPort} is not open`)
        : !running && Number.isInteger(exitCode)
          ? `monitor exited immediately with code ${exitCode}${state?.error ? `: ${state.error}` : ''}`
          : running ? undefined : 'monitor did not open the port'

    if (!open) {
      // Do not leave a retrying process behind when the start was a failure.
      try {
        if (running) await stopMonitor(chosenPort)
        else removeQuietly(paths.state)
      } catch {
        // best effort: the error below already explains the situation
      }
      // An empty log left behind by a start that never opened the port is noise:
      // the next start would look like it had captured something.
      if (existsSync(paths.log) && statSync(paths.log).size === 0) removeQuietly(paths.log)
    } else if (reset === 'esp') {
      // Claimed only once the port is really open: a failed start must leave the
      // caller's read cursor exactly where it was.
      await setOffset(chosenPort, baselineBytes)
    }
    return compact({
      port: chosenPort,
      baud: chosenBaud,
      // A failed start stops its own process again: reporting `running` from the
      // moment before that cleanup is what made "start … : running — <error>"
      // contradict itself.
      running: open === true,
      open,
      log: paths.log,
      startedAt: state?.startedAt,
      error: failure,
      reused: false,
    })
  }

  /**
   * Length of the longest prefix that ends on a UTF-8 character boundary.
   * Without this a multi-byte character split across two reads decodes as a
   * replacement glyph, and the stored offset makes the damage permanent.
   */
  function completeUtf8Length(buffer, length) {
    if (length <= 0) return 0
    let index = length - 1
    let back = 0
    while (index >= 0 && back < 4 && (buffer[index] & 0xc0) === 0x80) {
      index -= 1
      back += 1
    }
    if (index < 0) return 0
    const leader = buffer[index]
    const need = leader < 0x80
      ? 1
      : (leader & 0xe0) === 0xc0
        ? 2
        : (leader & 0xf0) === 0xe0
          ? 3
          : (leader & 0xf8) === 0xf0
            ? 4
            : 1
    return length - index >= need ? length : index
  }

  /**
   * Offsets are a read-modify-write across concurrent callers (the panel polls
   * while the agent reads and flashes). Serialise the whole file operation so
   * two reads cannot both advance from the same offset and lose a chunk.
   */
  let offsetQueue = Promise.resolve()
  function withOffsetLock(task) {
    const run = offsetQueue.then(task, task)
    offsetQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function persistOffset(offsetsPath, offsets) {
    mkdirSync(stateRoot, { recursive: true })
    const tmp = `${offsetsPath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(offsets))
    renameSync(tmp, offsetsPath)
  }

  /**
   * Offsets are kept per consumer ("agent" for the board_* tools, "panel" for the
   * web UI). A single shared cursor would let the panel's 0.9 s poll swallow the
   * bytes an agent is waiting for (and the other way round), which silently loses
   * output exactly when two clients watch one board. Old files store a bare number;
   * it seeds both consumers so an upgrade neither replays nor skips the log.
   */
  function consumerOffset(raw, consumer) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (raw !== null && typeof raw === 'object') {
      const value = Number(raw[consumer] ?? 0)
      return Number.isFinite(value) ? value : 0
    }
    return 0
  }

  function storeConsumerOffset(offsets, port, consumer, value) {
    const current = offsets[port]
    const base = typeof current === 'number'
      ? { agent: current, panel: current }
      : current !== null && typeof current === 'object'
        ? current
        : {}
    offsets[port] = consumer === 'all'
      ? { agent: value, panel: value }
      : { ...base, [consumer]: value }
  }

  /** Synchronous read of one log range, without touching the stored offset. */
  function readLogRange({ port, fromStart = false, maxBytes = 65536, consumer = 'agent' }) {
    const paths = monitorPaths(port)
    const size = existsSync(paths.log) ? statSync(paths.log).size : 0
    const offsets = readJson(paths.offsets) ?? {}
    let start = fromStart ? 0 : consumerOffset(offsets[port], consumer)
    if (!Number.isFinite(start) || start < 0 || start > size) start = 0
    const cap = Math.max(1, Math.min(Number(maxBytes) || 65536, 1 << 20))
    const wanted = Math.max(0, Math.min(size - start, cap))
    let text = ''
    let consumed = 0
    if (wanted > 0) {
      const buffer = Buffer.alloc(wanted)
      const fd = openSync(paths.log, 'r')
      try {
        const read = readSync(fd, buffer, 0, wanted, start)
        consumed = completeUtf8Length(buffer, read)
        text = buffer.subarray(0, consumed).toString('utf8')
      } finally {
        closeSync(fd)
      }
    }
    const nextOffset = start + consumed
    return {
      port,
      text,
      bytes: consumed,
      totalBytes: size,
      nextOffset,
      pendingBytes: size - nextOffset,
      startOffset: start,
    }
  }

  /** Read new output since the stored offset (or from the beginning). */
  async function readMonitor({ port, fromStart = false, peek = false, maxBytes = 65536, consumer = 'agent' }) {
    const paths = monitorPaths(port)
    const chunk = peek || fromStart
      ? // `peek` never advances, and `fromStart` dumps the whole log: rewinding
        // the stored cursor behind the caller's back would make the next read
        // replay everything from the beginning.
        readLogRange({ port, fromStart, maxBytes, consumer })
      : await withOffsetLock(async () => {
          const fresh = readLogRange({ port, fromStart, maxBytes, consumer })
          const offsets = readJson(paths.offsets) ?? {}
          storeConsumerOffset(offsets, port, consumer, fresh.nextOffset)
          persistOffset(paths.offsets, offsets)
          return fresh
        })
    const state = monitorState(port)
    return {
      ...chunk,
      running: state?.running === true,
      stale: state?.stale === true,
      open: state?.open === true,
      baud: state?.baud,
      error: state?.open === false ? (state?.error ?? undefined) : undefined,
    }
  }

  function tailChunk(chunk, lines) {
    return lastLines(chunk, lines)
  }

  /** Move the stored read offset for one port (all consumers by default). */
  async function setOffset(port, value, consumer = 'all') {
    const paths = monitorPaths(port)
    await withOffsetLock(async () => {
      const offsets = readJson(paths.offsets) ?? {}
      storeConsumerOffset(offsets, port, consumer, Math.max(0, Number(value) || 0))
      persistOffset(paths.offsets, offsets)
    })
  }

  /** Wait until the monitor owns the serial device, starting it when needed. */
  async function ensureMonitorOpen(port, baud) {
    let state = monitorState(port)
    if (state?.running !== true) {
      const started = await startMonitor({ port, baud, reset: 'none' })
      if (started.open !== true) throw new Error(started.error ?? `serial port ${port} is not open`)
      return started
    }
    if (state.open !== true) {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && monitorState(port)?.open !== true) await sleep(100)
      state = monitorState(port)
      if (state?.open !== true) {
        throw new Error(state?.error ?? `serial port ${port} is not open (the device may be unplugged)`)
      }
    }
    return state
  }

  /** Send one control command to a monitor's loopback socket. */
  function monitorCommand(port, command, timeoutMs = 3000) {
    const state = readJson(monitorPaths(port).state)
    if (!Number.isInteger(state?.tcpPort)) {
      return Promise.reject(new Error(`monitor for ${port} is not running`))
    }
    return new Promise((resolvePromise, reject) => {
      const socket = connect({ host: '127.0.0.1', port: state.tcpPort })
      let done = false
      let buffer = ''
      const finish = (value, error) => {
        if (done) return
        done = true
        socket.destroy()
        if (error) reject(error)
        else resolvePromise(value)
      }
      socket.setTimeout(timeoutMs)
      socket.on('connect', () => socket.write(`${JSON.stringify(command)}\n`))
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        if (buffer.includes('\n')) {
          const line = buffer.slice(0, buffer.indexOf('\n'))
          try {
            finish(JSON.parse(line))
          } catch (error) {
            finish(undefined, error)
          }
        }
      })
      socket.on('timeout', () => finish(undefined, new Error(`monitor for ${port} did not answer`)))
      socket.on('error', (error) => finish(undefined, error))
    })
  }

  async function writeOp({ port, text, newline = true }) {
    const chosenPort = port || selectPort(undefined)
    await ensureMonitorOpen(chosenPort)
    const answer = await monitorCommand(chosenPort, {
      cmd: 'write',
      text: newline ? `${String(text)}\n` : String(text),
    })
    if (answer?.ok !== true) throw new Error(answer?.error ?? 'write failed')
    return { ok: true, port: chosenPort, bytes: Buffer.byteLength(String(text)) }
  }

  async function resetOp({ port }) {
    const chosenPort = port || selectPort(undefined)
    await ensureMonitorOpen(chosenPort)
    const answer = await monitorCommand(chosenPort, { cmd: 'reset' })
    if (answer?.ok !== true) throw new Error(answer?.error ?? 'reset failed')
    return { ok: true, port: chosenPort }
  }

  // --------------------------------------------------------------- operations
  // One implementation per operation; tools and /board-lab routes call these.

  async function buildOp({ project, env }) {
    const dir = projectDir(project)
    if (projectKind(dir) === 'pio') {
      const argv = ['run', '-d', dir]
      if (env) argv.push('-e', env)
      return summarise(`Build of ${dir}`, await runPio(argv, { timeoutMs: 900_000 }))
    }
    return summarise(`Build of ${dir}`, await runMake(dir, ['all'], { timeoutMs: 900_000 }))
  }

  async function flashOp({ project, port, protocol, env }) {
    const probeProtocol = typeof protocol === 'string' && ['jlink', 'stlink', 'cmsis-dap', 'openocd'].includes(protocol)
    let chosenPort = typeof port === 'string' && port.trim() !== '' ? port.trim() : undefined
    let dir
    let kind
    if (typeof project === 'string' && project.trim() !== '') {
      dir = projectDir(project)
      kind = projectKind(dir)
    } else {
      // No project named: the pinned project is the answer when there is one,
      // so a bare `board_flash` uses exactly what the panel shows. Otherwise ask
      // the board; a remembered serial flashes without probing.
      if (chosenPort === undefined) {
        const pinned = currentProject()
        if (pinned !== undefined) {
          dir = pinned.dir
          kind = pinned.kind
          project = pinned.path
          env = env ?? pinned.env
        }
      }
      if (dir === undefined) {
        if (chosenPort === undefined) chosenPort = selectPort(undefined)
        const resolved = await resolveProjectForPort(chosenPort)
        dir = resolved.dir
        kind = projectKind(dir)
        project = resolved.project
        env = env ?? resolved.env
      }
    }
    // A probe upload (ST-Link / J-Link / CMSIS-DAP / OpenOCD / DFU) needs no
    // serial port; serial bootloaders do. `upload_protocol` in platformio.ini
    // says which kind this project is.
    let probeCapable = kind === 'make' && probeProtocol
    if (kind === 'pio') {
      const envs = pioEnvs(dir)
      const chosenEnv = envs.find((item) => item.name === env) ?? envs.find((item) => item.default) ?? envs[0]
      const configured = String(chosenEnv?.uploadProtocol ?? '').toLowerCase()
      probeCapable = probeProtocol || ['stlink', 'dfu', 'jlink', 'cmsis-dap', 'openocd'].includes(configured)
    }
    if (chosenPort === undefined) {
      try {
        chosenPort = selectPort(undefined)
      } catch (error) {
        if (!probeCapable) throw error
      }
    }
    const before = chosenPort === undefined ? undefined : monitorState(chosenPort)
    const wasRunning = before?.running === true

    // The port must be free for esptool; the monitor is restarted afterwards so
    // the boot log of the freshly flashed firmware is captured.
    if (wasRunning) await stopMonitor(chosenPort)
    let result
    try {
      if (kind === 'pio') {
        const argv = ['run', '-d', dir, '-t', 'upload']
        if (env) argv.push('-e', env)
        if (protocol) argv.push('--upload-protocol', protocol)
        if (chosenPort !== undefined) argv.push('--upload-port', chosenPort)
        result = await runPio(argv, { timeoutMs: 300_000 })
      } else {
        const extraEnv = {}
        if (protocol) extraEnv.AT32_FLASH = protocol
        if (chosenPort !== undefined) extraEnv.AT32_PORT = chosenPort
        result = await runMake(dir, ['flash'], { timeoutMs: 300_000, extraEnv })
      }
    } finally {
      // A successful flash reboots the board: start the monitor with a reset
      // pulse so the next read returns the fresh boot banner. A failed flash
      // keeps the previous behaviour (resume monitoring only if it was on).
      if (result?.ok === true && chosenPort !== undefined) {
        await startMonitor({ port: chosenPort, baud: before?.baud ?? settings.defaultBaud, reset: 'esp' })
        // Drop the pre-flash backlog: the next read must start at the boot log
        // of the image that was just written, not at stale earlier output.
        await setOffset(chosenPort, (await readMonitor({ port: chosenPort, peek: true })).totalBytes)
      } else if (wasRunning && chosenPort !== undefined) {
        await startMonitor({ port: chosenPort, baud: before.baud, reset: 'none' })
      }
    }
    // Remember successful flashes so the next `board_flash` can omit `project`.
    if (result.ok === true) forgetPorts()
    if (result.ok === true && chosenPort !== undefined) {
      const entry = attachedPorts().find((item) => item.path === chosenPort)
      const family = chipFamilyFromBoard(pioEnvs(dir).find((item) => item.name === env)?.board)
      rememberBoard(boardCacheKey(entry), { project: projectLabel(dir), env, family, chip: undefined })
    }
    const summary = summarise(`Flash of ${dir}`, result)
    return compact({
      ...summary,
      port: chosenPort,
      monitor: result.ok ? (chosenPort !== undefined ? 'started' : 'no serial port') : wasRunning ? 'restarted' : 'not running',
    })
  }

  async function cycleOp({ project, env, port, baud, durationMs, untilPattern, reset }) {
    const build = await buildOp({ project, env })
    if (!build.ok) {
      return { ok: false, build, flash: { ok: false, summary: 'skipped: build failed', output: '', exitCode: -1, durationMs: 0 }, uart: { ok: false, text: '', matched: [] } }
    }
    let flash
    try {
      flash = await flashOp({ project, env, port })
    } catch (error) {
      return {
        ok: false,
        build,
        flash: { ok: false, summary: `Flash not attempted: ${error instanceof Error ? error.message : String(error)}`, output: '', exitCode: -1, durationMs: 0 },
        uart: { ok: false, text: '', matched: [] },
      }
    }
    if (!flash.ok) return { ok: false, build, flash, uart: { ok: false, text: '', matched: [] } }
    const chosenPort = flash.port
    if (chosenPort === undefined) {
      return {
        ok: false,
        build,
        flash,
        uart: { ok: false, text: '', matched: [], error: 'no serial port was selected; connect a board or pass `port`' },
      }
    }
    const startedMonitor = await startMonitor({
      port: chosenPort,
      baud: Number.isInteger(baud) ? baud : settings.defaultBaud,
      reset: typeof reset === 'string' ? reset : 'esp',
    })
    // startMonitor already moved the cursor to the byte before the boot banner;
    // baselining again here would throw away whatever the device printed while
    // the monitor was opening, which is the banner itself.
    if (startedMonitor.open !== true) {
      return {
        ok: false,
        build,
        flash,
        uart: { ok: false, text: '', matched: [], port: chosenPort, error: startedMonitor.error ?? 'monitor did not open the port' },
      }
    }
    const started = Date.now()
    const deadline = started + Math.max(500, Number.isInteger(durationMs) ? durationMs : 4000)
    const matcher = typeof untilPattern === 'string' && untilPattern !== '' ? new RegExp(untilPattern) : undefined
    let text = ''
    while (Date.now() < deadline) {
      const chunk = await readMonitor({ port: chosenPort })
      text += chunk.text
      if (matcher?.test(text)) break
      await sleep(150)
    }
    const state = monitorState(chosenPort)
    const matched = matcher === undefined ? [] : [text.split('\n').find((line) => matcher.test(line))].filter(Boolean)
    return {
      ok: true,
      build,
      flash,
      uart: { ok: true, port: chosenPort, text, matched, running: state?.open === true },
    }
  }

  /**
   * Wait for a regex in new device output. This is the primitive behind
   * "flash, then wait until READY appears" without polling from the outside.
   */
  async function watchOp({ port, pattern, timeoutMs, baud, fromStart = false, fromOffset, project, env }) {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      throw new Error('`pattern` must be a non-empty regular expression')
    }
    let matcher
    try {
      matcher = new RegExp(pattern)
    } catch (error) {
      throw new Error(`invalid regular expression ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const chosenPort = port || selectPort(undefined)
    let state = monitorState(chosenPort)
    if (state?.running !== true) {
      const started = await startMonitor({ port: chosenPort, baud, reset: 'none' })
      if (started.open !== true) throw new Error(started.error ?? `serial port ${chosenPort} is not open`)
      state = monitorState(chosenPort)
    }
    // A watch means "the device prints this next". Bytes already in the log come
    // from an earlier boot, and matching them is exactly how a stale READY line
    // passed for a fresh one. The `watch` cursor is separate from the agent and
    // panel cursors, so skipping the backlog here does not swallow their bytes.
    let text = ''
    let line
    let matched = false
    if (fromStart) {
      // One dump of the whole log, then continue from its end: re-dumping on
      // every poll would append the same bytes over and over to `text`.
      const dump = await readMonitor({ port: chosenPort, fromStart: true, maxBytes: 1 << 20, consumer: 'watch' })
      text = dump.text
      await setOffset(chosenPort, dump.totalBytes, 'watch')
      matched = matcher.test(text)
      if (matched) line = text.split('\n').find((entry) => matcher.test(entry))
    } else if (Number.isFinite(fromOffset)) {
      // Scenario steps watch from the start of the previous step: a device that
      // answers a write instantly (PING→PONG) has already printed by the time the
      // next step runs, and the answer must not be treated as stale backlog.
      await setOffset(chosenPort, Math.max(0, Math.trunc(fromOffset)), 'watch')
    } else {
      await setOffset(chosenPort, logSize(chosenPort), 'watch')
    }
    const limit = Number.isInteger(timeoutMs) ? Math.max(500, Math.min(timeoutMs, 120_000)) : 15_000
    const deadline = Date.now() + limit
    while (!matched && Date.now() < deadline) {
      const chunk = await readMonitor({ port: chosenPort, maxBytes: 65536, consumer: 'watch' })
      if (chunk.text !== '') text += chunk.text
      if (text.length > 300_000) text = text.slice(-300_000)
      if (matcher.test(text)) {
        matched = true
        line = text.split('\n').find((entry) => matcher.test(entry))
        break
      }
      if (chunk.bytes === 0) await sleep(120)
    }
    const open = monitorState(chosenPort)?.open === true
    // A panic that just scrolled by is the most useful thing in the log; resolve
    // it against the ELF of the project that was flashed to this port.
    let decode
    if (matched && PANIC_SIGNATURES.test(text)) {
      try {
        decode = await decodeText({ project, env, port: chosenPort, text })
      } catch (error) {
        decode = { ok: false, summary: error instanceof Error ? error.message : String(error), frames: [] }
      }
    }
    return compact({
      ok: true,
      port: chosenPort,
      pattern,
      matched,
      line: matched ? line : undefined,
      text: tail(text, 20_000),
      timeoutMs: limit,
      open,
      panic: decode !== undefined,
      decode,
    })
  }

  /**
   * Ask esptool for chip identity and flash size. This is how a 4 MB module
   * with an 8 MB partition table is caught before it boot-loops.
   */
  async function infoOp({ port }) {
    const chosenPort = port || selectPort(undefined)
    const before = monitorState(chosenPort)
    if (before?.running === true) await stopMonitor(chosenPort)
    let result
    try {
      result = await runPython(['-m', 'esptool', '--port', chosenPort, 'flash_id'], { timeoutMs: 90_000 })
    } finally {
      // esptool leaves the chip in the serial bootloader; the monitor's reset
      // pulse returns it to the application and captures the boot banner.
      try {
        await startMonitor({ port: chosenPort, baud: before?.baud ?? settings.defaultBaud, reset: 'esp' })
        await setOffset(chosenPort, (await readMonitor({ port: chosenPort, peek: true })).totalBytes)
      } catch {
        // identity is still useful even when the monitor cannot be restarted
      }
    }
    const output = clean(`${result.stdout}\n${result.stderr}`)
    // esptool 4.x prints "Chip is …"; 5.x prints "Chip type: ESP32-S3 (QFN56)".
    const chip = /(?:Chip type|Chip is):\s+([A-Za-z0-9-]+)/.exec(output)?.[1] ?? /Detecting chip type\.\.\.\s*([A-Za-z0-9-]+)/.exec(output)?.[1]
    const flashSize = /Detected flash size:\s*([0-9]+ ?[KMG]B)/i.exec(output)?.[1]
    const mac = /MAC:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i.exec(output)?.[1]
    const psram = /Embedded PSRAM\s+([0-9]+ ?MB)/i.exec(output)?.[1]
    const revision = /revision (v[0-9.]+)/i.exec(output)?.[1]
    const summary = summarise(`Chip info for ${chosenPort}`, result)
    return compact({ ...summary, port: chosenPort, chip, flashSize, mac, psram, revision, monitor: 'started' })
  }

  /**
   * Chip identity without the pretty summary. Used by detection, where the
   * answer is machine input (family → project) rather than a log line.
   */
  async function identityForPort(port) {
    // USB ids answer the family question without touching the port, and AVR
    // boards have no chip id at all until a programmer runs.
    const entry = attachedPorts().find((item) => item.path === port)
    const guess = usbFamily(entry?.vendorId, entry?.productId)
    if (guess === 'stm32') {
      const probed = await probeStm32()
      if (probed !== undefined) return probed
      return { family: 'stm32', note: 'no ST-Link probe tools found (st-info); PlatformIO can still flash if upload_protocol is set' }
    }
    if (guess === 'avr') {
      return { family: 'avr', note: 'AVR boards report no chip id before programming; name the project explicitly' }
    }
    const before = monitorState(port)
    const wasRunning = before?.running === true
    if (wasRunning) await stopMonitor(port)
    let result
    try {
      result = await runPython(['-m', 'esptool', '--port', port, 'flash_id'], { timeoutMs: 90_000 })
    } finally {
      // Only put the monitor back if it was there before: detection should not
      // silently start logging on a port the user had left alone.
      if (wasRunning) {
        try {
          await startMonitor({ port, baud: before.baud ?? settings.defaultBaud, reset: 'esp' })
          await setOffset(port, (await readMonitor({ port, peek: true })).totalBytes)
        } catch {
          // identity is still useful when the monitor cannot be restarted
        }
      }
    }
    const output = clean(`${result.stdout}\n${result.stderr}`)
    const chip = /(?:Chip type|Chip is):\s+([A-Za-z0-9-]+)/.exec(output)?.[1] ?? /Detecting chip type\.\.\.\s*([A-Za-z0-9-]+)/.exec(output)?.[1]
    if (result.ok !== true && chip === undefined) {
      throw new Error(tail(output, 500).trim() || 'esptool could not read the chip')
    }
    return {
      chip,
      family: chipFamily(chip),
      flashSize: /Detected flash size:\s*([0-9]+ ?[KMG]B)/i.exec(output)?.[1],
      mac: /MAC:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i.exec(output)?.[1],
      psram: /Embedded PSRAM\s+([0-9]+ ?MB)/i.exec(output)?.[1],
      revision: /revision (v[0-9.]+)/i.exec(output)?.[1],
      output,
    }
  }

  /**
   * Work out which project a port belongs to.
   *   cached  — a previous flash of this USB serial, no probing, no reset
   *   chip    — esptool says the family, exactly one project builds for it
   * A wrong guess would flash the wrong firmware, so ambiguity is an error
   * that lists the candidates instead of picking one.
   */
  async function resolveProjectForPort(port, options = {}) {
    const entry = attachedPorts().find((item) => item.path === port)
    const key = boardCacheKey(entry)
    const projects = listProjects().map((project) => projectSummary(project.path))
    const cached = key === undefined ? undefined : readBoards()[key]
    if (cached !== undefined) {
      const match = projects.find((project) => project.path === cached.project)
      if (match !== undefined) {
        return { dir: match.dir, project: match.path, env: cached.env, family: cached.family, source: 'cache' }
      }
    }
    if (options.probe === false) return undefined
    const identity = await identityForPort(port)
    const family = identity.family ?? chipFamily(identity.chip)
    // The project the user pinned in the panel beats guessing between equal
    // families: that is the whole point of a "current project".
    const current = currentProject()
    if (current !== undefined && (family === undefined || current.families.includes(family))) {
      return { dir: current.dir, project: current.path, env: current.env, family, source: 'current' }
    }
    const matches = projects.filter((project) => project.families.includes(family))
    if (matches.length === 1) {
      const match = matches[0]
      const env = match.envs.find((item) => item.family === family && item.default)?.name
        ?? match.envs.find((item) => item.family === family)?.name
      rememberBoard(key, { project: match.path, env, family, chip: identity.chip })
      return { dir: match.dir, project: match.path, env, family, source: 'chip', chip: identity.chip }
    }
    if (matches.length === 0) {
      throw new Error(`Detected ${identity.chip ?? 'an unknown chip'}${family === undefined ? '' : ` (${family})`}, but no project under ${settings.projectsDir} builds for it. Pass \`project\`.`)
    }
    throw new Error(`Detected ${identity.chip ?? 'the chip'}; ${matches.length} projects match: ${matches.map((project) => project.path).join(', ')}. Pass \`project\` (and \`env\` if needed).`)
  }

  /** Report chip + suggested project per attached port, without flashing. */
  async function detectOp({ port } = {}) {
    const entry = port === undefined || port === '' ? undefined : port.trim()
    const attached = attachedPorts()
    const ports = entry === undefined ? attached : [{ ...(attached.find((item) => item.path === entry) ?? {}), path: entry }]
    if (ports.length === 0) {
      throw new Error(isWindows
        ? 'No serial port is attached. Connect the board and run board_ports; Windows shows it as COM1, COM3, … — check Device Manager if nothing appears.'
        : 'No serial port is attached. Connect the board and run board_ports; on Linux the user must be able to open the device (dialout group or a udev rule).')
    }
    const projects = listProjects().map((project) => projectSummary(project.path))
    const boards = readBoards()
    const results = []
    for (const item of ports) {
      const result = { path: item.path, confidence: 'none', reason: '' }
      if (item.byId !== undefined) result.byId = item.byId
      if (item.vendorId !== undefined) result.vendorId = item.vendorId
      if (item.productId !== undefined) result.productId = item.productId
      if (item.driver !== undefined) result.driver = item.driver
      const key = boardCacheKey(item)
      const cached = key === undefined ? undefined : boards[key]
      const candidates = (family) => projects
        .filter((project) => project.families.includes(family))
        .map((project) => ({
          project: project.path,
          envs: project.envs.filter((env) => env.family === family).map((env) => env.name),
        }))
      try {
        const identity = await identityForPort(item.path)
        if (identity.chip !== undefined) result.chip = identity.chip
        if (identity.flashSize !== undefined) result.flashSize = identity.flashSize
        if (identity.psram !== undefined) result.psram = identity.psram
        if (identity.mac !== undefined) result.mac = identity.mac
        if (identity.revision !== undefined) result.revision = identity.revision
        const family = identity.family ?? chipFamily(identity.chip)
        if (family !== undefined) {
          result.family = family
          const matches = candidates(family)
          result.candidates = matches
          // A flash already answered this question: the port's remembered project
          // wins over ambiguity between equal-family projects.
          const remembered = cached?.project === undefined
            ? undefined
            : projects.find((project) => project.path === cached.project)
          if (remembered !== undefined && remembered.families.includes(family)) {
            result.project = remembered.path
            const env = remembered.envs.find((item) => item.family === family && item.name === cached.env)
              ?? remembered.envs.find((item) => item.family === family)
            if (env !== undefined) result.env = env.name
            result.confidence = 'high'
            result.reason = `remembered from an earlier flash (chip ${identity.chip})`
            rememberBoard(key, { ...cached, family, chip: identity.chip })
          } else {
            const pinned = currentProject()
            if (pinned !== undefined && pinned.families.includes(family)) {
              result.project = pinned.path
              result.env = pinned.env
              result.confidence = 'high'
              result.reason = `current project for ${family} (selected in the panel)`
            }
          }
          if (result.project === undefined) {
            if (matches.length === 1) {
              result.project = matches[0].project
              result.env = matches[0].envs[0]
              result.confidence = 'high'
              result.reason = `chip ${identity.chip} matches the only ${family} project`
              rememberBoard(key, { project: result.project, env: result.env, family, chip: identity.chip })
            } else if (matches.length > 1) {
              result.confidence = 'medium'
              result.reason = `${matches.length} projects build for ${family}; pass project explicitly or select one in the panel`
            } else {
              result.reason = `chip ${identity.chip} but no project builds for ${family}`
            }
          }
        } else {
          result.reason = `chip ${identity.chip ?? 'unknown'}: no family mapping`
        }
      } catch (error) {
        result.reason = `probe failed: ${error instanceof Error ? error.message : String(error)}`
        if (cached !== undefined) {
          result.project = cached.project
          result.env = cached.env
          result.confidence = 'cache'
          result.reason = `probe failed (${result.reason}); using the project remembered from an earlier flash`
        }
      }
      results.push(result)
    }
    return { ok: true, ports: results }
  }

  /**
   * Preflight for a fresh machine: which pieces are present, which are missing
   * and what to install. Answers "why does flashing not work here" without a
   * board attached.
   */
  async function doctorOp() {
    const checks = []
    const add = (name, ok, detail, fix) => checks.push(compact({ name, ok, detail, fix }))
    const python = pythonCommand()
    let version
    try {
      const result = platformioPio() !== undefined
        ? await runProcess(platformioPio(), ['--version'], { timeoutMs: 20_000 })
        : await runPython(['-m', 'platformio', '--version'], { timeoutMs: 20_000 })
      version = clean(`${result.stdout}\n${result.stderr}`).trim().split(/\r?\n/)[0]
      add('platformio', result.ok === true, version || 'answered', 'Install PlatformIO (pip install platformio) or point the `python` config at the interpreter that has it.')
    } catch (error) {
      add('platformio', false, error instanceof Error ? error.message : String(error), 'Install PlatformIO (pip install platformio) or point the `python` config at the interpreter that has it.')
    }
    add('python', python.command !== undefined, `${python.command} (${python.source})`, 'Install Python 3 or set the `python` config.')
    try {
      const result = await runPython(['-c', 'import serial; print(serial.__version__)'], { timeoutMs: 20_000 })
      add('pyserial', result.ok === true, clean(result.stdout).trim() || 'not importable', 'pip install pyserial')
    } catch (error) {
      add('pyserial', false, error instanceof Error ? error.message : String(error), 'pip install pyserial')
    }
    try {
      const result = await runPython(['-m', 'esptool', 'version'], { timeoutMs: 20_000 })
      add('esptool', result.ok === true, clean(result.stdout).trim().split(/\r?\n/)[0], 'pip install esptool (ESP32 chip info and flashing)')
    } catch {
      add('esptool', false, 'not installed', 'pip install esptool (ESP32 chip info and flashing)')
    }
    // avrdude usually comes with PlatformIO rather than the system PATH.
    const bundled = (prefix) => {
      // The workspace toolchain wins over ~/.platformio, exactly like pythonEnv().
      const packages = join(workspacePio ? join(toolchainDir, 'pio') : platformioCoreDir(), 'packages')
      try {
        return readdirSync(packages).filter((name) => name.startsWith(prefix)).map((name) => join(packages, name)).pop()
      } catch {
        return undefined
      }
    }
    const avrdude = hasCommand('avrdude') ? 'avrdude' : (bundled('tool-avrdude') ?? bundled('toolchain-atmelavr'))
    add('avrdude', avrdude !== undefined, avrdude ?? 'not found', 'AVR boards (Arduino Uno/Nano): `pio pkg install -g -p atmelavr` brings avrdude, or install it system-wide.')
    for (const [tool, why] of [
      ['st-info', 'ST-Link probes (STM32)'],
      ['openocd', 'OpenOCD probes (AT32/STM32)'],
    ]) {
      add(tool, hasCommand(tool), hasCommand(tool) ? 'found' : 'not found', `${why}: install the vendor tools and add them to PATH (optional if PlatformIO bundles them).`)
    }
    const gcc = join(toolchainDir, 'pio', 'packages', 'toolchain-gccarmnoneeabi', 'bin', isWindows ? 'arm-none-eabi-gcc.exe' : 'arm-none-eabi-gcc')
    add('arm-none-eabi-gcc', existsSync(gcc) || hasCommand('arm-none-eabi-gcc'), existsSync(gcc) ? gcc : 'not found', 'Only needed for Makefile/AT32 projects; PlatformIO downloads its own toolchains.')
    const ports = attachedPorts()
    add('serial ports', ports.length > 0, ports.length === 0 ? 'no board attached' : ports.map((port) => `${port.path}${port.vendorId === undefined ? '' : ` (${port.vendorId}:${port.productId})`}`).join(', '), 'Connect the board over USB; on Linux add the user to dialout or install a udev rule, on Windows install the USB-UART driver.')
    const projects = listProjects()
    add('workspace', projects.length > 0, `${projects.length} project(s) under ${settings.projectsDir}`, `Put firmware projects under ${settings.projectsDir} or set the \`workspaceRoot\` config.`)
    add('monitor', existsSync(join(BUNDLE_DIR, 'monitor.py')), join(BUNDLE_DIR, 'monitor.py'), 'Reinstall the board-lab bundle: the UART monitor script is missing.')
    const required = checks.filter((check) => ['platformio', 'pyserial', 'monitor'].includes(check.name))
    const failed = checks.filter((check) => check.ok !== true)
    return {
      ok: required.every((check) => check.ok === true),
      summary: failed.length === 0
        ? 'Everything needed is present.'
        : `${failed.length} check(s) need attention: ${failed.map((check) => check.name).join(', ')}`,
      checks,
    }
  }


  // --------------------------------------------------------------- toolchain
  // The settings page and board_tools show what a fresh machine still misses
  // and install the selection in one background run.

  const packagesRoot = () => join(workspacePio ? join(toolchainDir, 'pio') : platformioCoreDir(), 'packages')
  const platformsRoot = () => join(workspacePio ? join(toolchainDir, 'pio') : platformioCoreDir(), 'platforms')

  function installedDir(root, name) {
    try {
      return readdirSync(root).find((entry) => entry === name || entry.startsWith(`${name}@`))
    } catch {
      return undefined
    }
  }

  async function toolInventory() {
    const python = pythonCommand()
    const rows = []
    const add = (row) => rows.push(compact(row))

    let pioVersion
    try {
      const probe = await runPio(['--version'], { timeoutMs: 20_000 })
      pioVersion = clean(probe.stdout).trim().split(/\r?\n/)[0]
      add({ id: 'platformio', name: 'PlatformIO Core', group: 'core', kind: 'pip', ok: probe.ok === true, version: probe.ok === true ? pioVersion : undefined, why: TOOL_CATALOG[0].why, detail: probe.ok === true ? `via ${python.command}` : tail(clean(`${probe.stdout}\n${probe.stderr}`), 500) })
    } catch (error) {
      add({ id: 'platformio', name: 'PlatformIO Core', group: 'core', kind: 'pip', ok: false, why: TOOL_CATALOG[0].why, detail: error instanceof Error ? error.message : String(error) })
    }

    const probeModule = async (id, args) => {
      const row = TOOL_CATALOG.find((item) => item.id === id)
      try {
        const result = await runPython(args, { timeoutMs: 20_000 })
        const version = clean(result.stdout).trim().split(/\r?\n/)[0]
        add({ id, name: row.name, group: row.group, kind: row.kind, ok: result.ok === true, version: result.ok === true ? version : undefined, why: row.why, detail: result.ok === true ? undefined : tail(clean(`${result.stdout}\n${result.stderr}`), 500) })
      } catch (error) {
        add({ id, name: row.name, group: row.group, kind: row.kind, ok: false, why: row.why, detail: error instanceof Error ? error.message : String(error) })
      }
    }
    await probeModule('pyserial', ['-c', 'import serial; print(serial.VERSION)'])
    await probeModule('esptool', ['-m', 'esptool', 'version'])

    for (const row of TOOL_CATALOG) {
      if (row.kind !== 'tool' && row.kind !== 'platform') continue
      const dir = installedDir(row.kind === 'tool' ? packagesRoot() : platformsRoot(), row.pkg)
      const version = dir !== undefined && dir.includes('@') ? dir.slice(dir.indexOf('@') + 1) : undefined
      add({ id: row.id, name: row.name, group: row.group, kind: row.kind, ok: dir !== undefined, version, why: row.why, detail: dir !== undefined ? dir : `not found under ${row.kind === 'tool' ? packagesRoot() : platformsRoot()}` })
    }

    return {
      ok: rows.every((row) => row.id === 'openocd' || row.id === 'stlink' || row.ok === true),
      tools: rows,
      installed: rows.filter((row) => row.ok === true).length,
      total: rows.length,
      python: python.command,
      source: python.source,
      install: installSnapshot(),
    }
  }

  /** pip needs --target for the workspace site-packages; PlatformIO owns its own venv. */
  function pipArgs(pkg) {
    const args = ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', '--no-warn-script-location']
    if (workspacePython && pythonCommand().source !== 'platformio') args.push('--target', pythonLib)
    args.push(pkg)
    return args
  }

  const installState = {
    running: false,
    ids: [],
    results: new Map(),
    log: [],
    startedAt: undefined,
    finishedAt: undefined,
  }

  function installSnapshot() {
    return compact({
      running: installState.running,
      ids: installState.ids,
      startedAt: installState.startedAt,
      finishedAt: installState.finishedAt,
      results: [...installState.results.entries()].map(([id, value]) => ({ id, ...value })),
      log: tail(installState.log.join('\n'), 20_000),
    })
  }

  /** One-line-per-tool render shared by the panel and board_tools. */
  function toolsText(value) {
    const lines = (value.tools ?? []).map((row) => `${row.ok === true ? 'OK  ' : 'MISS'} ${row.name}${row.version === undefined ? '' : ` ${row.version}`}`)
    const install = value.install
    const progress = install?.running === true ? `installing: ${(install.ids ?? []).join(', ')}` : ''
    return [`${value.installed ?? 0}/${value.total ?? 0} tool(s) present`, ...lines, progress].filter(Boolean).join('\n')
  }

  async function installToolsOp({ ids }) {
    const requested = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []
    const rows = requested
      .map((id) => TOOL_CATALOG.find((row) => row.id === id))
      .filter((row) => row !== undefined)
    if (rows.length === 0) throw new Error('`ids` must list tool ids from the inventory')
    if (installState.running) throw new Error('an install is already running; wait for it to finish')
    installState.running = true
    installState.ids = rows.map((row) => row.id)
    installState.startedAt = Date.now()
    installState.finishedAt = undefined
    installState.results = new Map(rows.map((row) => [row.id, { status: 'queued' }]))
    installState.log = []
    const order = new Map(TOOL_CATALOG.map((row, index) => [row.id, index]))
    const queue = [...rows].sort((left, right) => order.get(left.id) - order.get(right.id))
    void (async () => {
      for (const row of queue) {
        installState.results.set(row.id, { status: 'running' })
        const command = row.kind === 'pip' ? { tool: 'pip', args: pipArgs(row.pkg) } : { tool: 'pio', args: ['pkg', 'install', '-g', row.kind === 'tool' ? '-t' : '-p', row.pkg] }
        installState.log.push(`\n[${row.id}] ${command.tool} ${command.args.join(' ')}`)
        try {
          const result = command.tool === 'pio'
            ? await runPio(command.args, { timeoutMs: 900_000, maxOutputBytes: 200_000 })
            : await runPython(command.args, { timeoutMs: 900_000, maxOutputBytes: 200_000 })
          installState.log.push(tail(clean(`${result.stdout}\n${result.stderr}`), 4000))
          installState.results.set(row.id, compact({ status: result.ok === true ? 'done' : 'failed', durationMs: result.durationMs, detail: result.ok === true ? undefined : tail(clean(`${result.stdout}\n${result.stderr}`), 500) }))
          if (row.kind === 'pip') forgetPorts()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          installState.log.push(message)
          installState.results.set(row.id, { status: 'failed', detail: message })
        }
      }
      installState.running = false
      installState.finishedAt = Date.now()
    })()
    return { ok: true, ...installSnapshot() }
  }

  /** Wait a window and fail if the pattern appears in new output. */

  async function absentOp({ port, pattern, withinMs = 3000, baud }) {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      throw new Error('`pattern` must be a non-empty regular expression')
    }
    let matcher
    try {
      matcher = new RegExp(pattern)
    } catch (error) {
      throw new Error(`invalid regular expression ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const chosenPort = port || selectPort(undefined)
    const state = monitorState(chosenPort)
    if (state?.running !== true) {
      const started = await startMonitor({ port: chosenPort, baud, reset: 'none' })
      if (started.open !== true) throw new Error(started.error ?? `serial port ${chosenPort} is not open`)
    }
    await setOffset(chosenPort, logSize(chosenPort), 'test')
    const limit = Math.max(100, Math.min(Number(withinMs) || 3000, 120_000))
    const deadline = Date.now() + limit
    let text = ''
    while (Date.now() < deadline) {
      const chunk = await readMonitor({ port: chosenPort, maxBytes: 65536, consumer: 'test' })
      if (chunk.text !== '') text += chunk.text
      if (matcher.test(text)) {
        return { ok: false, line: text.split('\n').find((entry) => matcher.test(entry)), text: tail(text, 8000) }
      }
      if (chunk.bytes === 0) await sleep(120)
    }
    return { ok: true, text: tail(text, 8000) }
  }

  /**
   * Run a project's board-tests.json: flash, wait for boot, poke commands and
   * assert what comes back. One call gives a pass/fail table an agent (or CI)
   * can act on, and the report is kept under .board-lab/runs/<time>/.
   */
  async function testOp({ project, env, port, file, baud, continueOnFailure = false }) {
    const dir = projectDir(project)
    const scenarioPath = typeof file === 'string' && file.trim() !== ''
      ? (isAbsolute(file) ? file : resolvePath(dir, file))
      : join(dir, 'board-tests.json')
    if (!existsSync(scenarioPath)) throw new Error(`No test scenario at ${scenarioPath}: create board-tests.json with a "steps" array.`)
    let scenario
    try {
      scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'))
    } catch (error) {
      throw new Error(`board-tests.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const steps = Array.isArray(scenario?.steps) ? scenario.steps : []
    if (steps.length === 0) {
      throw new Error('The scenario has no "steps". Each step is {"flash":{}}, {"watch":{"pattern":"READY"}}, {"write":{"text":"PING"}}, {"absent":{"pattern":"Guru"}}, {"reset":{}} or {"sleep":{"ms":500}}.')
    }
    let chosenPort = typeof port === 'string' && port.trim() !== '' ? port.trim() : undefined
    const started = Date.now()
    const results = []
    const transcript = []
    let failed = false
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      const action = Object.keys(step ?? {})[0]
      const options = step?.[action] ?? {}
      const stepStarted = Date.now()
      let outcome
      try {
        if (action === 'flash') {
          const result = await flashOp({ project: options.project ?? project, env: options.env ?? env, port: chosenPort ?? options.port, protocol: options.protocol })
          if (result.port !== undefined) chosenPort = result.port
          outcome = { ok: result.ok === true, detail: result.summary, text: result.output }
        } else if (action === 'build') {
          const result = await buildOp({ project: options.project ?? project, env: options.env ?? env })
          outcome = { ok: result.ok === true, detail: result.summary, text: result.output }
        } else if (action === 'watch') {
          const result = await watchOp({
            port: chosenPort,
            pattern: options.pattern,
            timeoutMs: options.timeoutMs ?? 15_000,
            baud: options.baud ?? baud,
            fromStart: options.fromStart === true,
            // A device answers an instant command before the next step starts, so
            // watch the recent tail: a write→PONG answer and the boot banner that
            // appears while a flash step is still returning both land there, while
            // an 8 MiB history of READY lines stays out of reach.
            fromOffset: chosenPort === undefined ? undefined : Math.max(0, logSize(chosenPort) - 65536),
          })
          outcome = {
            ok: result.matched === true,
            detail: result.matched === true ? `matched ${JSON.stringify(result.line ?? '')}` : `no match for ${options.pattern} in ${result.timeoutMs} ms`,
            text: result.text,
          }
        } else if (action === 'absent') {
          const result = await absentOp({ port: chosenPort, pattern: options.pattern, withinMs: options.withinMs ?? 3000, baud: options.baud ?? baud })
          outcome = {
            ok: result.ok === true,
            detail: result.ok === true ? `no ${JSON.stringify(options.pattern)}` : `unexpected ${JSON.stringify(result.line ?? '')}`,
            text: result.text,
          }
        } else if (action === 'write') {
          const result = await writeOp({ port: chosenPort, text: options.text, lineEnding: options.lineEnding })
          outcome = { ok: result.ok === true, detail: `wrote ${JSON.stringify(options.text)}` }
        } else if (action === 'reset') {
          const result = await resetOp({ port: chosenPort })
          outcome = { ok: result.ok === true, detail: 'reset' }
        } else if (action === 'sleep') {
          const ms = Math.max(0, Math.min(Number(options.ms ?? 1000) || 1000, 60_000))
          await sleep(ms)
          outcome = { ok: true, detail: `waited ${ms} ms` }
        } else {
          throw new Error(`unknown step ${JSON.stringify(action)}; use flash|build|watch|write|absent|reset|sleep`)
        }
      } catch (error) {
        outcome = { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
      const durationMs = Date.now() - stepStarted
      results.push(compact({
        step: index + 1,
        action,
        ok: outcome.ok === true,
        durationMs,
        detail: outcome.detail,
        text: outcome.text === undefined ? undefined : tail(outcome.text, 4000),
      }))
      transcript.push(`[${outcome.ok === true ? 'ok' : 'FAIL'}] ${index + 1} ${action} (${durationMs} ms) ${outcome.detail ?? ''}`)
      if (typeof outcome.text === 'string' && outcome.text !== '') transcript.push(outcome.text)
      if (outcome.ok !== true) {
        failed = true
        if (continueOnFailure !== true) break
      }
    }
    const ok = failed === false && results.length === steps.length
    const runId = new Date().toISOString().replace(/[:.]/g, '-')
    const runDir = join(stateRoot, 'runs', runId)
    let run
    try {
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, 'report.json'), JSON.stringify({
        name: scenario?.name,
        project: projectLabel(dir),
        env,
        port: chosenPort,
        ok,
        durationMs: Date.now() - started,
        steps: results,
      }, null, 2))
      writeFileSync(join(runDir, 'uart.log'), transcript.join('\n'))
      run = runDir
    } catch {
      // reports are best effort
    }
    return compact({
      ok,
      name: scenario?.name,
      project: projectLabel(dir),
      port: chosenPort,
      durationMs: Date.now() - started,
      steps: results,
      run,
    })
  }

  /** Symbolize a panic; reads the monitor log when no text is passed. */
  async function decodeOp({ project, env, text, port, elf }) {
    let source = typeof text === 'string' ? text : ''
    if (source.trim() === '') {
      if (port === undefined || port === '') throw new Error('Pass `text` (a captured log) or `port` (so the monitor log can be read).')
      source = readLogRange({ port, fromStart: true, maxBytes: 1 << 20 }).text
    }
    return decodeText({ project, env, text: source, port, elf })
  }

  // --------------------------------------------------------------------- tools

  const definitions = [
    {
      name: 'board_ports',
      description:
        'List attached serial ports and USB-UART adapters (path, by-id, vendor/product). Use it when no port is auto-detected or to confirm the board is connected.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ports'],
          properties: {
            ports: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['path'],
                properties: {
                  path: { type: 'string' },
                  byId: { type: 'string' },
                  vendorId: { type: 'string' },
                  productId: { type: 'string' },
                  driver: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.ports.length === 0
            ? 'No serial ports attached.'
            : value.ports
              .map((port) => `${port.path}${port.byId ? ` (${port.byId})` : ''}${port.vendorId ? ` usb ${port.vendorId}:${port.productId ?? '?'}` : ''}`)
              .join('\n'),
        }],
      },
      async execute() {
        return { ports: attachedPorts() }
      },
    },
    {
      name: 'board_build',
      description:
        'Build a firmware project with PlatformIO (ESP32/ESP32-S3) or make (AT32). Returns success, exit code, duration, RAM/Flash usage and the output tail.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['project'],
        properties: { project: PROJECT_PARAM, env: ENV_PARAM },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'exitCode', 'durationMs', 'summary', 'output'],
          properties: {
            ok: { type: 'boolean' },
            exitCode: { type: 'integer' },
            durationMs: { type: 'integer' },
            summary: { type: 'string' },
            output: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `${value.summary}\n\n${value.output}` }],
      },
      async execute(args) {
        return buildOp({
          project: args.project,
          env: typeof args.env === 'string' && args.env.trim() !== '' ? args.env.trim() : undefined,
        })
      },
    },
    {
      name: 'board_flash',
      description:
        'Flash a firmware project over the serial port (PlatformIO upload / esptool for ESP32, `make flash` for AT32). `project` may be omitted: the port is matched to a project from a previous flash, or identified with esptool and matched against the platformio.ini board families — ambiguity is refused rather than guessed. Any running monitor is stopped for the upload and restarted afterwards, so the new firmware boot log is captured. Build first when the image may be stale.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { ...PROJECT_PARAM, description: 'Firmware project directory — absolute, or relative to the workspace root. Omit to detect from the connected board.' },
          env: ENV_PARAM,
          port: PORT_PARAM,
          protocol: {
            type: 'string',
            description: 'Upload protocol override (esptool, jlink, stlink, cmsis-dap, dfu, serial). Omit to use the project setting.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'exitCode', 'durationMs', 'summary', 'output'],
          properties: {
            ok: { type: 'boolean' },
            exitCode: { type: 'integer' },
            durationMs: { type: 'integer' },
            summary: { type: 'string' },
            output: { type: 'string' },
            port: { type: 'string' },
            monitor: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `${value.summary}\n\n${value.output}` }],
      },
      async execute(args) {
        return flashOp({
          project: args.project,
          env: typeof args.env === 'string' && args.env.trim() !== '' ? args.env.trim() : undefined,
          port: typeof args.port === 'string' && args.port.trim() !== '' ? args.port.trim() : undefined,
          protocol: typeof args.protocol === 'string' && args.protocol.trim() !== '' ? args.protocol.trim() : undefined,
        })
      },
    },
    {
      name: 'board_project',
      description:
        'The current firmware project: status shows the pinned project and its board/environments, list shows every project with the current one marked, select pins one (the panel and a project-less `board_flash` then use it), open reveals its folder in the desktop file manager — drop libraries into `lib/` there. Use select before flashing when several projects target the same board and the user means a specific one.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'list', 'select', 'open'],
            description: 'status — current project; list — all projects; select — pin one; open — show its folder.',
          },
          project: { ...PROJECT_PARAM, description: 'Project directory for select/open — absolute, or relative to the workspace root.' },
          env: { ...ENV_PARAM, description: 'PlatformIO environment for the project (select). Omit to use its default env.' },
          target: {
            type: 'string',
            enum: ['root', 'lib', 'src'],
            description: 'Folder to open (open): the project root by default, or its lib/ (created) or src/.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            current: {
              type: 'object',
              properties: {
                project: { type: 'string' },
                name: { type: 'string' },
                path: { type: 'string' },
                dir: { type: 'string' },
                kind: { type: 'string' },
                env: { type: 'string' },
                board: { type: 'string' },
                envs: { type: 'array', items: { type: 'string' } },
                families: { type: 'array', items: { type: 'string' } },
              },
            },
            projects: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'path', 'kind'],
                properties: {
                  name: { type: 'string' },
                  path: { type: 'string' },
                  kind: { type: 'string' },
                  board: { type: 'string' },
                  families: { type: 'array', items: { type: 'string' } },
                  current: { type: 'boolean' },
                },
              },
            },
            path: { type: 'string' },
            target: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.current !== undefined) {
            const board = value.current.board === undefined ? '' : ` · board ${value.current.board}`
            const env = value.current.env === undefined ? '' : ` · env ${value.current.env}`
            const text = `current: ${value.current.path}${board}${env}\n${value.current.dir}`
            return [{ type: 'text', text: value.projects === undefined ? text : `${text}\n\n${value.projects.map((p) => `${p.current === true ? '*' : ' '} ${p.path} (${p.kind})`).join('\n')}` }]
          }
          if (value.projects !== undefined) {
            return [{ type: 'text', text: value.projects.map((p) => `${p.current === true ? '*' : ' '} ${p.path} (${p.kind})`).join('\n') }]
          }
          return [{ type: 'text', text: value.path === undefined ? 'no current project' : `opened ${value.path}` }]
        },
      },
      async execute(args) {
        const action = String(args.action ?? 'status')
        if (action === 'status') return compact({ ok: true, current: currentProject() })
        if (action === 'list') {
          const current = currentProject()
          const projects = listProjects().map((item) => {
            const summary = projectSummary(item.path)
            return compact({
              name: item.name,
              path: item.path,
              kind: item.kind,
              board: summary.envs.find((env) => env.default === true)?.board ?? summary.envs[0]?.board,
              families: summary.families,
              current: current?.project === item.path,
            })
          })
          return compact({ ok: true, current, projects })
        }
        if (action === 'select') {
          return compact({ ok: true, current: selectProject({ project: args.project, env: typeof args.env === 'string' && args.env.trim() !== '' ? args.env.trim() : undefined }) })
        }
        if (action === 'open') {
          const opened = openFolder({
            project: typeof args.project === 'string' && args.project.trim() !== '' ? args.project : undefined,
            target: typeof args.target === 'string' ? args.target : 'root',
          })
          return compact({ ok: true, current: currentProject(), path: opened.path, target: opened.target })
        }
        throw new Error(`Unknown action "${action}"; use status, list, select or open.`)
      },
    },
    {
      name: 'board_checkpoint',
      description:
        'Snapshots of the current firmware project, source only: build output, `.git` and the toolchain cache are left out. create saves the project as it is now, list shows snapshots newest first, restore puts the tree back exactly as it was in a snapshot (files added since are deleted), delete drops one. Restore takes a "before restore" snapshot first, so a wrong restore is itself undoable. Take a checkpoint before a risky edit; when the device behaves worse, one restore brings the working tree back.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'list', 'restore', 'delete'],
            description: 'create — snapshot now; list — snapshots with time, label and size; restore — put the tree back; delete — drop a snapshot.',
          },
          project: { ...PROJECT_PARAM, description: 'Project to snapshot (create); defaults to the current project.' },
          label: { type: 'string', description: 'A short note shown in the panel, for example "touch works".' },
          id: { type: 'string', description: 'Snapshot id for restore/delete, from create or list.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            action: { type: 'string' },
            checkpoint: CHECKPOINT_SCHEMA,
            checkpoints: { type: 'array', items: CHECKPOINT_SCHEMA },
          },
        },
        render: (_args, value) => {
          const line = (item) => {
            const when = item.createdAt === undefined ? '' : new Date(item.createdAt).toLocaleString()
            const label = item.label === undefined ? '' : ` · ${item.label}`
            return `${item.id} · ${when}${label} · ${item.project} · ${item.files} file(s), ${Math.round((item.bytes ?? 0) / 1024)} KB`
          }
          if (value.checkpoint !== undefined) {
            const restored = value.checkpoint.restoredAt === undefined ? '' : `\nrestored over ${value.checkpoint.dir}`
            const guard = value.checkpoint.guard === undefined ? '' : `\nprevious state kept as ${value.checkpoint.guard}`
            return [{ type: 'text', text: `${line(value.checkpoint)}${restored}${guard}` }]
          }
          const items = value.checkpoints ?? []
          return [{ type: 'text', text: items.length === 0 ? 'no checkpoints yet' : items.map(line).join('\n') }]
        },
      },
      async execute(args) {
        const action = String(args.action ?? 'list')
        if (action === 'list') return compact({ ok: true, action, checkpoints: checkpointList() })
        if (action === 'create') {
          return compact({
            ok: true,
            action,
            checkpoint: checkpointCreate({
              project: typeof args.project === 'string' && args.project.trim() !== '' ? args.project.trim() : undefined,
              label: typeof args.label === 'string' ? args.label : undefined,
            }),
          })
        }
        if (action === 'restore' || action === 'delete') {
          const id = typeof args.id === 'string' && args.id !== '' ? args.id : undefined
          if (id === undefined) throw new Error(`action "${action}" needs the \`id\` of a checkpoint: run action "list" to see them.`)
          const checkpoint = action === 'restore' ? checkpointRestore({ id }) : checkpointDelete({ id })
          return compact({ ok: true, action, checkpoint, checkpoints: checkpointList() })
        }
        throw new Error(`Unknown action "${action}"; use create, list, restore or delete.`)
      },
    },
    {
      name: 'board_maps',
      description:
        'The board map: the pins of a board or a chip (from the plugin\'s maps/ folder) and what is wired to them for the current project (`.board-lab/wiring.json`, the same data the panel shows). get answers "which pin is the buzzer on" and "is GPIO4 free"; set records a connection by pin name, or by pin number when one name sits on several pins; draft proposes connections from the project source (`#define DIO 4`, `const int LED = 2`), never overwriting a pin that already has a label; save composes a map in place. A chip is saved as `package` plus `pins`: the datasheet pin table in physical order, index 0 is pin 1, names only — the renderer cuts the outline into sides and numbers the pins counter-clockwise, so there are no coordinates to place. `funcs` adds the alternate functions of a pin by number (USART1_TX, TIM1_CH2); they show up on hover and in the pin table. A board with two pin headers is saved as `sides`, pins in the order they sit on the header. Pin tables are repo files under maps/: change them through save, so the layout ships with the plugin.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'set', 'draft', 'save'],
            description: 'list — maps and the current one; get — pins plus wiring; set — record or clear a connection; draft — fill empty pins from the source; save — compose a board map.',
          },
          project: { ...PROJECT_PARAM, description: 'Project whose wiring to use; defaults to the current project.' },
          board: { type: 'string', description: 'Map id from action "list", for example esp32-s3-devkitc-1. Omit to use the board already chosen for the project.' },
          pin: { type: 'string', description: 'Pin name for set, exactly as the map spells it (GPIO4, D4, PA5).' },
          label: { type: 'string', description: 'What is wired to the pin, for example "TM1637 DIO". Empty string clears the pin.' },
          id: { type: 'string', description: 'Map id for save: lowercase letters, digits, dot, dash, e.g. "arduino-nano-v3".' },
          name: { type: 'string', description: 'Human name for save, e.g. "Arduino Nano v3".' },
          aliases: {
            type: 'array',
            items: { type: 'string' },
            description: 'PlatformIO board ids for save, matched as substrings of env.board, e.g. ["nano", "atmega328p"].',
          },
          note: { type: 'string', description: 'One line shown under the map, e.g. "LQFP48, читано по DS5319 table 4".' },
          verified: { type: 'boolean', description: 'save: true when the pin order was read off the real board (default true).' },
          package: {
            type: 'object',
            additionalProperties: false,
            description: 'save: the outline of a chip — the renderer derives every pin position from the kind and the pin count.',
            properties: {
              kind: { type: 'string', enum: ['qfp', 'qfn', 'dip', 'soic', 'tssop'], description: 'qfp/qfn are four-sided, dip/soic/tssop two-sided.' },
            },
          },
          pins: {
            type: 'array',
            items: { type: 'string' },
            description: 'save: a chip\'s pin names in physical order — index 0 is pin 1, so the count is the pin count of the package. Copy the datasheet pin table: names only, no coordinates. The pin number (1…N) is the key wiring stores, so four GND pins stay four different pins.',
          },
          funcs: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' } },
            description: 'save: what a pin can do, keyed by pin number ("12": ["USART1_TX", "TIM1_CH2"]) — the alternate-function column of the datasheet. Sparse: only pins that have functions need an entry. Shown on hover and in the pin table, so a wrong number is visible at once.',
          },
          draw: {
            type: 'array',
            description: 'save: a board drawn as plain shapes, for a board nobody has a pin table for — a sketch with chips, connectors and silk text.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'x', 'y'],
              properties: {
                type: { type: 'string', enum: ['rect', 'text'] },
                x: { type: 'number', description: '0 (left edge) … 1 (right edge).' },
                y: { type: 'number', description: '0 (top edge) … 1 (bottom edge).' },
                w: { type: 'number', description: 'rect: width as a share of the drawing.' },
                h: { type: 'number', description: 'rect: height as a share of the drawing.' },
                label: { type: 'string', description: 'rect: silkscreen text in the middle, e.g. "ESP32-S3".' },
                text: { type: 'string', description: 'text: the words to draw.' },
                size: { type: 'number', description: 'text: font size 4…40 in a 1000-unit drawing.' },
                fill: { type: 'string', enum: ['board', 'chip', 'metal', 'accent', 'hole'] },
              },
            },
          },
          pads: {
            type: 'array',
            description: 'save: where a pin sits on a hand-drawn board (draw), as shares of the drawing\'s width and height.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['pin', 'x', 'y'],
              properties: {
                pin: { type: 'string' },
                x: { type: 'number', description: '0 (left edge) … 1 (right edge).' },
                y: { type: 'number', description: '0 (top edge) … 1 (bottom edge).' },
              },
            },
          },
          sides: {
            type: 'object',
            additionalProperties: false,
            description: 'save: pins per side, in the order they sit on the board.',
            properties: {
              top: { type: 'array', items: { type: 'string' } },
              bottom: { type: 'array', items: { type: 'string' } },
              left: { type: 'array', items: { type: 'string' } },
              right: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            action: { type: 'string' },
            project: { type: 'string' },
            board: { type: 'string' },
            count: { type: 'integer' },
            applied: { type: 'integer' },
            skipped: { type: 'integer' },
            pins: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['pin'],
                properties: {
                  pin: { type: 'string' },
                  name: { type: 'string' },
                  label: { type: 'string' },
                  source: { type: 'string' },
                  func: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            maps: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'name'],
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  verified: { type: 'boolean' },
                  current: { type: 'boolean' },
                  pins: { type: 'integer' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const lines = []
          if (value.maps !== undefined) {
            for (const map of value.maps) {
              const mark = map.current === true ? ' ← current' : ''
              const verified = map.verified === false ? ' (layout not checked yet)' : ''
              const stub = map.pins === 0 ? ' · no pins yet' : ''
              lines.push(`${map.id} · ${map.name}${stub}${verified}${mark}`)
            }
          }
          if (value.board !== undefined && value.pins !== undefined) {
            lines.push(`board ${value.board} · ${value.pins.length} pin(s) used`)
            for (const pin of value.pins) lines.push(`  ${pin.pin}${pin.name === undefined ? '' : ` ${pin.name}`} → ${pin.label}${pin.source === 'code' ? ' (from source)' : ''}`)
          }
          if (value.applied !== undefined) lines.push(`drafted ${value.applied} connection(s), ${value.skipped ?? 0} already labelled`)
          return [{ type: 'text', text: lines.length === 0 ? 'no board maps installed' : lines.join('\n') }]
        },
      },
      async execute(args) {
        const action = String(args.action ?? 'list')
        const project = typeof args.project === 'string' && args.project.trim() !== '' ? args.project.trim() : undefined
        const board = typeof args.board === 'string' && args.board.trim() !== '' ? args.board.trim() : undefined
        if (action === 'list') {
          const wiring = wiringGet({ project })
          const maps = boardMaps().map((map) => ({
            id: map.id, name: map.name, verified: map.verified !== false,
            current: map.id === wiring.board, pins: pinList(map).length,
          }))
          return compact({ ok: true, action, board: wiring.board, project: wiring.project, maps })
        }
        if (action === 'get') {
          const wiring = wiringGet({ project })
          const map = findMap(board) ?? wiring.map
          if (map === undefined) throw new Error('No board map matched: pass `board` from action "list".')
          return compact({
            ok: true, action, project: wiring.project, board: map.id,
            pins: pinReport(map, wiring.pins), count: pinList(map).length,
          })
        }
        if (action === 'set') {
          const wiring = wiringSet({ project, board: board ?? wiringGet({ project }).board, pin: args.pin, label: args.label })
          const map = findMap(wiring.board)
          return compact({ ok: true, action, project: wiring.project, board: wiring.board, pins: pinReport(map, wiring.pins) })
        }
        if (action === 'draft') {
          const result = wiringDraft({ project, board })
          const map = findMap(result.board)
          return compact({ ok: true, action, project: result.project, board: result.board, applied: result.applied, skipped: result.skipped, pins: pinReport(map, result.pins) })
        }
        if (action === 'save') {
          const map = saveMap({
            id: args.id,
            name: args.name,
            aliases: args.aliases,
            sides: args.sides,
            note: args.note,
            verified: args.verified,
            package: args.package,
            pins: args.pins,
            funcs: args.funcs,
            pads: args.pads,
            draw: args.draw,
          })
          let wiring
          try {
            wiring = wiringBoard({ project, board: map.id })
          } catch {
            wiring = wiringGet({ project })
          }
          const maps = boardMaps().map((item) => ({ id: item.id, name: item.name, verified: item.verified !== false, current: item.id === wiring.board }))
          return compact({ ok: true, action, project: wiring.project, board: wiring.board, maps })
        }
        throw new Error(`Unknown action "${action}"; use list, get, set, draft or save.`)
      },
    },
    {
      name: 'board_monitor',
      description:
        'Persistent UART monitor. action=start keeps the port open in a detached process and captures everything the device prints; action=read returns only new output since the previous read (peek does not advance, fromStart reads the whole log); action=stop closes it; action=status lists monitors. Reading does not reset the board, so boot logs survive between calls. Pass `lines` to get just the tail of the new output — the usual way to look at a log after a change.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['start', 'read', 'stop', 'status'] },
          port: PORT_PARAM,
          baud: { type: 'integer', description: 'Baud rate; defaults to 115200.' },
          reset: { type: 'string', enum: ['none', 'esp'], description: 'Reset pulse on start; defaults to esp.' },
          fromStart: { type: 'boolean', description: 'read: return the whole log from offset 0.' },
          peek: { type: 'boolean', description: 'read: do not advance the stored offset.' },
          maxBytes: { type: 'integer', description: 'read: cap the returned bytes (default 65536).' },
          lines: { type: 'integer', description: 'read: keep only the last N lines of the new output (the cursor still advances past everything).' },
          waitMs: { type: 'integer', description: 'read: wait up to this many ms for new output before answering (default 0).' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            action: { type: 'string' },
            port: { type: 'string' },
            baud: { type: 'integer' },
            running: { type: 'boolean' },
            open: { type: 'boolean' },
            stale: { type: 'boolean' },
            reused: { type: 'boolean' },
            stopped: { type: 'boolean' },
            log: { type: 'string' },
            startedAt: { type: 'number' },
            text: { type: 'string' },
            bytes: { type: 'integer' },
            totalBytes: { type: 'integer' },
            nextOffset: { type: 'integer' },
            pendingBytes: { type: 'integer' },
            startOffset: { type: 'integer' },
            droppedLines: { type: 'integer' },
            monitors: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  port: { type: 'string' },
                  baud: { type: 'integer' },
                  running: { type: 'boolean' },
                  open: { type: 'boolean' },
                  stale: { type: 'boolean' },
                  error: { type: 'string' },
                },
              },
            },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.action === 'read') {
            const skipped = Number.isInteger(value.droppedLines) && value.droppedLines > 0
              ? `\n\n(${value.droppedLines} earlier line${value.droppedLines === 1 ? '' : 's'} skipped — read again with fromStart to see them)`
              : ''
            if (value.text !== '') {
              // Bytes read from a stopped monitor come from the log file, not
              // from a live device: say so instead of letting them pass for the
              // current output of the board.
              if (value.running === false) {
                return [{ type: 'text', text: `${value.text}${skipped}\n\n(monitor is not running — this is buffered output from the log; start it again to capture more)` }]
              }
              return [{ type: 'text', text: `${value.text}${skipped}` }]
            }
            if (value.running === false) {
              return [{ type: 'text', text: `(no new output on ${value.port} — the monitor is not running; start it again to capture more)` }]
            }
            return [{ type: 'text', text: `(no new output on ${value.port})` }]
          }
          if (value.action === 'status') {
            if (value.monitors.length === 0) return [{ type: 'text', text: 'No monitors.' }]
            return [{
              type: 'text',
              text: value.monitors
                .map((item) => `${item.port} @ ${item.baud ?? '?'} ${item.running ? 'running' : 'stopped'}${item.stale ? ' (stale state)' : ''}`)
                .join('\n'),
            }]
          }
          if (value.action === 'stop') {
            return [{ type: 'text', text: value.stopped === true ? `stopped ${value.port}` : `nothing was running on ${value.port}` }]
          }
          if (value.ok === false) {
            return [{ type: 'text', text: `start ${value.port}: failed — ${value.error ?? 'unknown error'}` }]
          }
          return [{ type: 'text', text: `start ${value.port}: running${value.reused ? ' (reused)' : ''}` }]
        },
      },
      async execute(args) {
        if (args.action === 'status') {
          return { ok: true, action: 'status', monitors: listMonitors() }
        }
        const port = selectPort(args.port)
        if (args.action === 'start') {
          const started = await startMonitor({ port, baud: args.baud, reset: args.reset === 'none' ? 'none' : 'esp' })
          return compact({ ok: started.open === true, action: 'start', ...started })
        }
        if (args.action === 'read') {
          const waitMs = Number.isInteger(args.waitMs) ? Math.min(args.waitMs, 60_000) : 0
          const deadline = Date.now() + waitMs
          let chunk = await readMonitor({ port, fromStart: args.fromStart === true, peek: args.peek === true, maxBytes: args.maxBytes })
          while (waitMs > 0 && chunk.bytes === 0 && Date.now() < deadline) {
            await sleep(150)
            chunk = await readMonitor({ port, fromStart: args.fromStart === true, peek: args.peek === true, maxBytes: args.maxBytes })
          }
          if (Number.isInteger(args.lines) && args.lines >= 1) {
            chunk = lastLines(chunk, args.lines)
          }
          return compact({ ok: true, action: 'read', ...chunk })
        }
        if (args.action === 'stop') {
          const stopped = await stopMonitor(port)
          return compact({ ok: true, action: 'stop', port, running: false, stopped })
        }
        throw new Error(`unknown monitor action ${String(args.action)}`)
      },
    },
    {
      name: 'board_write',
      description:
        'Send a line to the device over the monitor\'s serial connection (starts the monitor if needed). Use it to answer prompts, send commands such as PING, or drive a test harness.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'Text to send.' },
          port: PORT_PARAM,
          newline: { type: 'boolean', description: 'Append \\n; defaults to true.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'port'],
          properties: {
            ok: { type: 'boolean' },
            port: { type: 'string' },
            bytes: { type: 'integer' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `sent to ${value.port}` }],
      },
      async execute(args) {
        return writeOp({
          port: args.port,
          text: args.text,
          newline: args.newline !== false,
        })
      },
    },
    {
      name: 'board_cycle',
      description:
        'Closed loop in one call: build, flash, then start the monitor and collect the UART output for durationMs (or until untilPattern matches). Returns the build/flash verdicts and the captured text. The monitor stays running afterwards, so later board_monitor read calls return more output.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['project'],
        properties: {
          project: PROJECT_PARAM,
          env: ENV_PARAM,
          port: PORT_PARAM,
          baud: { type: 'integer' },
          durationMs: { type: 'integer', description: 'How long to collect after flashing; defaults to 4000.' },
          untilPattern: { type: 'string', description: 'Regex that ends the collection early.' },
          reset: { type: 'string', enum: ['none', 'esp'] },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'build', 'flash', 'uart'],
          properties: {
            ok: { type: 'boolean' },
            build: {
              type: 'object',
              additionalProperties: false,
              required: ['ok', 'summary', 'output', 'exitCode', 'durationMs'],
              properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, output: { type: 'string' }, exitCode: { type: 'integer' }, durationMs: { type: 'integer' } },
            },
            flash: {
              type: 'object',
              additionalProperties: false,
              required: ['ok', 'summary', 'output', 'exitCode', 'durationMs'],
              properties: {
                ok: { type: 'boolean' },
                summary: { type: 'string' },
                output: { type: 'string' },
                exitCode: { type: 'integer' },
                durationMs: { type: 'integer' },
                port: { type: 'string' },
                monitor: { type: 'string' },
              },
            },
            uart: {
              type: 'object',
              additionalProperties: false,
              required: ['ok', 'text', 'matched'],
              properties: {
                ok: { type: 'boolean' },
                port: { type: 'string' },
                text: { type: 'string' },
                matched: { type: 'array', items: { type: 'string' } },
                running: { type: 'boolean' },
                error: { type: 'string' },
              },
            },
          },
        },
        render: (args, value) => [{
          type: 'text',
          text: [
            value.build.summary,
            value.flash.summary,
            value.uart.ok
              ? `UART ${value.uart.text.length > 0 ? 'captured' : 'empty'}${
                value.uart.matched.length > 0
                  ? ` · matched ${value.uart.matched.join(' | ')}`
                  // Silence about the pattern is what made a timed-out cycle look
                  // like a successful wait: name the miss and the window.
                  : typeof args.untilPattern === 'string' && args.untilPattern !== ''
                    ? ` · /${args.untilPattern}/ did not match within ${Number.isInteger(args.durationMs) ? args.durationMs : 4000} ms`
                    : ''
              }`
              : `UART failed: ${value.uart.error ?? 'unknown error'}`,
            '',
            value.uart.text,
          ].join('\n'),
        }],
      },
      async execute(args) {
        return cycleOp({
          project: args.project,
          env: typeof args.env === 'string' && args.env.trim() !== '' ? args.env.trim() : undefined,
          port: args.port,
          baud: args.baud,
          durationMs: args.durationMs,
          untilPattern: args.untilPattern,
          reset: args.reset,
        })
      },
    },
    {
      name: 'board_watch',
      description:
        'Wait until new UART output matches a regular expression (for example "READY|panic|Guru Meditation"). Only output produced after the call is considered, so a line left over from an earlier boot cannot match; pass fromStart to search the whole log. Starts the monitor if needed, polls until the pattern appears or timeoutMs elapses, and returns the matching line plus the captured tail. When the match is a panic, the addresses are symbolized against the project ELF and returned in `decode`. This is the "flash, then wait for boot" primitive.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['pattern'],
        properties: {
          pattern: { type: 'string', description: 'Regular expression tested against new output.' },
          port: PORT_PARAM,
          baud: { type: 'integer', description: 'Baud rate used when the monitor has to be started.' },
          timeoutMs: { type: 'integer', description: 'How long to wait; defaults to 15000, max 120000.' },
          fromStart: { type: 'boolean', description: 'Search the whole log, not only output produced after this call.' },
          project: { ...PROJECT_PARAM, description: 'Project whose ELF symbolizes a panic; omit to use the project remembered for this port.' },
          env: ENV_PARAM,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'port', 'pattern', 'matched', 'text', 'timeoutMs', 'open'],
          properties: {
            ok: { type: 'boolean' },
            port: { type: 'string' },
            pattern: { type: 'string' },
            matched: { type: 'boolean' },
            line: { type: 'string' },
            text: { type: 'string' },
            timeoutMs: { type: 'integer' },
            open: { type: 'boolean' },
            panic: { type: 'boolean' },
            decode: DECODE_SCHEMA,
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.matched
            ? `matched /${value.pattern}/ on ${value.port}: ${value.line ?? ''}\n\n${value.text}${value.decode?.ok === true ? `\n\ndecoded: ${value.decode.summary}\n${(value.decode.frames ?? []).join('\n')}` : ''}`
            : `no match for /${value.pattern}/ on ${value.port} within ${value.timeoutMs} ms${value.open ? '' : ' (monitor is not open)'}\n\n${value.text}`,
        }],
      },
      async execute(args) {
        return watchOp({
          port: args.port,
          pattern: args.pattern,
          timeoutMs: args.timeoutMs,
          baud: args.baud,
          fromStart: args.fromStart === true,
          project: args.project,
          env: args.env,
        })
      },
    },
    {
      name: 'board_info',
      description:
        'Identify the attached ESP32 with esptool flash_id (chip, flash size, MAC). Stops the monitor for the probe, then restarts it with a reset pulse and baselines the offset, so the next board_monitor read is the boot log. Use it to catch a 4 MB module with an 8 MB partition table before flashing.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          port: PORT_PARAM,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'exitCode', 'durationMs', 'summary', 'output'],
          properties: {
            ok: { type: 'boolean' },
            exitCode: { type: 'integer' },
            durationMs: { type: 'integer' },
            summary: { type: 'string' },
            output: { type: 'string' },
            port: { type: 'string' },
            chip: { type: 'string' },
            flashSize: { type: 'string' },
            mac: { type: 'string' },
            psram: { type: 'string' },
            revision: { type: 'string' },
            monitor: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.ok
            ? `${value.port}: ${value.chip ?? 'unknown chip'}${value.revision ? ` (${value.revision})` : ''}, flash ${value.flashSize ?? 'unknown'}${value.psram ? `, PSRAM ${value.psram}` : ''}${value.mac ? `, MAC ${value.mac}` : ''}`
            : value.summary,
        }],
      },
      async execute(args) {
        return infoOp({ port: args.port })
      },
    },
    {
      name: 'board_decode',
      description:
        'Symbolize an ESP32 panic dump: finds `Guru Meditation Error`, `abort() was called at PC`, `assert failed`, `PC:` and `Backtrace:` addresses, resolves them with the PlatformIO addr2line for the project chip, and returns the exception, core and readable frames. The ELF and its build time are reported, so a stack trace is never matched against a stale binary. Pass `text`, or `port` to read the monitor log.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'Captured panic log; omit to read the monitor log for `port`.' },
          project: { ...PROJECT_PARAM, description: 'Project whose ELF to use; omit to use the project remembered for the port.' },
          env: ENV_PARAM,
          port: PORT_PARAM,
          elf: { type: 'string', description: 'Explicit ELF path override (absolute or workspace-relative).' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'summary', 'frames'],
          properties: { ...DECODE_SCHEMA.properties },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.ok
            ? `${value.summary}\n\n${(value.frames ?? []).join('\n')}\n\nelf: ${value.elf}${value.elfModified ? ` (built ${value.elfModified})` : ''}`
            : `decode failed: ${value.summary}`,
        }],
      },
      async execute(args) {
        return decodeOp({ project: args.project, env: args.env, text: args.text, port: args.port, elf: args.elf })
      },
    },
    {
      name: 'board_doctor',
      label: 'Board environment check',
      description: 'Check the machine before flashing: PlatformIO, pyserial, esptool, probe tools, ARM gcc, serial ports, workspace projects and the monitor script. Returns one row per check with the exact fix.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'summary', 'checks'],
          properties: {
            ok: { type: 'boolean' },
            summary: { type: 'string' },
            checks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'ok'],
                properties: {
                  name: { type: 'string' },
                  ok: { type: 'boolean' },
                  detail: { type: 'string' },
                  fix: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: [
            value.summary,
            ...(value.checks ?? []).map((check) => `${check.ok ? 'OK  ' : 'FAIL'} ${check.name}${check.detail === undefined ? '' : `: ${check.detail}`}${check.ok !== true && check.fix !== undefined ? `\n     fix: ${check.fix}` : ''}`),
          ].join('\n'),
        }],
      },
      async execute() {
        return doctorOp()
      },
    },
    {
      name: 'board_tools',
      label: 'Board toolchain inventory',
      description: 'Show which board toolchains this machine has (PlatformIO, pyserial, esptool, avrdude, ST-Link, OpenOCD, dfu-util, ARM GCC) and which PlatformIO platforms are installed (espressif32, atmelavr, ststm32), each with a version and the install plan. action "install" downloads the listed ids in the background; poll "status" for progress. Use it when a build or flash fails because a tool is missing.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'install', 'status'] },
          ids: { type: 'array', items: { type: 'string' } },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'tools'],
          properties: {
            ok: { type: 'boolean' },
            installed: { type: 'integer' },
            total: { type: 'integer' },
            python: { type: 'string' },
            source: { type: 'string' },
            tools: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'name', 'ok'],
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  group: { type: 'string' },
                  kind: { type: 'string' },
                  ok: { type: 'boolean' },
                  version: { type: 'string' },
                  why: { type: 'string' },
                  detail: { type: 'string' },
                },
              },
            },
            install: {
              type: 'object',
              additionalProperties: false,
              properties: {
                running: { type: 'boolean' },
                startedAt: { type: 'integer' },
                finishedAt: { type: 'integer' },
                log: { type: 'string' },
                ids: { type: 'array', items: { type: 'string' } },
                results: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'status'],
                    properties: {
                      id: { type: 'string' },
                      status: { type: 'string' },
                      durationMs: { type: 'integer' },
                      detail: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toolsText(value) }],
      },
      async execute(args) {
        const action = args.action ?? 'list'
        if (action === 'install') {
          const started = await installToolsOp({ ids: args.ids })
          return { ok: true, tools: [], installed: 0, total: 0, install: started }
        }
        return { ...(await toolInventory()), ok: true }
      },
    },
    {
      name: 'board_detect',
      description:
        'Identify a connected board and suggest the project to flash: esptool reads the chip, the project platformio.ini environments map board names to chip families, and `.board-lab/boards.json` remembers ports flashed earlier. Returns chip, flash size, PSRAM, MAC, family, candidates and a confidence; a previous monitor is restarted, one that was off stays off. `board_flash` without `project` uses the same matching.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          port: PORT_PARAM,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'ports'],
          properties: {
            ok: { type: 'boolean' },
            ports: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['path', 'confidence'],
                properties: {
                  path: { type: 'string' },
                  byId: { type: 'string' },
                  vendorId: { type: 'string' },
                  productId: { type: 'string' },
                  driver: { type: 'string' },
                  chip: { type: 'string' },
                  revision: { type: 'string' },
                  family: { type: 'string' },
                  flashSize: { type: 'string' },
                  psram: { type: 'string' },
                  mac: { type: 'string' },
                  project: { type: 'string' },
                  env: { type: 'string' },
                  confidence: { type: 'string' },
                  reason: { type: 'string' },
                  candidates: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['project'],
                      properties: {
                        project: { type: 'string' },
                        envs: { type: 'array', items: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value.ports ?? []).map((port) => {
            const facts = [
              port.path,
              port.chip,
              port.family,
              port.flashSize !== undefined ? `flash ${port.flashSize}` : undefined,
              port.psram !== undefined ? `PSRAM ${port.psram}` : undefined,
              port.mac,
            ].filter(Boolean).join(' · ')
            const guess = port.project === undefined
              ? `no project (${port.confidence})`
              : `→ ${port.project}${port.env !== undefined ? ` [${port.env}]` : ''} (${port.confidence})`
            return `${facts}\n  ${guess}${port.reason ? ` — ${port.reason}` : ''}`
          }).join('\n'),
        }],
      },
      async execute(args) {
        return detectOp({ port: args.port })
      },
    },
    {
      name: 'board_test',
      description:
        'Run a project\'s board-tests.json: steps `flash`, `build`, `watch`, `write`, `absent`, `reset`, `sleep`, executed in order with a per-step verdict, timing and matched line. Stops at the first failure unless continueOnFailure is set; writes report.json and uart.log under `.board-lab/runs/<time>/`. This is the regression check after a firmware change.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['project'],
        properties: {
          project: PROJECT_PARAM,
          env: ENV_PARAM,
          port: PORT_PARAM,
          baud: { type: 'integer', description: 'Baud rate for monitors the scenario starts.' },
          file: { type: 'string', description: 'Scenario path; defaults to board-tests.json inside the project.' },
          continueOnFailure: { type: 'boolean', description: 'Keep running steps after a failure instead of stopping.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'durationMs', 'steps'],
          properties: {
            ok: { type: 'boolean' },
            name: { type: 'string' },
            project: { type: 'string' },
            port: { type: 'string' },
            durationMs: { type: 'integer' },
            run: { type: 'string' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['step', 'action', 'ok', 'durationMs'],
                properties: {
                  step: { type: 'integer' },
                  action: { type: 'string' },
                  ok: { type: 'boolean' },
                  durationMs: { type: 'integer' },
                  detail: { type: 'string' },
                  text: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `${value.ok ? 'PASS' : 'FAIL'} ${value.name ?? value.project} (${value.durationMs} ms, ${value.port ?? 'no port'})\n${(value.steps ?? []).map((step) => `${step.ok ? '✓' : '✗'} ${step.step}. ${step.action} ${step.durationMs} ms${step.detail ? ` — ${step.detail}` : ''}`).join('\n')}${value.run ? `\nreport: ${value.run}` : ''}`,
        }],
      },
      async execute(args) {
        return testOp({
          project: args.project,
          env: args.env,
          port: args.port,
          baud: args.baud,
          file: args.file,
          continueOnFailure: args.continueOnFailure === true,
        })
      },
    },
  ]

  ctx.effect(() => {
    const disposers = definitions.map((definition) => ctx.tools.register(definition))
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  // -------------------------------------------------------------------- routes
  // Route registration must wait for the carrier: on a cold boot this plugin can
  // activate before the web server service exists.

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    const json = (res, status, body) => {
      const data = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(data),
      })
      res.end(data)
    }
    const handle = (method, path, run, limit) => ({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (req.method !== method) {
          json(res, 405, { error: `method ${String(req.method)} is not allowed` })
          return
        }
        if (method !== 'GET' && !sameOrigin(req)) {
          json(res, 403, { error: 'cross-site request rejected' })
          return
        }
        let body
        try {
          body = method === 'GET' ? {} : await readJsonBody(req, limit)
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        try {
          json(res, 200, await run(body))
        } catch (error) {
          // An operation failure is an outcome the panel renders, not a transport error.
          json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    const routes = [
      handle('GET', '/board-lab/status', async () => ({
        projects: listProjects(),
        current: currentProject(),
        ports: attachedPorts(),
        monitors: listMonitors(),
        // Cached ports only: no probing, so opening the panel never resets a board.
        commands: commandsGet({}).commands,
        remembered: attachedPorts()
          .map((port) => {
            const cached = readBoards()[boardCacheKey(port)]
            return cached === undefined ? undefined : { port: port.path, project: cached.project, env: cached.env }
          })
          .filter(Boolean),
        checkpoints: checkpointList(),
        toolchain: {
          platformio: workspacePython || platformioPio() !== undefined || platformioPython() !== undefined,
          armGcc: existsSync(join(toolchainDir, 'pio', 'packages', 'toolchain-gccarmnoneeabi', 'bin', 'arm-none-eabi-gcc'))
            || hasCommand('arm-none-eabi-gcc'),
          python: pythonCommand().command,
          source: pythonCommand().source,
        },
        defaultBaud: settings.defaultBaud,
      })),
      handle('GET', '/board-lab/ports', async () => ({ ports: attachedPorts() })),
      handle('GET', '/board-lab/projects', async () => ({ projects: listProjects() })),
      handle('GET', '/board-lab/project', async () => ({ current: currentProject(), projects: listProjects() })),
      handle('POST', '/board-lab/project/select', async (body) => ({
        ok: true,
        current: selectProject({ project: body.project, env: typeof body.env === 'string' ? body.env : undefined }),
      })),
      handle('POST', '/board-lab/project/open', async (body) => ({
        ok: true,
        ...openFolder({
          project: typeof body.project === 'string' && body.project !== '' ? body.project : undefined,
          target: typeof body.target === 'string' ? body.target : 'root',
        }),
      })),
      handle('POST', '/board-lab/build', async (body) => buildOp({
        project: body.project,
        env: typeof body.env === 'string' ? body.env : undefined,
      })),
      handle('POST', '/board-lab/flash', async (body) => flashOp({
        project: body.project,
        env: typeof body.env === 'string' ? body.env : undefined,
        port: typeof body.port === 'string' ? body.port : undefined,
        protocol: typeof body.protocol === 'string' ? body.protocol : undefined,
      })),
      handle('POST', '/board-lab/monitor', async (body) => {
        const action = String(body.action ?? '')
        if (action === 'status') return { ok: true, action, monitors: listMonitors() }
        const port = selectPort(body.port)
        if (action === 'start') {
          const started = await startMonitor({ port, baud: body.baud, reset: body.reset === 'none' ? 'none' : 'esp' })
          return compact({ ok: started.open === true, action, ...started })
        }
        if (action === 'read') {
          const waitMs = Number.isInteger(body.waitMs) ? Math.min(body.waitMs, 60_000) : 0
          const deadline = Date.now() + waitMs
          const readPanel = () => readMonitor({ port, fromStart: body.fromStart === true, peek: body.peek === true, maxBytes: body.maxBytes, consumer: 'panel' })
          let chunk = await readPanel()
          while (waitMs > 0 && chunk.bytes === 0 && Date.now() < deadline) {
            await sleep(150)
            chunk = await readPanel()
          }
          return compact({ ok: true, action, ...chunk })
        }
        if (action === 'stop') return compact({ ok: true, action, port, running: false, stopped: await stopMonitor(port) })
        throw new Error(`unknown monitor action ${action}`)
      }),
      handle('POST', '/board-lab/watch', async (body) => watchOp({
        port: typeof body.port === 'string' ? body.port : undefined,
        pattern: String(body.pattern ?? ''),
        timeoutMs: body.timeoutMs,
        baud: body.baud,
        fromStart: body.fromStart === true,
        project: typeof body.project === 'string' ? body.project : undefined,
        env: typeof body.env === 'string' ? body.env : undefined,
      })),
      handle('POST', '/board-lab/decode', async (body) => decodeOp({
        project: typeof body.project === 'string' ? body.project : undefined,
        env: typeof body.env === 'string' ? body.env : undefined,
        text: typeof body.text === 'string' ? body.text : undefined,
        port: typeof body.port === 'string' ? body.port : undefined,
        elf: typeof body.elf === 'string' ? body.elf : undefined,
      })),
      handle('POST', '/board-lab/detect', async (body) => detectOp({
        port: typeof body.port === 'string' ? body.port : undefined,
      })),
      handle('POST', '/board-lab/doctor', async () => doctorOp()),
      handle('GET', '/board-lab/tools', async () => toolInventory()),
      handle('POST', '/board-lab/tools/install', async (body) => installToolsOp({
        ids: Array.isArray(body.ids) ? body.ids : [],
      })),
      handle('POST', '/board-lab/test', async (body) => testOp({
        project: body.project,
        env: typeof body.env === 'string' ? body.env : undefined,
        port: typeof body.port === 'string' ? body.port : undefined,
        baud: body.baud,
        file: typeof body.file === 'string' ? body.file : undefined,
        continueOnFailure: body.continueOnFailure === true,
      })),
      handle('POST', '/board-lab/info', async (body) => infoOp({
        port: typeof body.port === 'string' ? body.port : undefined,
      })),
      handle('POST', '/board-lab/write', async (body) => writeOp({
        port: typeof body.port === 'string' ? body.port : undefined,
        text: String(body.text ?? ''),
        newline: body.newline !== false,
      })),
      handle('POST', '/board-lab/reset', async (body) => resetOp({ port: typeof body.port === 'string' ? body.port : undefined })),
      handle('GET', '/board-lab/checkpoints', async () => ({ checkpoints: checkpointList() })),
      handle('POST', '/board-lab/checkpoints/create', async (body) => ({
        ok: true,
        checkpoint: checkpointCreate({
          project: typeof body.project === 'string' && body.project !== '' ? body.project : undefined,
          label: typeof body.label === 'string' ? body.label : undefined,
        }),
        checkpoints: checkpointList(),
      })),
      handle('POST', '/board-lab/checkpoints/restore', async (body) => ({
        ok: true,
        checkpoint: checkpointRestore({ id: String(body.id ?? '') }),
        checkpoints: checkpointList(),
      })),
      handle('POST', '/board-lab/checkpoints/delete', async (body) => ({
        ok: true,
        checkpoint: checkpointDelete({ id: String(body.id ?? '') }),
        checkpoints: checkpointList(),
      })),
      handle('GET', '/board-lab/wiring', async () => wiringGet({})),
      handle('POST', '/board-lab/wiring/set', async (body) => wiringSet({
        project: typeof body.project === 'string' && body.project !== '' ? body.project : undefined,
        board: typeof body.board === 'string' ? body.board : undefined,
        pin: String(body.pin ?? ''),
        label: typeof body.label === 'string' ? body.label : '',
      })),
      handle('POST', '/board-lab/wiring/board', async (body) => wiringBoard({
        project: typeof body.project === 'string' && body.project !== '' ? body.project : undefined,
        board: String(body.board ?? ''),
      })),
      handle('POST', '/board-lab/maps/parse', async (body) => {
        const rows = parsePinRows(body?.text)
        return {
          count: rows.length,
          pins: rows.map((row) => (row.func.length === 0 ? { name: row.name } : { name: row.name, func: row.func })),
        }
      }),
      handle('POST', '/board-lab/maps/save', async (body) => {
        const map = saveMap({
          id: body.id,
          name: body.name,
          aliases: body.aliases,
          sides: body.sides,
          note: body.note,
          verified: body.verified,
          package: body.package,
          pins: body.pins,
          draw: body.draw,
          pads: body.pads,
        })
        const pinned = currentProject()
        if (pinned !== undefined) wiringBoard({ project: pinned.path, board: map.id })
        return { ok: true, map, wiring: wiringGet({ project: pinned?.path }) }
      }),
      handle('POST', '/board-lab/maps/new', async (body) => {
        const map = createBlankMap({ id: body.id, name: body.name, board: body.board })
        const pinned = currentProject()
        if (pinned !== undefined) wiringBoard({ project: pinned.path, board: map.id })
        return { ok: true, map, wiring: wiringGet({ project: pinned?.path }) }
      }),
      handle('GET', '/board-lab/commands', async () => ({ ok: true, ...commandsGet({}) })),
      handle('POST', '/board-lab/commands/set', async (body) => ({
        ok: true,
        ...commandsSet({ project: typeof body.project === 'string' && body.project !== '' ? body.project : undefined, commands: body.commands }),
      })),
      handle('POST', '/board-lab/wiring/draft', async (body) => wiringDraft({
        project: typeof body.project === 'string' && body.project !== '' ? body.project : undefined,
        board: typeof body.board === 'string' && body.board !== '' ? body.board : undefined,
      })),
      handle('POST', '/board-lab/cycle', async (body) => cycleOp({
        project: body.project,
        env: typeof body.env === 'string' ? body.env : undefined,
        port: typeof body.port === 'string' ? body.port : undefined,
        baud: body.baud,
        durationMs: body.durationMs,
        untilPattern: body.untilPattern,
        reset: body.reset,
      })),
    ]

    webCtx.effect(() => {
      const disposers = routes.map((route) => webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    })
  })
}

/** Collect one JSON request body, bounded. */
function readJsonBody(req, limit = 1 << 20) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolvePromise({})
        return
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** Reject cross-site form posts; same-origin fetch sends no Origin at all. */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}
