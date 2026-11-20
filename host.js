/**
 * Host-specific plumbing for board-lab: serial port enumeration, the Python
 * interpreter that owns pyserial/esptool/PlatformIO, and process liveness.
 *
 * Linux reads the kernel's sysfs; Windows asks the same Python that drives the
 * monitor (pyserial ships with PlatformIO), so the rest of the plugin sees one
 * shape on both systems. Nothing here writes outside the workspace state dir.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export const isWindows = process.platform === 'win32'

/** `%USERPROFILE%\.platformio` — the core directory of an installed PlatformIO. */
export function platformioCoreDir() {
  return process.env.PLATFORMIO_CORE_DIR || join(homedir(), '.platformio')
}

/** Python shipped inside PlatformIO's virtualenv; it always has pyserial and esptool. */
export function platformioPython() {
  const candidate = isWindows
    ? join(platformioCoreDir(), 'penv', 'Scripts', 'python.exe')
    : join(platformioCoreDir(), 'penv', 'bin', 'python')
  return existsSync(candidate) ? candidate : undefined
}

/** `pio` console script of that virtualenv, when present. */
export function platformioPio() {
  const candidate = isWindows
    ? join(platformioCoreDir(), 'penv', 'Scripts', 'pio.exe')
    : join(platformioCoreDir(), 'penv', 'bin', 'pio')
  return existsSync(candidate) ? candidate : undefined
}

const PORT_CACHE_MS = 4000
let portCache = { at: 0, ports: [], key: '' }

/** One pyserial query, cached briefly: the panel polls status every 5 s. */
function portsFromPython(python, workspacePython) {
  const env = { ...process.env }
  if (workspacePython !== undefined) env.PYTHONPATH = workspacePython
  const script = [
    'import json,sys',
    'try:',
    '    from serial.tools import list_ports',
    'except Exception as exc:',
    '    print(json.dumps({"error": str(exc)})); sys.exit(0)',
    'out=[]',
    'for p in list_ports.comports():',
    '    out.append({"path": p.device, "label": p.description, "hwid": p.hwid,',
    '                "vid": format(p.vid, "04x") if p.vid is not None else None,',
    '                "pid": format(p.pid, "04x") if p.pid is not None else None,',
    '                "serial": p.serial_number, "manufacturer": p.manufacturer})',
    'print(json.dumps(out))',
  ].join('\n')
  try {
    const raw = execFileSync(python, ['-c', script], {
      env,
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed = JSON.parse(raw.trim() || '[]')
    if (!Array.isArray(parsed)) return undefined
    return parsed.map((entry) => {
      const port = { path: entry.path }
      if (entry.label) port.label = entry.label
      if (entry.vid) port.vendorId = String(entry.vid).toLowerCase()
      if (entry.pid) port.productId = String(entry.pid).toLowerCase()
      if (entry.serial) port.serial = entry.serial
      if (entry.manufacturer) port.manufacturer = entry.manufacturer
      return port
    })
  } catch {
    return undefined
  }
}

/** COM ports from the registry when no Python with pyserial is available yet. */
function portsFromRegistry() {
  try {
    const raw = execFileSync('reg', ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const ports = []
    for (const line of raw.split(/\r?\n/)) {
      const match = /REG_SZ\s+(COM\d+)/i.exec(line)
      if (match) ports.push({ path: match[1] })
    }
    return ports
  } catch {
    return undefined
  }
}

/** Linux sysfs enumeration: path, by-id name, USB ids and driver. */
function portsFromSysfs() {
  let names = []
  try {
    names = readdirSync('/dev').filter((entry) => /^tty(USB|ACM|AMA)\d+$/.test(entry))
  } catch {
    names = []
  }
  const byId = new Map()
  try {
    for (const link of readdirSync('/dev/serial/by-id')) {
      try {
        byId.set(realpathSync(join('/dev/serial/by-id', link)), link)
      } catch {
        // dangling link
      }
    }
  } catch {
    // no by-id directory: not an error
  }
  return names.sort().map((entry) => {
    const path = `/dev/${entry}`
    const port = { path }
    if (byId.has(path)) port.byId = byId.get(path)
    for (const ueventPath of [
      `/sys/class/tty/${entry}/device/uevent`,
      `/sys/class/tty/${entry}/device/../uevent`,
    ]) {
      let uevent
      try {
        uevent = readFileSync(ueventPath, 'utf8')
      } catch {
        continue
      }
      const product = /PRODUCT=([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(uevent)
      if (product !== null) {
        port.vendorId = product[1].toLowerCase()
        port.productId = product[2].toLowerCase()
      }
      const driver = /DRIVER=(\S+)/.exec(uevent)
      if (driver !== null) port.driver = driver[1]
      break
    }
    return port
  })
}

/**
 * Attached serial ports. `python` is the interpreter that already owns
 * pyserial; `workspacePython` is an optional PYTHONPATH for the workspace copy.
 */
export function listPorts(python, workspacePython) {
  const key = `${python ?? ''}|${workspacePython ?? ''}`
  if (portCache.key === key && Date.now() - portCache.at < PORT_CACHE_MS) return portCache.ports
  let ports
  if (isWindows) {
    ports = python ? portsFromPython(python, workspacePython) : undefined
    if (ports === undefined) ports = portsFromRegistry()
    if (ports === undefined) ports = []
    ports.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  } else {
    ports = portsFromSysfs()
  }
  portCache = { at: Date.now(), key, ports }
  return ports
}

/** Drop the cached port list (after a flash, so new devices appear at once). */
export function forgetPorts() {
  portCache = { at: 0, key: '', ports: [] }
}

/**
 * True when `pid` is a live process. On Linux the command line must still be
 * `monitor.py`, because pids are recycled; Windows exposes no cheap equivalent,
 * so existence is the check there.
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (isWindows) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return cmdline.includes('monitor.py')
  } catch (error) {
    if (error?.code === 'ENOENT') return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Terminate a process tree; true when the pid is gone afterwards. */
export function killTree(pid, force = false) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  if (isWindows) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 5000,
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      // already gone
    }
    return !pidAlive(pid)
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    // already gone
  }
  return !pidAlive(pid)
}

/** True when `command` resolves on PATH (`where` on Windows, `which` elsewhere). */
/** `which`/`where` is a process spawn, and the panel asks every few seconds. */
const COMMAND_CACHE_MS = 10_000
const commandCache = new Map()

export function hasCommand(command) {
  const cached = commandCache.get(command)
  if (cached !== undefined && Date.now() - cached.at < COMMAND_CACHE_MS) return cached.value
  let value = false
  try {
    execFileSync(isWindows ? 'where' : 'which', [command], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    value = true
  } catch {
    value = false
  }
  commandCache.set(command, { at: Date.now(), value })
  return value
}

/** Environment variable list separator for PYTHONPATH. */
export const pathListSeparator = delimiter
