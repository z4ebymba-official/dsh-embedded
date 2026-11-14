window.__ModuleLoader__.load({
  id: '@local/board-lab',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'board-lab'
    const MAX_LOG_CHARS = 400_000
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    /** Same-origin JSON call; the browser session authorizes it. */
    async function call(path, body) {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      })
      let data
      try {
        data = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
      return data
    }

    const S = {
      page: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: '18px 22px 20px',
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        minHeight: 0,
      },
      header: { display: 'flex', alignItems: 'flex-start', gap: 18, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 19, fontWeight: 650, letterSpacing: '-0.015em', lineHeight: '26px' },
      subtitle: { margin: '3px 0 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 12.5, lineHeight: '18px' },
      stats: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', paddingTop: 5 },
      stat: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      dot: (color) => ({ width: 7, height: 7, borderRadius: 999, background: color, flex: '0 0 auto' }),
      main: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 300px',
        gap: 12,
        alignItems: 'stretch',
        flex: 1,
        minHeight: 0,
      },
      left: { display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', gap: 12, minHeight: 0, minWidth: 0, overflow: 'hidden' },
      rail: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, minWidth: 0 },
      logCard: { minHeight: 0 },
      nowrap: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '12px 16px', textAlign: 'left' },
      emptyMark: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 26, color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))', letterSpacing: 2 },
      emptyTitle: { fontSize: 13.5, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      emptySteps: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)', maxWidth: 520 },
      emptyStep: { display: 'flex', alignItems: 'flex-start', gap: 8 },
      emptyNum: { flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: 9, border: '1px solid var(--dsw-alias-border-l1)', fontSize: 11, color: 'var(--dsw-alias-label-primary)' },
      emptyHint: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))' },
      stepsInline: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      stepChip: (ok) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px',
        borderRadius: 5,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-primary)',
      }),
      card: {
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        minHeight: 0,
        minWidth: 0,
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 18 },
      kicker: {
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: '0.09em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
      },
      fields: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1.55fr) 84px auto',
        gap: 8,
        alignItems: 'end',
      },
      field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      label: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      input: {
        height: 30,
        padding: '0 9px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12.5,
        boxSizing: 'border-box',
        minWidth: 0,
      },
      actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      primary: {
        height: 30,
        padding: '0 14px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-label-primary)',
        color: 'var(--dsw-alias-bg-base)',
        font: 'inherit',
        fontSize: 12.5,
        fontWeight: 600,
        cursor: 'pointer',
      },
      ghost: {
        height: 30,
        padding: '0 11px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12.5,
        cursor: 'pointer',
      },
      quiet: {
        height: 24,
        padding: '0 7px',
        borderRadius: 5,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      chip: {
        height: 26,
        padding: '0 9px',
        borderRadius: 5,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: MONO,
        fontSize: 11.5,
        cursor: 'pointer',
      },
      spacer: { flex: 1 },
      terminal: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 120,
        overflow: 'auto',
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: '17px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      logRow: { display: 'grid', gridTemplateColumns: '64px 46px minmax(0, 1fr)', gap: 8 },
      time: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, opacity: 0.75 },
      tag: {
        fontSize: 9.5,
        letterSpacing: '0.07em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
        paddingTop: 2,
        opacity: 0.85,
      },
      logText: (entry) => ({
        color:
          entry.ok === false
            ? 'var(--dsw-alias-state-error-primary)'
            : entry.ok === true
              ? 'var(--dsw-alias-label-primary)'
              : undefined,
      }),
      sendRow: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', gap: 8, alignItems: 'center' },
      prompt: { fontFamily: MONO, color: 'var(--dsw-alias-brand-primary)', fontSize: 14, lineHeight: '30px' },
      banner: (color) => ({
        display: 'flex',
        gap: 8,
        alignItems: 'baseline',
        padding: '6px 10px',
        borderRadius: 6,
        border: `1px solid ${color}`,
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'transparent',
      }),
      fact: {
        display: 'grid',
        gridTemplateColumns: '78px minmax(0, 1fr)',
        gap: 8,
        padding: '5px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        alignItems: 'baseline',
      },
      factLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11.5 },
      factValue: { fontSize: 12.5, overflowWrap: 'anywhere' },
      monoValue: { fontFamily: MONO, fontSize: 11.5, overflowWrap: 'anywhere' },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: '17px' },
      steps: { display: 'flex', flexDirection: 'column', gap: 2 },
      step: { display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr) auto', gap: 6, fontSize: 12 },
      sectionGap: { height: 1, background: 'var(--dsw-alias-border-l1)', margin: '2px 0' },
    }

    function remembered(key) {
      try {
        return window.localStorage.getItem(key) ?? ''
      } catch {
        return ''
      }
    }

    function remember(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        // private mode: selection just is not remembered
      }
    }

    function button(style, disabled, props, ...children) {
      return h('button', {
        ...props,
        style: { ...style, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer' },
        disabled,
      }, ...children)
    }

    function statusItem(color, label, title) {
      return h('span', { style: S.stat, title }, h('span', { style: S.dot(color) }), label)
    }

    function BoardLabPage() {
      const t = useMemo(() => (key) => translate(key), [])
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [project, setProject] = useState(() => remembered('board-lab/project'))
      const [port, setPort] = useState(() => remembered('board-lab/port'))
      const [baud, setBaud] = useState('115200')
      const [busy, setBusy] = useState(null)
      const [log, setLog] = useState([])
      const [follow, setFollow] = useState(true)
      const [filter, setFilter] = useState('')
      const [writeText, setWriteText] = useState('')
      const [portError, setPortError] = useState(null)
      const [facts, setFacts] = useState(null)
      const [lastTest, setLastTest] = useState(null)
      const logRef = useRef(null)
      const nextId = useRef(1)
      const reading = useRef(false)
      const partial = useRef('')
      const portFails = useRef(0)

      const append = useCallback((kind, text, ok) => {
        if (text === undefined || text === '') return
        setLog((entries) => {
          const next = [...entries, { id: nextId.current++, kind, text, ok, at: new Date() }]
          let size = 0
          for (let index = next.length - 1; index >= 0; index--) {
            size += next[index].text.length
            if (size > MAX_LOG_CHARS) return next.slice(index)
          }
          return next
        })
      }, [])

      // Device output arrives in chunks that may stop mid-line; keep the tail and
      // emit whole lines so the filter and copy work line by line.
      const appendDevice = useCallback((text) => {
        const combined = partial.current + text
        const lines = combined.split(/\r?\n/)
        partial.current = lines.pop() ?? ''
        for (const line of lines) {
          if (line !== '') append('device', line)
        }
      }, [append])

      const refresh = useCallback(async () => {
        try {
          const data = await call('/board-lab/status')
          setStatus(data)
          setError(null)
          setProject((current) => current || data.remembered?.[0]?.project || '')
          setPort((current) => current || data.ports?.[0]?.path || '')
          if (Number.isInteger(data.defaultBaud)) setBaud(String(data.defaultBaud))
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      useEffect(() => { refresh() }, [refresh])
      useEffect(() => { remember('board-lab/project', project) }, [project])
      useEffect(() => { remember('board-lab/port', port) }, [port])
      useEffect(() => { partial.current = '' }, [port])

      // Keep toolchain/port badges and the monitor chip honest while the page stays open.
      useEffect(() => {
        const timer = setInterval(() => {
          if (!document.hidden) refresh()
        }, 5000)
        return () => clearInterval(timer)
      }, [refresh])

      const monitor = useMemo(() => {
        const list = status?.monitors ?? []
        return list.find((item) => item.port === port)
      }, [status, port])
      const monitoring = monitor?.running === true

      // Live output: poll the monitor and append only what is new. A single failed
      // read is normal while the server hands the port to esptool, so the banner
      // appears only after two consecutive failures.
      useEffect(() => {
        if (!monitoring || port === '') {
          setPortError(null)
          portFails.current = 0
          return undefined
        }
        let cancelled = false
        const tick = async () => {
          if (cancelled || document.hidden || reading.current) return
          reading.current = true
          try {
            const chunk = await call('/board-lab/monitor', { action: 'read', port })
            if (cancelled) return
            if (typeof chunk.text === 'string' && chunk.text !== '') appendDevice(chunk.text)
            if (chunk.running === false) {
              portFails.current = 0
              setPortError(null)
            } else if (chunk.open === false) {
              portFails.current += 1
              if (portFails.current >= 2) setPortError(chunk.error ?? t('status.monitorError'))
            } else {
              portFails.current = 0
              setPortError(null)
            }
          } catch (cause) {
            if (!cancelled) {
              portFails.current += 1
              if (portFails.current >= 2) setPortError(cause instanceof Error ? cause.message : String(cause))
            }
          } finally {
            reading.current = false
          }
        }
        const timer = setInterval(tick, 900)
        tick()
        const onVisible = () => {
          if (!document.hidden) tick()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          cancelled = true
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [monitoring, port, append, appendDevice, t])

      useEffect(() => {
        if (!follow) return
        const element = logRef.current
        if (element !== null) element.scrollTop = element.scrollHeight
      }, [log, follow])

      const run = useCallback(async (kind, path, body) => {
        setBusy(kind)
        try {
          const result = await call(path, body)
          if (kind === 'flash') {
            append('flash', result.summary, result.ok)
            if (!result.ok && result.output) append('flash', result.output, false)
            append('system', result.monitor === 'restarted' ? t('log.monitorRestarted') : t('log.monitorIdle'), undefined)
          } else if (kind === 'build') {
            append('build', result.summary, result.ok)
            if (!result.ok && result.output) append('build', result.output, false)
          } else {
            append(kind, result.summary ?? String(result), result.ok)
          }
          if (kind === 'flash') await refresh()
        } catch (cause) {
          append(kind, `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        } finally {
          setBusy(null)
        }
      }, [append, refresh, t])

      const startMonitor = useCallback(async () => {
        if (port === '') return
        try {
          const result = await call('/board-lab/monitor', { action: 'start', port, baud: Number(baud) || undefined })
          append('system', result.running ? `${t('log.monitorStarted')} ${port}` : `monitor failed: ${result.error ?? 'unknown'}`, result.running)
        } catch (cause) {
          append('system', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        }
        await refresh()
      }, [port, baud, append, refresh, t])

      const stopMonitor = useCallback(async () => {
        try {
          await call('/board-lab/monitor', { action: 'stop', port })
          append('system', `${t('log.monitorStopped')} ${port}`, undefined)
        } catch (cause) {
          append('system', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        }
        await refresh()
      }, [port, append, refresh, t])

      const sendText = useCallback(async (text) => {
        if (text === '') return
        try {
          await call('/board-lab/write', { port, text })
          append('sent', `→ ${text}`, undefined)
        } catch (cause) {
          append('sent', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        }
      }, [port, append])

      const send = useCallback(async () => {
        if (writeText === '') return
        await sendText(writeText)
        setWriteText('')
      }, [writeText, sendText])

      const resetBoard = useCallback(async () => {
        try {
          await call('/board-lab/reset', { port })
          append('system', t('log.reset'), undefined)
        } catch (cause) {
          append('system', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        }
      }, [port, append, t])

      // Chip identity via esptool; the monitor is stopped and restarted by the server.
      const inspect = useCallback(async () => {
        if (port === '') return
        setBusy('info')
        try {
          const result = await call('/board-lab/info', { port })
          append('info', result.summary, result.ok)
          const collected = [
            result.chip !== undefined ? `chip: ${result.chip}` : null,
            result.revision !== undefined ? result.revision : null,
            result.flashSize !== undefined ? `flash: ${result.flashSize}` : null,
            result.psram !== undefined ? `psram: ${result.psram}` : null,
            result.mac !== undefined ? `mac: ${result.mac}` : null,
          ].filter((item) => item !== null)
          if (result.ok && collected.length > 0) append('info', collected.join(' · '), true)
          if (result.ok) {
            setFacts({
              chip: result.chip,
              revision: result.revision,
              flashSize: result.flashSize,
              psram: result.psram,
              mac: result.mac,
            })
          }
          if (!result.ok && result.output) append('info', result.output, false)
        } catch (cause) {
          append('info', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        } finally {
          setBusy(null)
          await refresh()
        }
      }, [port, append, refresh, t])

      // Ask the server which project this board belongs to (esptool + platformio.ini).
      const detect = useCallback(async () => {
        setBusy('detect')
        try {
          const result = await call('/board-lab/detect', { port: port === '' ? undefined : port })
          if (result.ok !== true) {
            append('info', result.error ?? t('log.detectFailed'), false)
            return
          }
          for (const item of result.ports ?? []) {
            const collected = [
              item.path,
              item.chip,
              item.family,
              item.flashSize !== undefined ? `flash: ${item.flashSize}` : null,
              item.psram !== undefined ? `psram: ${item.psram}` : null,
              item.mac,
            ].filter((value) => value !== undefined && value !== null)
            append('info', collected.join(' · '), item.error === undefined)
            if (item.reason !== undefined) append('info', `${item.confidence}: ${item.reason}`, undefined)
            if (item.chip !== undefined || item.flashSize !== undefined) {
              setFacts({
                chip: item.chip,
                revision: item.revision,
                flashSize: item.flashSize,
                psram: item.psram,
                mac: item.mac,
              })
            }
            if (item.project !== undefined) {
              setProject(item.project)
              if (item.env !== undefined) append('info', `env: ${item.env}`, undefined)
            }
          }
        } catch (cause) {
          append('info', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        } finally {
          setBusy(null)
          await refresh()
        }
      }, [port, append, refresh, t])

      // Preflight for this machine: PlatformIO, pyserial, probes, ports.
      const checkEnv = useCallback(async () => {
        setBusy('doctor')
        try {
          const result = await call('/board-lab/doctor', {})
          append('info', result.summary, result.ok === true)
          for (const item of result.checks ?? []) {
            append('info', `${item.ok ? '✓' : '✗'} ${item.name}${item.detail !== undefined ? ` · ${item.detail}` : ''}`, item.ok === true)
            if (item.ok !== true && item.fix !== undefined) append('info', `→ ${item.fix}`, undefined)
          }
        } catch (cause) {
          append('info', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        } finally {
          setBusy(null)
        }
      }, [append])

      // Run the project's board-tests.json scenario and print the step table.
      const runTests = useCallback(async () => {
        if (project === '') return
        setBusy('test')
        try {
          const result = await call('/board-lab/test', {
            project,
            port: port === '' ? undefined : port,
            baud: Number(baud) || undefined,
          })
          setLastTest(result)
          append('test', `${result.ok ? t('log.testPassed') : t('log.testFailed')} · ${result.durationMs} ms`, result.ok)
          for (const step of result.steps ?? []) {
            append('test', `${step.ok ? '✓' : '✗'} ${step.action} · ${step.durationMs} ms${step.detail !== undefined ? ` · ${step.detail}` : ''}`, step.ok)
            if (step.ok === false && typeof step.text === 'string' && step.text !== '') append('test', step.text, false)
          }
          if (result.run !== undefined) append('system', `${t('log.report')}: ${result.run}`, undefined)
        } catch (cause) {
          append('test', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        } finally {
          setBusy(null)
          await refresh()
        }
      }, [project, port, baud, append, refresh, t])

      const shown = useMemo(() => {
        const needle = filter.trim().toLowerCase()
        if (needle === '') return log
        return log.filter((entry) => entry.text.toLowerCase().includes(needle))
      }, [log, filter])

      const copyLog = useCallback(async () => {
        const text = shown.map((entry) => `${entry.at.toLocaleTimeString()} [${entry.kind}] ${entry.text}`).join('\n')
        try {
          await window.navigator.clipboard.writeText(text)
          append('system', t('log.copied'), undefined)
        } catch {
          append('system', `✖ ${t('log.copyFailed')}`, false)
        }
      }, [shown, append, t])

      const disabled = busy !== null
      const toolchain = status?.toolchain
      const ports = status?.ports ?? []
      const chip = ports.find((item) => item.path === port)
      const factsReady = facts !== null && facts.chip !== undefined
      const deviceRows = [
        { label: t('device.chip'), value: facts?.chip, mono: false },
        { label: t('device.revision'), value: facts?.revision, mono: false },
        { label: t('device.flash'), value: facts?.flashSize, mono: false },
        { label: t('device.psram'), value: facts?.psram, mono: false },
        { label: t('device.mac'), value: facts?.mac, mono: true },
      ]
      const quick = ['PING', 'HELLO', 'VERSION', 'MODE 1', 'MODE 2']

      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('div', { style: { flex: 1, minWidth: 240 } },
            h('h1', { style: S.title }, t('panel.title')),
            h('p', { style: S.subtitle }, t('panel.subtitle')),
          ),
          h('div', { style: S.stats },
            statusItem(
              toolchain?.platformio ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
              'PlatformIO',
              toolchain?.platformio ? '' : t('status.toolchainMissing'),
            ),
            statusItem(
              toolchain?.armGcc ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)',
              'arm-none-eabi-gcc',
              toolchain?.armGcc ? '' : t('status.toolchainMissing'),
            ),
            statusItem(
              monitoring ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
              monitoring ? t('status.monitorOn') : t('status.monitorOff'),
            ),
            monitor?.stale === true
              ? statusItem('var(--dsw-alias-state-warn-primary)', t('status.monitorStale'))
              : null,
            button(S.quiet, disabled, { onClick: () => refresh(), title: t('action.refresh') }, t('action.refresh')),
          ),
        ),

        h('div', { style: S.main },
          h('div', { style: S.left },
            h('section', { style: S.card },
              h('div', { style: S.cardHead },
                h('span', { style: S.kicker }, t('section.connection')),
                h('div', { style: S.spacer }),
                monitoring
                  ? button(S.quiet, disabled, { onClick: stopMonitor }, t('action.monitorStop'))
                  : button(S.quiet, disabled || port === '', { onClick: startMonitor }, t('action.monitorStart')),
              ),
              h('div', { style: S.fields },
                h('label', { style: S.field },
                  h('span', { style: S.label }, t('field.project')),
                  h('select', {
                    style: S.input,
                    value: project,
                    onChange: (event) => setProject(event.target.value),
                  },
                    h('option', { value: '' }, t('field.projectAuto')),
                    (status?.projects ?? []).map((item) => h('option', { key: item.path, value: item.path }, `${item.name} (${item.kind})`)),
                  ),
                ),
                h('label', { style: S.field },
                  h('span', { style: S.label }, t('field.port')),
                  h('select', {
                    style: S.input,
                    value: port,
                    onChange: (event) => setPort(event.target.value),
                  },
                    h('option', { value: '' }, t('field.auto')),
                    ports.map((item) => h('option', { key: item.path, value: item.path }, `${item.path}${item.vendorId ? ` · ${item.vendorId}:${item.productId ?? '?'}` : ''}`)),
                  ),
                ),
                h('label', { style: S.field },
                  h('span', { style: S.label }, t('field.baud')),
                  h('input', {
                    style: S.input,
                    value: baud,
                    inputMode: 'numeric',
                    onChange: (event) => setBaud(event.target.value),
                  }),
                ),
                button(S.ghost, disabled || port === '', { onClick: detect },
                  busy === 'detect' ? t('action.detecting') : t('action.detect')),
              ),
              h('div', { style: S.actions },
                button(S.ghost, disabled || project === '', {
                  onClick: () => run('build', '/board-lab/build', { project }),
                }, busy === 'build' ? t('action.building') : t('action.build')),
                button(S.primary, disabled, {
                  onClick: () => run('flash', '/board-lab/flash', {
                    project: project === '' ? undefined : project,
                    port,
                    baud: Number(baud) || undefined,
                  }),
                }, busy === 'flash' ? t('action.flashing') : t('action.flash')),
                button(S.ghost, disabled || project === '', { onClick: runTests },
                  busy === 'test' ? t('action.testing') : t('action.test')),
                h('div', { style: S.spacer }),
                button(S.ghost, busy === 'doctor', { onClick: checkEnv },
                  busy === 'doctor' ? t('action.checking') : t('action.check')),
              ),
            ),

            h('section', { style: { ...S.card, ...S.logCard, paddingBottom: 12 } },
              h('div', { style: S.cardHead },
                h('span', { style: S.kicker }, t('log.title')),
                h('span', { style: S.dot(monitoring ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)') }),
                h('span', { style: S.hint }, monitoring ? t('log.live') : t('log.paused')),
                h('div', { style: S.spacer }),
                h('input', {
                  style: { ...S.input, height: 26, width: 150, fontSize: 12 },
                  value: filter,
                  placeholder: t('log.filter'),
                  onChange: (event) => setFilter(event.target.value),
                }),
                h('label', { style: { display: 'flex', gap: 5, alignItems: 'center', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                  h('input', { type: 'checkbox', checked: follow, onChange: (event) => setFollow(event.target.checked) }),
                  t('log.follow'),
                ),
                button(S.quiet, shown.length === 0, { onClick: copyLog }, t('log.copy')),
                button(S.quiet, log.length === 0, { onClick: () => setLog([]) }, t('log.clear')),
              ),
              error !== null
                ? h('div', { style: S.banner('var(--dsw-alias-state-error-primary)') },
                    h('strong', { style: { fontSize: 12 } }, t('status.error')),
                    h('span', { style: S.hint }, error))
                : null,
              portError !== null
                ? h('div', { style: S.banner('var(--dsw-alias-state-warn-primary)') },
                    h('strong', { style: { fontSize: 12 } }, t('status.monitorError')),
                    h('span', { style: S.hint }, portError))
                : null,
              h('div', { style: S.terminal, ref: logRef },
                shown.length === 0
                  ? (log.length === 0
                      ? h('div', { style: S.empty },
                          h('div', { style: S.emptyMark }, '>_'),
                          h('div', { style: S.emptyTitle }, t('log.emptyTitle')),
                          h('ol', { style: S.emptySteps },
                            h('li', { style: S.emptyStep }, h('span', { style: S.emptyNum }, '1'), h('span', null, t('log.stepDetect'))),
                            h('li', { style: S.emptyStep }, h('span', { style: S.emptyNum }, '2'), h('span', null, t('log.stepFlash'))),
                            h('li', { style: S.emptyStep }, h('span', { style: S.emptyNum }, '3'), h('span', null, t('log.stepWatch'))),
                          ),
                          h('div', { style: S.emptyHint }, t('log.emptyHint')),
                        )
                      : h('span', { style: S.hint }, t('log.noMatch')))
                  : shown.map((entry) => h('div', { key: entry.id, style: S.logRow },
                      h('span', { style: S.time }, entry.at.toLocaleTimeString()),
                      h('span', { style: S.tag }, entry.kind),
                      h('span', { style: S.logText(entry) }, entry.text),
                    )),
              ),
              h('div', { style: S.sendRow },
                h('span', { style: S.prompt }, '›'),
                h('input', {
                  style: S.input,
                  value: writeText,
                  placeholder: t('field.write'),
                  onChange: (event) => setWriteText(event.target.value),
                  onKeyDown: (event) => { if (event.key === 'Enter') send() },
                }),
                button(S.ghost, disabled || writeText === '', { onClick: send }, t('action.send')),
              ),
            ),

            h('section', { style: { ...S.card, gap: 8 } },
              h('div', { style: S.cardHead },
                h('span', { style: S.kicker }, t('section.test')),
                h('div', { style: S.spacer }),
                lastTest !== null
                  ? h('span', { style: { ...S.hint, fontSize: 11 } }, `${lastTest.durationMs} ms`)
                  : null,
              ),
              lastTest === null
                ? h('div', { style: S.hint }, t('test.none'))
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5 } },
                      h('span', { style: { color: lastTest.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } }, lastTest.ok ? '✓' : '✗'),
                      h('span', null, lastTest.ok ? t('log.testPassed') : t('log.testFailed')),
                      h('span', { style: S.time }, `${(lastTest.steps ?? []).length} ${t('test.steps')} · ${lastTest.durationMs} ms`),
                    ),
                    h('div', { style: S.stepsInline },
                      (lastTest.steps ?? []).slice(0, 6).map((step, index) => h('span', {
                        key: `${step.action}-${index}`,
                        style: { ...S.stepChip(step.ok), color: step.ok ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-state-error-primary)' },
                        title: step.detail,
                      },
                        h('span', { style: { color: step.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } }, step.ok ? '✓' : '✗'),
                        step.action,
                        h('span', { style: S.time }, `${step.durationMs} ms`),
                      )),
                      (lastTest.steps ?? []).length > 6
                        ? h('span', { style: { ...S.stepChip(true), color: 'var(--dsw-alias-label-secondary)' } }, `+${lastTest.steps.length - 6}`)
                        : null,
                    ),
                    lastTest.run !== undefined
                      ? h('div', { style: { ...S.monoValue, color: 'var(--dsw-alias-label-secondary)', ...S.nowrap } }, `${t('log.report')}: ${lastTest.run}`)
                      : null,
                  ),
            ),
          ),

          h('aside', { style: S.rail },
            h('section', { style: S.card },
              h('div', { style: S.cardHead },
                h('span', { style: S.kicker }, t('device.title')),
                h('div', { style: S.spacer }),
                factsReady
                  ? h('span', { style: { ...S.hint, fontSize: 11 } }, t('device.fromChip'))
                  : null,
              ),
              h('div', { style: S.fact },
                h('span', { style: S.factLabel }, t('device.port')),
                h('span', { style: S.monoValue }, port === '' ? t('device.none') : port)),
              chip !== undefined && chip.byId !== undefined
                ? h('div', { style: S.fact },
                    h('span', { style: S.factLabel }, t('device.usb')),
                    h('span', { style: { ...S.monoValue, ...S.nowrap }, title: chip.byId }, chip.byId))
                : null,
              deviceRows.map((row) => h('div', { key: row.label, style: S.fact },
                h('span', { style: S.factLabel }, row.label),
                h('span', { style: row.mono ? S.monoValue : S.factValue }, row.value ?? t('device.unknown')),
              )),
              factsReady
                ? null
                : h('div', { style: S.hint }, t('device.empty')),
              button(S.ghost, disabled || port === '', { onClick: inspect },
                busy === 'info' ? t('action.inspecting') : t('action.info')),
            ),

            h('section', { style: S.card },
              h('div', { style: S.cardHead },
                h('span', { style: S.kicker }, t('section.quick')),
                h('div', { style: S.spacer }),
                button(S.quiet, disabled || port === '', { onClick: resetBoard }, t('action.reset')),
              ),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                quick.map((text) => h('button', {
                  key: text,
                  style: { ...S.chip, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer' },
                  disabled,
                  onClick: () => sendText(text),
                }, text)),
              ),
              h('div', { style: S.sectionGap }),
              h('div', { style: S.hint }, monitoring ? t('log.liveHint') : t('log.idleHint')),
            ),

          ),
        ),
      )
    }

    function BoardLabIcon(props) {
      const size = props?.size ?? 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('rect', { x: 3, y: 5, width: 13, height: 14, rx: 2 }),
        h('rect', { x: 7, y: 9, width: 5, height: 6, rx: 1 }),
        h('path', { d: 'M16 8h4M16 12h3M16 16h4' }),
      )
    }

    const DICTIONARIES = {
      en: {
        'panel.title': 'Board lab',
        'panel.subtitle': 'Build, flash and watch the device without unplugging it.',
        'section.connection': 'Board',
        'section.quick': 'Commands',
        'section.test': 'Scenario run',
        'device.title': 'Device',
        'device.port': 'Port',
        'device.usb': 'USB',
        'device.chip': 'Chip',
        'device.revision': 'Revision',
        'device.flash': 'Flash',
        'device.psram': 'PSRAM',
        'device.mac': 'MAC',
        'device.unknown': '—',
        'device.none': 'no port',
        'device.empty': 'Press “Chip info” to read the identity through esptool.',
        'device.fromChip': 'esptool',
        'status.platformio': 'PlatformIO',
        'status.armgcc': 'arm-none-eabi-gcc',
        'status.monitorOn': 'monitor on',
        'status.monitorOff': 'monitor off',
        'status.monitorStale': 'monitor hung',
        'status.monitorError': 'Serial port problem',
        'status.error': 'Backend error',
        'status.toolchainMissing': 'toolchain is not installed yet',
        'action.refresh': 'Refresh',
        'action.build': 'Build',
        'action.flash': 'Flash',
        'action.building': 'Building…',
        'action.flashing': 'Flashing…',
        'action.info': 'Chip info',
        'action.inspecting': 'Reading chip…',
        'action.check': 'Check setup',
        'action.checking': 'Checking…',
        'action.detect': 'Detect board',
        'action.detecting': 'Detecting…',
        'action.test': 'Run tests',
        'action.testing': 'Running tests…',
        'action.monitorStart': 'Start monitor',
        'action.monitorStop': 'Stop monitor',
        'action.reset': 'Reset',
        'action.send': 'Send',
        'field.project': 'Project',
        'field.projectAuto': 'auto-detect from board',
        'field.port': 'Serial port',
        'field.auto': 'auto',
        'field.baud': 'Baud',
        'field.write': 'Send to device…',
        'log.title': 'Device log',
        'log.live': 'live',
        'log.paused': 'paused',
        'log.liveHint': 'Output streams in while the monitor holds the port.',
        'log.idleHint': 'Start the monitor to stream output; flashing works without it.',
        'log.follow': 'Follow',
        'log.filter': 'Filter…',
        'log.copy': 'Copy',
        'log.copied': 'log copied to the clipboard',
        'log.copyFailed': 'clipboard is unavailable',
        'log.noMatch': 'nothing matches the filter',
        'log.clear': 'Clear',
        'log.empty': 'Start the monitor or flash the board to see device output.',
        'log.tipMonitor': '“Start monitor” opens the port and streams output here; flashing keeps it alive.',
        'log.tipInfo': '“Chip info” reads chip, flash, PSRAM and MAC through esptool.',
        'log.tipTests': '“Run tests” plays the project board-tests.json and reports every step.',
        'log.emptyTitle': 'The device is not streaming yet',
        'log.stepDetect': 'Detect the board — the port and project are picked automatically',
        'log.stepFlash': 'Flash — the monitor restarts and the boot log lands here',
        'log.stepWatch': 'Watch live output and send commands straight from the field below',
        'log.emptyHint': 'Tip: PING → PONG is the fastest way to check the link.',
        'log.monitorStarted': 'monitor started on',
        'log.monitorStopped': 'monitor stopped on',
        'log.monitorRestarted': 'monitor restarted after flash',
        'log.monitorIdle': 'monitor was not running',
        'log.reset': 'reset pulse sent',
        'log.detectFailed': 'board detection failed',
        'log.testPassed': 'tests passed',
        'log.testFailed': 'tests failed',
        'log.report': 'report',
        'test.none': 'No scenario has run here yet.',
        'test.steps': 'steps',
      },
      ru: {
        'panel.title': 'Лаборатория плат',
        'panel.subtitle': 'Сборка, прошивка и живой UART — не отключая плату.',
        'section.connection': 'Плата',
        'section.quick': 'Команды',
        'section.test': 'Прогон сценария',
        'device.title': 'Устройство',
        'device.port': 'Порт',
        'device.usb': 'USB',
        'device.chip': 'Чип',
        'device.revision': 'Ревизия',
        'device.flash': 'Флеш',
        'device.psram': 'PSRAM',
        'device.mac': 'MAC',
        'device.unknown': '—',
        'device.none': 'нет порта',
        'device.empty': 'Нажмите «Инфо о чипе», чтобы прочитать паспорт через esptool.',
        'device.fromChip': 'esptool',
        'status.platformio': 'PlatformIO',
        'status.armgcc': 'arm-none-eabi-gcc',
        'status.monitorOn': 'монитор включён',
        'status.monitorOff': 'монитор выключен',
        'status.monitorStale': 'монитор завис',
        'status.monitorError': 'Проблема с портом',
        'status.error': 'Ошибка бэкенда',
        'status.toolchainMissing': 'тулчейн ещё не установлен',
        'action.refresh': 'Обновить',
        'action.build': 'Собрать',
        'action.flash': 'Прошить',
        'action.building': 'Сборка…',
        'action.flashing': 'Прошивка…',
        'action.info': 'Инфо о чипе',
        'action.inspecting': 'Читаю чип…',
        'action.check': 'Проверить среду',
        'action.checking': 'Проверяю…',
        'action.detect': 'Определить плату',
        'action.detecting': 'Определяю…',
        'action.test': 'Прогнать тесты',
        'action.testing': 'Прогоняю тесты…',
        'action.monitorStart': 'Включить монитор',
        'action.monitorStop': 'Выключить монитор',
        'action.reset': 'Сброс',
        'action.send': 'Отправить',
        'field.project': 'Проект',
        'field.projectAuto': 'автоопределение по плате',
        'field.port': 'Порт',
        'field.auto': 'авто',
        'field.baud': 'Скорость',
        'field.write': 'Отправить в устройство…',
        'log.title': 'Лог устройства',
        'log.live': 'вживую',
        'log.paused': 'на паузе',
        'log.liveHint': 'Вывод идёт, пока монитор держит порт.',
        'log.idleHint': 'Включите монитор для живого вывода; прошивка работает и без него.',
        'log.follow': 'Автоскролл',
        'log.filter': 'Фильтр…',
        'log.copy': 'Копировать',
        'log.copied': 'лог скопирован в буфер обмена',
        'log.copyFailed': 'буфер обмена недоступен',
        'log.noMatch': 'по фильтру ничего нет',
        'log.clear': 'Очистить',
        'log.empty': 'Включите монитор или прошейте плату, чтобы увидеть вывод устройства.',
        'log.tipMonitor': '«Включить монитор» открывает порт и льёт вывод сюда; прошивка его не сбрасывает.',
        'log.tipInfo': '«Инфо о чипе» читает чип, флеш, PSRAM и MAC через esptool.',
        'log.tipTests': '«Прогнать тесты» проигрывает board-tests.json проекта и показывает каждый шаг.',
        'log.emptyTitle': 'Устройство пока не пишет в лог',
        'log.stepDetect': 'Определите плату — порт и проект подставятся сами',
        'log.stepFlash': 'Прошейте — монитор перезапустится, загрузочный лог придёт сюда',
        'log.stepWatch': 'Смотрите вывод и отправляйте команды из поля ниже',
        'log.emptyHint': 'Совет: PING → PONG — самый быстрый способ проверить связь.',
        'log.monitorStarted': 'монитор запущен на',
        'log.monitorStopped': 'монитор остановлен на',
        'log.monitorRestarted': 'монитор перезапущен после прошивки',
        'log.monitorIdle': 'монитор не был запущен',
        'log.reset': 'импульс сброса отправлен',
        'log.detectFailed': 'не удалось определить плату',
        'log.testPassed': 'тесты прошли',
        'log.testFailed': 'тесты провалились',
        'log.report': 'отчёт',
        'test.none': 'Здесь ещё не было прогонов.',
        'test.steps': 'шагов',
      },
    }

    let translate = (key) => key

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.locale
        ctx.effect(() => {
          const disposers = Object.entries(DICTIONARIES).map(([id, dict]) => locale.register(NS, id, dict))
          return () => {
            for (const dispose of disposers) dispose()
          }
        })
        translate = locale.bind(NS)

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'board-lab',
          locale: NS,
        }, BoardLabPage))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'board-lab',
          order: 40,
          label: () => translate('panel.title'),
          locale: NS,
        }, BoardLabIcon))
      },
    }
  },
})
