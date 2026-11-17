#!/usr/bin/env node
// Vendor pin tables into a board-lab map.
//
// A chip map is a package plus a pin table, so importing one is a translation:
// whatever the vendor ships — a JSON dump of the chip database, or the datasheet
// table copied out of a PDF — is turned into `package` and `pins` here. Nothing
// in the panel or in board_maps knows about vendors.
//
// Two inputs, because vendors only agree on disagreeing:
//
//   --stm32 <chip.json>   stm32-data chip json (embassy-rs/stm32-data-generated,
//                         data/chips/<CHIP>.json). Pin positions and every
//                         peripheral signal come from there; the signal list of a
//                         pin is rebuilt as <PERIPHERAL>_<SIGNAL> (USART1_TX).
//
//   --table <file.txt>    a plain pin table: one pin per line, columns separated
//                         by whitespace, ';' or '|' — number, name, then the
//                         functions separated by ',' ' ' or '/'. This is the
//                         shape `pdftotext -layout` gives a datasheet table, and
//                         the shape any hand-kept table takes.
//
// Usage:
//   node tools/import-pinout.mjs --stm32 chip.json --id stm32f103c8t6 --name "STM32F103C8T6"
//   node tools/import-pinout.mjs --table pins.txt --kind qfp --id at32f403avgt7 --name "AT32F403AVGT7"
//
// It prints the map; --write puts it into maps/<id>.json. It refuses a pin count
// that is not a real package, the same rule board_maps save applies.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAPS = join(dirname(fileURLToPath(import.meta.url)), '..', 'maps')

const KINDS = ['qfp', 'qfn', 'dip', 'soic', 'tssop']
const QUAD = ['qfp', 'qfn']
const NAME_RE = /^[A-Za-z0-9_+./-]{1,18}$/

function fail(message) {
  console.error(`import-pinout: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) fail(`unexpected argument "${arg}"`)
    const key = arg.slice(2)
    if (key === 'write' || key === 'help') {
      args[key] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`--${key} needs a value`)
    args[key] = value
    index += 1
  }
  return args
}

/** A pin name the map format accepts, or a clear refusal. */
function pinName(raw, where) {
  const name = String(raw).trim()
  if (name === '') fail(`${where}: empty pin name`)
  if (!NAME_RE.test(name)) fail(`${where}: "${name}" is not a pin name (letters, digits, _ + . / -, up to 18)`)
  return name
}

/** Function names from whatever the vendor wrote: trimmed, deduped, short. */
function funcs(raw) {
  const out = []
  for (const item of raw) {
    const text = String(item)
      .trim()
      .replace(/[^A-Za-z0-9_+./-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 28)
    if (text === '' || !/^[A-Za-z]/.test(text) || out.includes(text)) continue
    out.push(text)
  }
  return out.slice(0, 10)
}

/** LQFP48 → qfp; unknown packages are refused rather than guessed. */
function kindOf(packageName, explicit) {
  if (explicit !== undefined) {
    const kind = String(explicit).toLowerCase()
    if (!KINDS.includes(kind)) fail(`--kind must be one of ${KINDS.join(', ')}`)
    return kind
  }
  const text = String(packageName ?? '').toLowerCase()
  for (const kind of KINDS) if (text.includes(kind)) return kind
  fail(`cannot tell the package kind from "${packageName}"; pass --kind qfp|qfn|dip|soic|tssop`)
}

function checkPackage(kind, count) {
  const sides = QUAD.includes(kind) ? 4 : 2
  if (count < sides * 2 || count % sides !== 0) {
    fail(`${kind.toUpperCase()} with ${count} pins is not a real package: a multiple of ${sides}, at least ${sides * 2}`)
  }
}

/**
 * stm32-data chip json: packages[].pins[].position + signals, and the alternate
 * functions hang off cores[].peripherals[].pins[] as <PERIPHERAL>_<SIGNAL>.
 */
function fromStm32(chip) {
  const pkg = (chip.packages ?? [])[0]
  if (pkg === undefined) fail('chip json has no packages')
  const rows = []
  for (const pin of pkg.pins ?? []) {
    rows.push({ number: Number(pin.position), name: pinName((pin.signals ?? [])[0], `${pkg.name} pin ${pin.position}`), func: [] })
  }
  const byName = new Map()
  for (const row of rows) byName.set(row.name, row)
  for (const core of chip.cores ?? []) {
    for (const peripheral of core.peripherals ?? []) {
      for (const mapping of peripheral.pins ?? []) {
        const row = byName.get(mapping.pin)
        if (row === undefined || mapping.signal === undefined) continue
        row.func.push(`${peripheral.name}_${mapping.signal}`)
      }
    }
  }
  rows.sort((left, right) => left.number - right.number)
  for (const [index, row] of rows.entries()) {
    if (row.number !== index + 1) fail(`pin ${row.name} sits at position ${row.number}, expected ${index + 1} — the table is not a physical order`)
  }
  return { kind: kindOf(pkg.package), pins: rows.map((row) => ({ name: row.name, func: funcs(row.func) })) }
}

/**
 * A plain table: every line starts with a pin number, then the name, then
 * functions. Header lines and prose are skipped rather than refused, because a
 * datasheet page always carries some.
 */
function fromTable(text) {
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(/\s*[;|]\s*|\s{2,}|\t/).filter((cell) => cell.trim() !== '')
    if (cells.length < 2) continue
    const number = Number(cells[0].trim())
    if (!Number.isInteger(number) || number < 1) continue
    const name = cells[1].trim().split(/[ ,/]/)[0]
    if (!NAME_RE.test(name)) continue
    const rest = cells.slice(2).join(' ').split(/[,;/\s]+/).filter((cell) => cell !== '')
    rows.push({ number, name, func: rest })
  }
  if (rows.length === 0) fail('the table has no rows: expected "<number> <name> <functions...>" per line')
  rows.sort((left, right) => left.number - right.number)
  for (const [index, row] of rows.entries()) {
    if (row.number !== index + 1) fail(`pin ${row.name} sits at row ${row.number}, expected ${index + 1} — a pin is missing before it`)
  }
  return { kind: undefined, pins: rows.map((row) => ({ name: row.name, func: funcs(row.func) })) }
}

const args = parseArgs(process.argv.slice(2))
if (args.help === true) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 32).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'))
  process.exit(0)
}
if (args.id === undefined) fail('--id is required')
if (!/^[a-z0-9][a-z0-9.-]*$/.test(args.id)) fail('--id must be lowercase letters, digits, dot or dash')

let source
if (args.stm32 !== undefined) source = fromStm32(JSON.parse(readFileSync(args.stm32, 'utf8')))
else if (args.table !== undefined) source = fromTable(readFileSync(args.table, 'utf8'))
else fail('give --stm32 <chip.json> or --table <file.txt>')

const kind = kindOf(undefined, args.kind ?? source.kind)
checkPackage(kind, source.pins.length)

const map = {
  id: args.id,
  name: args.name ?? args.id,
  board: (args.board ?? args.name ?? args.id).split(',').map((item) => item.trim()).filter((item) => item !== ''),
  verified: false,
  note: `Imported from ${args.stm32 !== undefined ? 'stm32-data' : 'a vendor pin table'}; ring the pins out before marking it verified.`,
  package: { kind },
  pins: source.pins.map((pin) => (pin.func.length === 0 ? pin.name : { name: pin.name, func: pin.func })),
}

const json = `${JSON.stringify(map, null, 2)}\n`
if (args.write === true) {
  const target = join(MAPS, `${args.id}.json`)
  if (existsSync(target)) fail(`${target} exists — remove it first, an import never overwrites a hand-checked map`)
  writeFileSync(target, json)
  console.log(`wrote ${target} (${map.pins.length} pins)`)
} else {
  process.stdout.write(json)
}
