#!/usr/bin/env node
/**
 * Structural smoke test for board-lab/client.js without a browser.
 *
 * Stubs the module loader, React and the Client context, evaluates the client
 * bundle, and checks that apply() registers the Board lab panel and sidebar
 * entry with the expected keys.
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')

const registrations = []
let factory

globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      factory = module.factory
    },
  },
}

const React = {
  createElement: () => null,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
}

await import(pathToFileURL(clientPath).href)

if (typeof factory !== 'function') {
  console.error('FAIL: client module did not register a factory')
  process.exit(1)
}

const mod = factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

if (typeof mod.apply !== 'function') {
  console.error('FAIL: client module has no apply')
  process.exit(1)
}

const locale = {
  register() {
    return () => {}
  },
  bind() {
    return (key) => key
  },
}

const ctx = {
  get(name) {
    return name === 'locale' ? locale : undefined
  },
  effect(fn) {
    fn()
    return () => {}
  },
  locale,
  slots: {
    inject(_owner, callback) {
      callback()
      return () => {}
    },
    register(def) {
      registrations.push(def)
      return () => {}
    },
  },
}

mod.apply(ctx)

const main = registrations.find((item) => item.name === 'main' && item.key === 'board-lab')
const sidebar = registrations.find((item) => item.name === 'sidebar.panellist' && item.id === 'board-lab')
const settings = registrations.find((item) => item.name === 'settings.section' && item.id === 'board-lab')

if (main === undefined) {
  console.error('FAIL: no main panel registration for board-lab')
  process.exit(1)
}
if (sidebar === undefined) {
  console.error('FAIL: no sidebar entry registration for board-lab')
  process.exit(1)
}
if (settings === undefined) {
  console.error('FAIL: no settings section registration for board-lab')
  process.exit(1)
}

console.log('OK: registered main key "board-lab", sidebar entry and settings section "board-lab"')
