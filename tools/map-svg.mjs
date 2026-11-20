#!/usr/bin/env node
// Export a chip map as an SVG picture for docs and printouts.
//
// The geometry is the same one client.js draws in the panel: package outline,
// pins counted counter-clockwise from pin 1, pin numbers inside, names outside.
// Nothing here reads the panel, so the picture stays in step with `board_maps`.
//
//   node tools/map-svg.mjs maps/stm32f103c8t6.json > docs/maps/stm32f103c8t6.svg
//   node tools/map-svg.mjs maps/stm32f103c8t6.json --wired 8,9,10 > wired.svg

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const MAP_PITCH = 21
const MAP_PAD = 9
const CHIP_LABEL = 124

const COLOR = {
  paper: '#ffffff',
  body: '#f7faf9',
  border: '#c7d3cf',
  number: '#93a8a2',
  name: '#26332f',
  wired: '#12895c',
}

function usage(code) {
  const text = 'usage: node tools/map-svg.mjs <maps/<id>.json> [--wired 8,9,10] [--out file.svg]\n'
  if (code === 0) process.stdout.write(text)
  else process.stderr.write(text)
  process.exit(code)
}

function parseArgs(argv) {
  const args = { file: '', wired: new Set(), out: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--wired') {
      const value = argv[i + 1] ?? ''
      i += 1
      for (const piece of value.split(',')) {
        const number = Number(piece.trim())
        if (Number.isInteger(number) && number > 0) args.wired.add(number)
      }
    } else if (arg === '--out') {
      args.out = argv[i + 1] ?? ''
      i += 1
    } else if (arg === '-h' || arg === '--help') {
      usage(0)
    } else if (!args.file) {
      args.file = arg
    } else {
      usage(1)
    }
  }
  if (!args.file) usage(1)
  return args
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function chipSvg(map, wired) {
  const entries = Array.isArray(map?.pins) ? map.pins : []
  const names = entries.map((entry) => (typeof entry === 'string' ? entry : String(entry?.name ?? '')))
  if (names.length === 0) return null
  const kind = String(map?.package?.kind ?? 'qfp').toLowerCase()
  const quad = kind === 'qfp' || kind === 'qfn'
  const perSide = Math.max(1, Math.round(names.length / (quad ? 4 : 2)))
  const span = perSide * MAP_PITCH
  const bodySpan = span + 30
  const bodyW = quad ? bodySpan : Math.max(74, Math.round(bodySpan * 0.42))
  const bodyH = bodySpan
  const width = CHIP_LABEL * 2 + bodyW
  const height = CHIP_LABEL * 2 + bodyH
  const bx = CHIP_LABEL
  const by = CHIP_LABEL
  const start = (bodyH - span) / 2 + MAP_PITCH / 2
  const hStart = bx + (bodyW - span) / 2 + MAP_PITCH / 2
  const hEnd = bx + bodyW - (bodyW - span) / 2 - MAP_PITCH / 2
  const inside = kind === 'qfn'

  const slots = []
  for (let i = 0; i < perSide; i += 1) slots.push({ index: i, cx: bx, cy: by + start + i * MAP_PITCH, side: 'left' })
  if (quad) {
    for (let i = 0; i < perSide; i += 1) {
      slots.push({ index: perSide + i, cx: hStart + i * MAP_PITCH, cy: by + bodyH, side: 'bottom' })
      slots.push({ index: 2 * perSide + i, cx: bx + bodyW, cy: by + bodyH - start - i * MAP_PITCH, side: 'right' })
      slots.push({ index: 3 * perSide + i, cx: hEnd - i * MAP_PITCH, cy: by, side: 'top' })
    }
  } else {
    for (let i = 0; i < perSide; i += 1) {
      // DIP/SOIC: down the left, then up the right — pin N/2+1 is bottom-right.
      slots.push({ index: perSide + i, cx: bx + bodyW, cy: by + bodyH - start - i * MAP_PITCH, side: 'right' })
    }
  }

  const parts = []
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${COLOR.paper}"/>`)
  parts.push(
    `<rect x="${bx}" y="${by}" width="${bodyW}" height="${bodyH}" rx="7" fill="${COLOR.body}" stroke="${COLOR.border}" stroke-width="1.5"/>`,
  )
  parts.push(`<circle cx="${bx + 13}" cy="${by + 13}" r="4" fill="none" stroke="${COLOR.number}" stroke-width="1.5"/>`)
  parts.push(
    `<text x="${bx + bodyW / 2}" y="${by + bodyH / 2 + 4}" fill="${COLOR.number}" font-size="11" font-weight="600" text-anchor="middle" font-family="sans-serif">${escapeXml(map?.name ?? '')}</text>`,
  )
  parts.push(
    `<text x="${bx + bodyW / 2}" y="${by + bodyH / 2 + 18}" fill="${COLOR.number}" font-size="8" text-anchor="middle" font-family="ui-monospace,monospace">${escapeXml(`${kind.toUpperCase()}${names.length}`)}</text>`,
  )

  const outward = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }
  for (const slot of slots) {
    const key = slot.index + 1
    const name = names[slot.index]
    const [dx, dy] = outward[slot.side]
    const reach = inside ? -7 : 13
    const ex = slot.cx + dx * reach
    const ey = slot.cy + dy * reach
    const color = wired.has(key) ? COLOR.wired : COLOR.number
    parts.push(
      `<line x1="${slot.cx}" y1="${slot.cy}" x2="${ex}" y2="${ey}" stroke="${color}" stroke-width="4.5" stroke-linecap="round"/>`,
    )
    parts.push(
      `<rect x="${ex - MAP_PAD / 2}" y="${ey - MAP_PAD / 2}" width="${MAP_PAD}" height="${MAP_PAD}" rx="2" fill="${wired.has(key) ? COLOR.wired : COLOR.paper}" stroke="${wired.has(key) ? COLOR.wired : COLOR.border}" stroke-width="1.2"/>`,
    )
    const labelAt = {
      left: [bx - 16, slot.cy + 3.2, 'end', false],
      right: [bx + bodyW + 16, slot.cy + 3.2, 'start', false],
      top: [slot.cx + 3.2, by - 16, 'start', true],
      bottom: [slot.cx - 3.2, by + bodyH + 16, 'end', true],
    }[slot.side]
    const rotate = labelAt[3] ? ` transform="rotate(-90 ${labelAt[0]} ${labelAt[1]})"` : ''
    parts.push(
      `<text x="${labelAt[0]}" y="${labelAt[1]}" fill="${wired.has(key) ? COLOR.wired : COLOR.name}" font-size="9" font-family="ui-monospace,monospace" text-anchor="${labelAt[2]}"${rotate}>${escapeXml(name)}</text>`,
    )
    const numberAt = {
      left: [bx + 8, slot.cy + 2.8, 'start', false],
      right: [bx + bodyW - 8, slot.cy + 2.8, 'end', false],
      top: [slot.cx + 2.8, by + 8, 'start', true],
      bottom: [slot.cx - 2.8, by + bodyH - 8, 'end', true],
    }[slot.side]
    const numberRotate = numberAt[3] ? ` transform="rotate(-90 ${numberAt[0]} ${numberAt[1]})"` : ''
    parts.push(
      `<text x="${numberAt[0]}" y="${numberAt[1]}" fill="${COLOR.number}" font-size="7" font-family="ui-monospace,monospace" text-anchor="${numberAt[2]}"${numberRotate}>${key}</text>`,
    )
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(map?.name ?? 'chip map')}">\n  ${parts.join('\n  ')}\n</svg>\n`
}

const args = parseArgs(process.argv.slice(2))
let map
try {
  map = JSON.parse(readFileSync(args.file, 'utf8'))
} catch (error) {
  process.stderr.write(`cannot read ${args.file}: ${error.message}\n`)
  process.exit(1)
}
const svg = chipSvg(map, args.wired)
if (!svg) {
  process.stderr.write(`${basename(args.file)} has no pins — only chip maps can be drawn\n`)
  process.exit(1)
}
if (args.out) {
  writeFileSync(args.out, svg)
  process.stderr.write(`${args.out}\n`)
} else {
  process.stdout.write(svg)
}
