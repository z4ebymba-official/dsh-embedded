window.__ModuleLoader__.load({
  id: 'dsh-board-lab',
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
        gridTemplateColumns: 'minmax(0, 1fr) minmax(320px, 1.05fr)',
        gap: 12,
        alignItems: 'stretch',
        flex: 1,
        minHeight: 0,
      },
      left: { display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, minWidth: 0, overflow: 'hidden' },
      rail: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, minWidth: 0 },
      logCard: { flex: '1 1 auto', minHeight: 180 },
      testsCard: { flex: '0 0 auto' },
      mapCard: { flex: '1 1 auto', minHeight: 260, display: 'flex', flexDirection: 'column', gap: 8 },
      deviceCard: { flex: '0 0 auto', maxHeight: 132, minHeight: 0, overflow: 'auto' },
      mapBody: {
        flex: '1 1 auto',
        minHeight: 0,
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'stretch',
        position: 'relative',
        minWidth: 0,
      },
      mapNote: { position: 'absolute', left: 8, bottom: 5, fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)' },
      mapPrompt: {
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 6,
        padding: '8px 10px',
        borderRadius: 7,
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      mapPromptText: {
        fontFamily: MONO,
        fontSize: 11.5,
        lineHeight: '17px',
        color: 'var(--dsw-alias-label-secondary)',
        userSelect: 'all',
      },
      mapWrap: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6 },
      mapView: {
        position: 'relative',
        flex: '1 1 auto',
        minHeight: 0,
        overflow: 'hidden',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1)',
        cursor: 'grab',
        touchAction: 'none',
      },
      mapZoom: { width: '100%', height: '100%', transformOrigin: '0 0' },
      zoomBar: {
        position: 'absolute',
        right: 6,
        bottom: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 4px',
        borderRadius: 7,
        background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 82%, transparent)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      zoomBtn: {
        width: 20,
        height: 20,
        padding: 0,
        border: 'none',
        borderRadius: 5,
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        lineHeight: '20px',
        cursor: 'pointer',
      },
      zoomLevel: { fontSize: 9.5, fontFamily: MONO, color: 'var(--dsw-alias-label-tertiary)', minWidth: 30, textAlign: 'right' },
      pinTable: {
        flex: '0 1 42%',
        minHeight: 96,
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        overflow: 'hidden',
      },
      pinTableHead: {
        display: 'grid',
        gridTemplateColumns: '34px 1fr 1.1fr',
        gap: 6,
        padding: '4px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 10.5,
        color: 'var(--dsw-alias-label-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: '0.03em',
      },
      pinTableBody: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' },
      pinTableRow: {
        display: 'grid',
        gridTemplateColumns: '34px 1fr 1.1fr',
        gap: 6,
        padding: '3px 8px',
        fontSize: 11,
        cursor: 'pointer',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      pinTableRowSel: { background: 'var(--dsw-alias-bg-layer-1)', boxShadow: 'inset 2px 0 0 var(--dsw-alias-brand-primary)' },
      pinNo: { fontFamily: MONO, fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)', textAlign: 'right' },
      pinName: { fontFamily: MONO, fontSize: 10.5, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      pinWired: { fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      mapEmpty: {
        flex: '1 1 auto',
        minHeight: 150,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '16px 20px',
        textAlign: 'center',
        borderRadius: 8,
        border: '1px dashed var(--dsw-alias-border-l2)',
      },
      testsCard: { flex: '0 0 auto' },
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
      control: {
        display: 'grid',
        gap: 6,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        flex: '0 0 auto',
      },
      fieldRow: { display: 'grid', gridTemplateColumns: '54px minmax(0, 1fr) auto', gap: 6, alignItems: 'center', minWidth: 0 },
      fieldLabel: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      controlActions: { display: 'flex', gap: 6, marginTop: 2 },
      railCard: { flex: '0 0 auto', maxHeight: '32%', minHeight: 0 },
      railGrow: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' },
      cpList: { display: 'flex', flexDirection: 'column', overflow: 'auto', minHeight: 0 },
      cpRow: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        gap: 6,
        alignItems: 'center',
        padding: '5px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      cpTitle: { fontSize: 12.5, lineHeight: '16px' },
      cpMeta: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', lineHeight: '14px' },
      tabRow: { display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 },
      tab: (active) => ({
        height: 22,
        padding: '0 7px',
        borderRadius: 5,
        border: 'none',
        background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: 11.5,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
      }),
      pinRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      cpBadge: (kind) => ({
        display: 'inline-block',
        marginTop: 2,
        padding: '0 5px',
        borderRadius: 4,
        fontSize: 10,
        lineHeight: '14px',
        color: kind === 'done' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)',
        border: `1px solid ${kind === 'done' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)'}`,
      }),
      stateNote: {
        display: 'flex',
        gap: 7,
        alignItems: 'flex-start',
        padding: '6px 8px',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-state-success-primary)',
        color: 'var(--dsw-alias-label-primary)',
      },
      folderRow: { display: 'flex', gap: 6, flex: '0 0 auto' },
      cpBtn: {
        width: 24,
        height: 24,
        padding: 0,
        borderRadius: 5,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '22px',
        cursor: 'pointer',
      },
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

    /** A file name cut down to a board map id: lowercase, digits, dot, dash. */
    function mapSlug(name) {
      return String(name ?? '')
        .toLowerCase()
        .replace(/\.[a-z0-9]+$/, '')
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[-._]+|[-._]+$/g, '')
        .slice(0, 48)
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

    // One pin table per board (maps/*.json in the bundle) drawn as the board
    // itself: pin headers on the edges, pads with names inside, what is wired
    // to a pad next to it. Click a pad to say what sits on that pin.
    const MAP_PITCH = 21
    const MAP_LABEL = 96
    const MAP_PAD = 9

    // A board drawn as a wide rectangle: the two long headers sit along the top
    // and bottom edges, where a 300 px rail can actually scroll through them.
    // Rotating the board on its side is the whole point — a 20-pin header read
    // top-to-bottom is a wall of sideways text, read left-to-right it is a row.
    const ROW_PITCH = 34

    function boardMapSvg(map, pins, selected, onPick) {
      const sides = map?.sides ?? {}
      const top = Array.isArray(sides.top) ? sides.top : []
      const bottom = Array.isArray(sides.bottom) ? sides.bottom : []
      const left = Array.isArray(sides.left) ? sides.left : []
      const right = Array.isArray(sides.right) ? sides.right : []
      // Laid on its side: the left header becomes the top row, the right header
      // the bottom row. Columns are for the few boards that have end headers.
      const rows = Math.max(left.length, right.length, 1)
      const columns = Math.max(top.length, bottom.length, 0)
      const bodyW = Math.max(120, rows * ROW_PITCH + 24)
      const bodyH = Math.max(58, columns * MAP_PITCH + 24)
      const topBand = left.length === 0 ? 0 : ROW_PITCH + 6
      const bottomBand = right.length === 0 ? 0 : ROW_PITCH + 6
      const width = MAP_LABEL + 14 + bodyW + 14 + MAP_LABEL
      const height = topBand + bodyH + bottomBand
      const bx = MAP_LABEL + 14
      const by = topBand
      const on = (pin) => pins[pin] !== undefined
      const parts = []
      const text = (key, x, y, content, color, anchor, rotate, size) => parts.push(h('text', {
        key: `t-${key}`, x, y, fill: color, fontSize: size ?? 9, fontFamily: MONO, textAnchor: anchor,
        transform: rotate === true ? `rotate(-90 ${x} ${y})` : undefined,
      }, content))

      const strip = (key, x, y, w, hgt) => parts.push(h('rect', {
        key: `s-${key}`, x, y, width: w, height: hgt, rx: 3,
        fill: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-layer-2))',
        stroke: 'var(--dsw-alias-border-l1)',
      }))
      const rowStart = (count) => bx + (bodyW - (count - 1) * ROW_PITCH) / 2
      const colStart = by + MAP_PITCH / 2 + (bodyH - columns * MAP_PITCH) / 2
      const span = (count, pitch) => (count <= 1 ? 0 : (count - 1) * pitch)
      if (left.length > 0) strip('t', rowStart(left.length) - MAP_PAD / 2 - 2, by - MAP_PAD / 2 - 2, span(left.length, ROW_PITCH) + MAP_PAD + 4, MAP_PAD + 4)
      if (right.length > 0) strip('b', rowStart(right.length) - MAP_PAD / 2 - 2, by + bodyH - MAP_PAD / 2 - 2, span(right.length, ROW_PITCH) + MAP_PAD + 4, MAP_PAD + 4)
      if (top.length > 0) strip('l', bx - MAP_PAD / 2 - 2, colStart - MAP_PAD / 2 - 2, MAP_PAD + 4, span(top.length, MAP_PITCH) + MAP_PAD + 4)
      if (bottom.length > 0) strip('r', bx + bodyW - MAP_PAD / 2 - 2, colStart - MAP_PAD / 2 - 2, MAP_PAD + 4, span(bottom.length, MAP_PITCH) + MAP_PAD + 4)

      parts.push(h('rect', {
        key: 'body', x: bx, y: by, width: bodyW, height: bodyH, rx: 9,
        fill: 'var(--dsw-alias-bg-layer-2)', stroke: 'var(--dsw-alias-border-l2)',
      }))
      parts.push(h('text', {
        key: 'body-name', x: bx + bodyW / 2, y: by + bodyH / 2 + 4,
        fill: 'var(--dsw-alias-label-tertiary)', fontSize: 10.5, fontWeight: 600,
        textAnchor: 'middle', style: { pointerEvents: 'none' },
      }, map?.name ?? ''))
      if (Object.keys(pins).length > 0) {
        parts.push(h('text', {
          key: 'body-count', x: bx + bodyW / 2, y: by + bodyH / 2 + 18,
          fill: 'var(--dsw-alias-label-tertiary)', fontSize: 8.5, textAnchor: 'middle', fontFamily: MONO,
        }, `${Object.keys(pins).length}`))
      }

      const pad = (key, cx, cy, pin, below) => {
        const filled = on(pin)
        const sel = selected === pin
        parts.push(h('g', { key: `g-${key}`, style: { cursor: 'pointer' }, onClick: () => onPick(pin) },
          h('title', { key: 'hint' }, filled ? `${pin} → ${pins[pin].label}` : pin),
          h('rect', {
            key: 'pad', x: cx - MAP_PAD / 2, y: cy - MAP_PAD / 2, width: MAP_PAD, height: MAP_PAD, rx: 2,
            fill: filled ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-bg-base)',
            stroke: sel ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
            strokeWidth: sel ? 2 : 1,
          }),
          sel ? h('rect', {
            key: 'ring', x: cx - MAP_PAD / 2 - 3, y: cy - MAP_PAD / 2 - 3,
            width: MAP_PAD + 6, height: MAP_PAD + 6, rx: 4, fill: 'none',
            stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1, opacity: 0.6,
          }) : null,
          below === true
            ? h('text', {
                key: 'name', x: cx, y: cy + MAP_PAD / 2 + 11, fill: filled ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
                fontSize: 8.5, fontFamily: MONO, textAnchor: 'middle',
              }, pin)
            : null,
          below === false
            ? h('text', {
                key: 'name', x: cx, y: cy - MAP_PAD / 2 - 6, fill: filled ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
                fontSize: 8.5, fontFamily: MONO, textAnchor: 'middle',
              }, pin)
            : null,
          below !== undefined && filled
            ? h('text', {
                key: 'label',
                x: cx,
                y: below === true ? cy + MAP_PAD / 2 + 21 : cy - MAP_PAD / 2 - 16,
                fill: 'var(--dsw-alias-label-tertiary)', fontSize: 7.6, fontFamily: MONO, textAnchor: 'middle',
              }, pins[pin].label.length > 7 ? `${pins[pin].label.slice(0, 7)}…` : pins[pin].label)
            : null,
        ))
      }
      const pinColor = (pin) => (on(pin) ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)')

      left.forEach((pin, index) => {
        const cx = rowStart(left.length) + index * ROW_PITCH
        pad(`t${index}`, cx, by, pin, false)
      })
      right.forEach((pin, index) => {
        const cx = rowStart(right.length) + index * ROW_PITCH
        pad(`b${index}`, cx, by + bodyH, pin, true)
      })
      top.forEach((pin, index) => {
        const cy = colStart + index * MAP_PITCH
        pad(`l${index}`, bx, cy, pin)
        text(`l${index}`, bx - MAP_PAD / 2 - 7, cy + 3, pin, pinColor(pin), 'end')
        if (on(pin)) text(`ll${index}`, bx - MAP_PAD / 2 - 7, cy + 12.5, pins[pin].label, 'var(--dsw-alias-label-tertiary)', 'end', false, 8.4)
      })
      bottom.forEach((pin, index) => {
        const cy = colStart + index * MAP_PITCH
        pad(`r${index}`, bx + bodyW, cy, pin)
        text(`r${index}`, bx + bodyW + MAP_PAD / 2 + 7, cy + 3, pin, pinColor(pin), 'start')
        if (on(pin)) text(`rl${index}`, bx + bodyW + MAP_PAD / 2 + 7, cy + 12.5, pins[pin].label, 'var(--dsw-alias-label-tertiary)', 'start', false, 8.4)
      })
      return h('svg', {
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': map?.name ?? 'board map',
        style: { display: 'block', width: '100%', height: '100%' },
        preserveAspectRatio: 'xMidYMid meet',
      }, parts)
    }

    // A chip drawn from its package and pin table: `package.kind` cuts the
    // outline into sides, the pin number decides where the label sits. The map
    // holds names only, in physical order — a datasheet pin table is the input,
    // there are no coordinates to place by eye.
    const CHIP_LABEL = 124

    function chipMap(map, pins, selected, onPick) {
      const entries = Array.isArray(map?.pins) ? map.pins : []
      const names = entries.map((entry) => (typeof entry === 'string' ? entry : String(entry?.name ?? '')))
      const funcsOf = (index) => {
        const func = entries[index]?.func
        return Array.isArray(func) && func.length > 0 ? ` · ${func.join(' ')}` : ''
      }
      if (names.length === 0) return null
      const kind = String(map?.package?.kind ?? 'qfp').toLowerCase()
      const quad = kind === 'qfp' || kind === 'qfn'
      const perSide = Math.max(1, Math.round(names.length / (quad ? 4 : 2)))
      const pad = 9
      const span = perSide * MAP_PITCH
      const bodySpan = span + 30
      const bodyW = quad ? bodySpan : Math.max(74, Math.round(bodySpan * 0.42))
      const bodyH = bodySpan
      const label = CHIP_LABEL
      const width = label * 2 + bodyW
      const height = label * 2 + bodyH
      const bx = label
      const by = label
      const start = (bodyH - span) / 2 + MAP_PITCH / 2
      const hStart = bx + (bodyW - span) / 2 + MAP_PITCH / 2
      const hEnd = bx + bodyW - (bodyW - span) / 2 - MAP_PITCH / 2
      const inside = kind === 'qfn'
      const on = (key) => pins[key] !== undefined
      const parts = []

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

      // The package itself, with its name silkscreened in the middle.
      parts.push(h('rect', {
        key: 'body', x: bx, y: by, width: bodyW, height: bodyH, rx: 7,
        fill: 'var(--dsw-alias-bg-layer-2)', stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1.5,
      }))
      parts.push(h('circle', {
        key: 'pin1', cx: bx + 13, cy: by + 13, r: 4,
        fill: 'none', stroke: 'var(--dsw-alias-label-tertiary)', strokeWidth: 1.5,
      }))
      parts.push(h('text', {
        key: 'title', x: bx + bodyW / 2, y: by + bodyH / 2 + 4,
        fill: 'var(--dsw-alias-label-tertiary)', fontSize: 11, fontWeight: 600,
        textAnchor: 'middle', style: { pointerEvents: 'none' },
      }, map?.name ?? ''))
      parts.push(h('text', {
        key: 'pkg', x: bx + bodyW / 2, y: by + bodyH / 2 + 18,
        fill: 'var(--dsw-alias-label-tertiary)', fontSize: 8, fontFamily: MONO,
        textAnchor: 'middle', style: { pointerEvents: 'none' },
      }, `${kind.toUpperCase()}${names.length}`))

      const outward = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }
      for (const slot of slots) {
        const key = String(slot.index + 1)
        const name = names[slot.index]
        const [dx, dy] = outward[slot.side]
        const reach = inside ? -7 : 13
        const ex = slot.cx + dx * reach
        const ey = slot.cy + dy * reach
        const wired = on(key)
        const sel = selected === key
        const color = wired ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)'
        parts.push(h('g', {
          key: `pin-${key}`, style: { cursor: 'pointer' }, onClick: () => onPick(key),
        },
          h('title', { key: 'hint' }, `${key} ${name}${wired ? ` → ${pins[key].label}` : ''}${funcsOf(slot.index)}`),
          h('line', {
            key: 'lead', x1: slot.cx, y1: slot.cy, x2: ex, y2: ey,
            stroke: color, strokeWidth: 4.5, strokeLinecap: 'round',
          }),
          h('rect', {
            key: 'pad', x: ex - pad / 2, y: ey - pad / 2, width: pad, height: pad, rx: 2,
            fill: wired ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-bg-base)',
            stroke: sel ? 'var(--dsw-alias-brand-primary)' : wired ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l2)',
            strokeWidth: sel ? 2.5 : 1.2,
          }),
          sel ? h('rect', {
            key: 'ring', x: ex - pad / 2 - 3, y: ey - pad / 2 - 3, width: pad + 6, height: pad + 6, rx: 4,
            fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1, opacity: 0.6,
          }) : null,
        ))
        const labelAt = {
          left: [bx - 16, slot.cy + 3.2, 'end', false],
          right: [bx + bodyW + 16, slot.cy + 3.2, 'start', false],
          top: [slot.cx + 3.2, by - 16, 'start', true],
          bottom: [slot.cx - 3.2, by + bodyH + 16, 'end', true],
        }[slot.side]
        parts.push(h('text', {
          key: `name-${key}`, x: labelAt[0], y: labelAt[1], fill: color,
          fontSize: 9, fontFamily: MONO, textAnchor: labelAt[2],
          transform: labelAt[3] === true ? `rotate(-90 ${labelAt[0]} ${labelAt[1]})` : undefined,
          style: { pointerEvents: 'none' },
        }, name))
        const numberAt = {
          left: [bx + 8, slot.cy + 2.8, 'start', false],
          right: [bx + bodyW - 8, slot.cy + 2.8, 'end', false],
          top: [slot.cx + 2.8, by + 8, 'start', true],
          bottom: [slot.cx - 2.8, by + bodyH - 8, 'end', true],
        }[slot.side]
        parts.push(h('text', {
          key: `num-${key}`, x: numberAt[0], y: numberAt[1], fill: 'var(--dsw-alias-label-tertiary)',
          fontSize: 7, fontFamily: MONO, textAnchor: numberAt[2],
          transform: numberAt[3] === true ? `rotate(-90 ${numberAt[0]} ${numberAt[1]})` : undefined,
          style: { pointerEvents: 'none' },
        }, key))
        if (wired) {
          const wiredAt = {
            left: [bx - 16, slot.cy + 14, 'end', false],
            right: [bx + bodyW + 16, slot.cy + 14, 'start', false],
            top: [slot.cx + 14, by - 16, 'start', true],
            bottom: [slot.cx - 14, by + bodyH + 16, 'end', true],
          }[slot.side]
          parts.push(h('text', {
            key: `label-${key}`, x: wiredAt[0], y: wiredAt[1], fill: 'var(--dsw-alias-label-tertiary)',
            fontSize: 7.6, fontFamily: MONO, textAnchor: wiredAt[2],
            transform: wiredAt[3] === true ? `rotate(-90 ${wiredAt[0]} ${wiredAt[1]})` : undefined,
            style: { pointerEvents: 'none' },
          }, String(pins[key].label).length > 16 ? `${String(pins[key].label).slice(0, 15)}…` : pins[key].label))
        }
      }
      return h('svg', {
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: 'xMidYMid meet',
        role: 'img',
        'aria-label': map?.name ?? 'chip',
        style: { display: 'block', width: '100%', height: '100%', maxHeight: '100%' },
      }, parts)
    }

    /** A board the agent drew as plain shapes: chips, connectors and pads. */
    function schematicMap(map, pins, selected, onPick) {
      const VW = 1000
      const VH = Math.round(VW * (Number(map?.aspect) > 0 ? Number(map.aspect) : 1))
      const tone = (value) => ({
        board: 'var(--dsw-alias-bg-layer-2)',
        chip: 'var(--dsw-alias-bg-layer-1)',
        metal: 'var(--dsw-alias-border-l2)',
        accent: 'var(--dsw-alias-brand-primary)',
        hole: 'var(--dsw-alias-bg-base)',
      }[value] ?? null)
      const parts = []
      for (const [index, shape] of (Array.isArray(map?.draw) ? map.draw : []).entries()) {
        const x = Number(shape.x) * VW
        const y = Number(shape.y) * VH
        const fill = tone(shape.fill)
        if (shape.type === 'text') {
          parts.push(h('text', {
            key: `t${index}`, x, y,
            fill: fill ?? 'var(--dsw-alias-label-tertiary)',
            fontSize: Number(shape.size) > 0 ? Number(shape.size) : 22,
            fontFamily: MONO, fontWeight: 600, style: { pointerEvents: 'none' },
          }, shape.text))
          continue
        }
        const w = Number(shape.w) * VW
        const hgt = Number(shape.h) * VH
        parts.push(h('rect', {
          key: `r${index}`, x, y, width: w, height: hgt, rx: 10,
          fill: fill ?? 'var(--dsw-alias-bg-layer-1)',
          stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 2,
        }))
        if (typeof shape.label === 'string' && shape.label !== '') {
          parts.push(h('text', {
            key: `rl${index}`, x: x + w / 2, y: y + hgt / 2 + 8,
            fill: 'var(--dsw-alias-label-secondary)', fontSize: 24, fontWeight: 600,
            textAnchor: 'middle', style: { pointerEvents: 'none' },
          }, shape.label))
        }
      }
      for (const [index, pad] of (Array.isArray(map?.pads) ? map.pads : []).entries()) {
        const pin = String(pad.pin)
        const wired = pins[pin] !== undefined
        const sel = selected === pin
        const cx = Number(pad.x) * VW
        const cy = Number(pad.y) * VH
        const outward = cx < VW / 2
        const tx = outward ? cx + 26 : cx - 26
        parts.push(h('g', {
          key: `p${index}`, style: { cursor: 'pointer' }, onClick: () => onPick(pin),
        },
          h('title', { key: 'hint' }, wired ? `${pin} → ${pins[pin].label}` : pin),
          h('circle', {
            key: 'dot', cx, cy, r: 16,
            fill: wired ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-bg-base)',
            stroke: sel ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
            strokeWidth: sel ? 4 : 2,
          }),
          h('text', {
            key: 'name', x: tx, y: cy + 8,
            fill: wired ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
            fontSize: 22, fontFamily: MONO, textAnchor: outward ? 'start' : 'end',
            style: { pointerEvents: 'none' },
          }, pin),
          wired
            ? h('text', {
                key: 'label', x: tx, y: cy + 34,
                fill: 'var(--dsw-alias-label-tertiary)', fontSize: 19, fontFamily: MONO,
                textAnchor: outward ? 'start' : 'end', style: { pointerEvents: 'none' },
              }, pins[pin].label)
            : null,
        ))
      }
      return h('svg', {
        viewBox: `0 0 ${VW} ${VH}`,
        preserveAspectRatio: 'xMidYMid meet',
        role: 'img',
        'aria-label': map?.name ?? 'board map',
        style: { display: 'block', width: '100%', height: '100%', maxHeight: '100%' },
      }, parts)
    }

    // Zoom and pan for the map drawing. A wide board does not fit a 300 px rail,
    // so the drawing is a window onto it: wheel zooms at the cursor, drag pans,
    // double-click fits. Buttons are for the people who do not guess gestures;
    // the transition is short enough to read as one move, not a jump.
    const MAP_ZOOM_MIN = 0.4
    const MAP_ZOOM_MAX = 6

    function MapView({ children, t, initial }) {
      const startScale = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, Number(initial) > 0 ? Number(initial) : 1))
      const [view, setView] = useState({ scale: startScale, x: 0, y: 0 })
      const [smooth, setSmooth] = useState(true)
      const boxRef = useRef(null)
      const dragRef = useRef(null)

      const zoomAt = useCallback((factor, cx, cy) => {
        setView((old) => {
          const scale = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, old.scale * factor))
          const k = scale / old.scale
          return { scale, x: cx - (cx - old.x) * k, y: cy - (cy - old.y) * k }
        })
      }, [])

      useEffect(() => {
        const box = boxRef.current
        if (box === null) return undefined
        // React attaches wheel passively: preventDefault needs a native listener,
        // otherwise the panel scrolls while the map zooms.
        const onWheel = (event) => {
          if (event.ctrlKey && event.deltaY === 0) return
          event.preventDefault()
          const rect = box.getBoundingClientRect()
          setSmooth(false)
          zoomAt(Math.exp(-event.deltaY * 0.0018), event.clientX - rect.left, event.clientY - rect.top)
        }
        box.addEventListener('wheel', onWheel, { passive: false })
        return () => box.removeEventListener('wheel', onWheel)
      }, [zoomAt])

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: view.x, oy: view.y }
        setSmooth(false)
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (drag === null || drag.id !== event.pointerId) return
        setView({ scale: view.scale, x: drag.ox + event.clientX - drag.x, y: drag.oy + event.clientY - drag.y })
      }
      const onPointerUp = (event) => {
        if (dragRef.current?.id === event.pointerId) dragRef.current = null
      }
      const step = (factor) => {
        setSmooth(true)
        const box = boxRef.current
        zoomAt(factor, (box?.clientWidth ?? 0) / 2, (box?.clientHeight ?? 0) / 2)
      }
      const fit = () => {
        setSmooth(true)
        setView({ scale: startScale, x: 0, y: 0 })
      }
      const btn = (content, onClick, title) => h('button', {
        type: 'button',
        title,
        onClick: (event) => { event.stopPropagation(); onClick() },
        style: S.zoomBtn,
      }, content)

      return h('div', {
        ref: boxRef,
        style: S.mapView,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        onDoubleClick: fit,
      },
        h('div', {
          style: {
            ...S.mapZoom,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transition: smooth ? 'transform 140ms ease-out' : 'none',
          },
        }, children),
        h('div', { style: S.zoomBar },
          btn('＋', () => step(1.25), t('map.zoomIn')),
          btn('−', () => step(1 / 1.25), t('map.zoomOut')),
          btn('⟲', fit, t('map.zoomFit')),
          h('span', { style: S.zoomLevel }, `${Math.round(view.scale * 100)}%`),
        ),
      )
    }

    /** Pins of a map as rows: number and name for a chip, name for a board. */
    function mapPinList(map) {
      if (map === undefined) return []
      if (Array.isArray(map.pins) && map.pins.length > 0) {
        return map.pins.map((entry, index) => ({
          key: String(index + 1),
          name: typeof entry === 'string' ? entry : String(entry?.name ?? ''),
          func: Array.isArray(entry?.func) ? entry.func.map(String) : undefined,
        }))
      }
      const sides = map.sides !== null && typeof map.sides === 'object' ? map.sides : {}
      const out = []
      for (const side of ['left', 'right', 'top', 'bottom']) {
        for (const entry of Array.isArray(sides[side]) ? sides[side] : []) {
          const name = typeof entry === 'string' ? entry : entry?.pin
          if (typeof name === 'string' && !out.some((pin) => pin.key === name)) out.push({ key: name, name })
        }
      }
      return out
    }

    // The pin table under the map. It is the same list the drawing walks, so a
    // click on either side lands on the same pin, and the row scrolls into view
    // when the click came from the drawing.
    function PinTable({ rows, pins, selected, onPick, t }) {
      const bodyRef = useRef(null)
      useEffect(() => {
        if (bodyRef.current === null || selected === '') return
        const index = rows.findIndex((pin) => pin.key === selected)
        const row = index < 0 ? undefined : bodyRef.current.children[index]
        if (row !== undefined && row !== null) row.scrollIntoView({ block: 'nearest' })
      }, [selected, rows])
      if (rows.length === 0) return null
      return h('div', { style: S.pinTable },
        h('div', { style: S.pinTableHead },
          h('span', { style: S.pinNo }, t('map.pinNo')),
          h('span', { style: S.pinName }, t('map.pinName')),
          h('span', { style: S.pinWired }, t('map.pinWired')),
        ),
        h('div', { ref: bodyRef, style: S.pinTableBody },
          rows.map((pin) => {
            const wired = pins[pin.key]
            const sel = selected === pin.key
            const funcs = pin.func === undefined ? '' : pin.func.join(' ')
            return h('div', {
              key: pin.key,
              style: sel ? { ...S.pinTableRow, ...S.pinTableRowSel } : S.pinTableRow,
              onClick: () => onPick(pin.key),
              title: pin.func === undefined ? undefined : pin.func.join(', '),
            },
              h('span', { style: S.pinNo }, pin.key),
              h('span', { style: S.pinName }, pin.name),
              h('span', {
                style: {
                  ...S.pinWired,
                  color: wired === undefined ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-state-success-primary)',
                },
              }, wired === undefined ? funcs : wired.label),
            )
          }),
        ),
      )
    }

    /** One picture for the panel: the chip, else the sketch, else the header layout. */
    function mapCanvas(map, pins, selected, onPick) {
      if (Array.isArray(map?.pins) && map.pins.length > 0) return chipMap(map, pins, selected, onPick)
      if (Array.isArray(map?.draw) && map.draw.length > 0) return schematicMap(map, pins, selected, onPick)
      return boardMapSvg(map, pins, selected, onPick)
    }

    const TS = {
      page: {
        height: '100%',
        overflow: 'auto',
        boxSizing: 'border-box',
        padding: '20px 24px 28px',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
      },
      inner: { maxWidth: 780, display: 'flex', flexDirection: 'column', gap: 14 },
      header: { display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 18, fontWeight: 650, letterSpacing: '-0.01em', lineHeight: '24px' },
      lead: { margin: '4px 0 0', fontSize: 12.5, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', maxWidth: 520 },
      headerRight: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 },
      count: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      group: {
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-base)',
      },
      groupTitle: {
        padding: '6px 12px',
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 12px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        minHeight: 40,
        boxSizing: 'border-box',
      },
      dot: (color) => ({ width: 8, height: 8, borderRadius: 999, background: color, flex: '0 0 auto' }),
      grow: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
      nameLine: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      name: { fontSize: 12.5, fontWeight: 550 },
      meta: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' },
      state: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      pick: { display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', cursor: 'pointer' },
      footer: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
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
        height: 28,
        padding: '0 11px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      hint: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' },
      error: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', lineHeight: '17px' },
      log: {
        margin: 0,
        maxHeight: 220,
        overflow: 'auto',
        padding: '8px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        fontFamily: MONO,
        fontSize: 11,
        lineHeight: '16px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
    }

    const TOOL_GROUPS = ['core', 'common', 'esp32', 'avr', 'stm32', 'at32']

    function ToolSettingsPage() {
      const t = useMemo(() => (key) => translate(key), [])
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [picked, setPicked] = useState([])
      const [busy, setBusy] = useState(false)
      const [logOpen, setLogOpen] = useState(false)

      const load = useCallback(async () => {
        try {
          const next = await call('/board-lab/tools')
          setData(next)
          setError(null)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const install = data?.install
      const running = install?.running === true
      useEffect(() => {
        if (!running) return undefined
        const timer = window.setInterval(() => { void load() }, 1200)
        return () => window.clearInterval(timer)
      }, [running, load])

      const rows = data?.tools ?? []
      const missing = rows.filter((row) => row.ok !== true)
      const results = new Map((install?.results ?? []).map((entry) => [entry.id, entry]))
      const statusColor = (value) => value === 'done'
        ? 'var(--dsw-alias-state-success-primary)'
        : value === 'failed'
          ? 'var(--dsw-alias-state-error-primary)'
          : 'var(--dsw-alias-state-warn-primary)'

      const toggle = (id) => {
        setPicked((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id])
      }

      const startInstall = async () => {
        if (picked.length === 0 || busy || running) return
        setBusy(true)
        setError(null)
        try {
          await call('/board-lab/tools/install', { ids: picked })
          setPicked([])
          await load()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      const groupRows = (group) => rows.filter((row) => row.group === group)

      return h('div', { style: TS.page },
        h('div', { style: TS.inner },
          h('div', { style: TS.header },
            h('div', { style: { minWidth: 0 } },
              h('h2', { style: TS.title }, t('settings.title')),
              h('p', { style: TS.lead }, t('tools.lead')),
            ),
            h('div', { style: TS.headerRight },
              data === null
                ? null
                : h('span', { style: TS.count }, t('tools.count').replace('{done}', String(data.installed ?? 0)).replace('{total}', String(data.total ?? 0))),
              button(TS.ghost, busy || running, { type: 'button', onClick: () => { void load() } }, t('tools.refresh')),
            ),
          ),
          error === null ? null : h('div', { style: TS.error }, t('tools.error').replace('{message}', error)),
          ...TOOL_GROUPS
            .filter((group) => groupRows(group).length > 0)
            .map((group) => h('div', { key: group, style: TS.group },
              h('div', { style: TS.groupTitle }, t(`tools.section.${group}`)),
              groupRows(group).map((row) => {
                const result = results.get(row.id)
                const queued = picked.includes(row.id)
                const color = row.ok === true
                  ? 'var(--dsw-alias-state-success-primary)'
                  : result === undefined
                    ? 'var(--dsw-alias-state-error-primary)'
                    : statusColor(result.status)
                return h('div', { key: row.id, style: TS.row },
                  h('span', { style: TS.dot(color) }),
                  h('div', { style: TS.grow },
                    h('div', { style: TS.nameLine },
                      h('span', { style: TS.name }, row.name),
                      row.version === undefined ? null : h('span', { style: TS.meta }, row.version),
                      h('span', { style: TS.meta }, t(`tools.kind.${row.kind}`)),
                    ),
                    result === undefined
                      ? null
                      : h('span', { style: { ...TS.meta, color: statusColor(result.status) } },
                        t(`tools.status.${result.status}`) + (result.detail === undefined ? '' : ` — ${result.detail}`)),
                  ),
                  row.ok === true
                    ? h('span', { style: TS.state }, t('tools.installed'))
                    : h('label', { style: TS.pick },
                      h('input', { type: 'checkbox', checked: queued, disabled: running, onChange: () => toggle(row.id) }),
                      t('tools.pick')),
                )
              }),
            )),
          h('div', { style: TS.footer },
            button(TS.primary, picked.length === 0 || busy || running, {
              type: 'button',
              onClick: () => { void startInstall() },
            }, running ? t('tools.installing') : busy ? t('tools.installing') : t('tools.install')),
            h('span', { style: TS.hint },
              error !== null || data === null
                ? ''
                : missing.length === 0
                  ? t('tools.hintEmpty')
                  : picked.length === 0
                    ? t('tools.hintPick')
                    : t('tools.selected').replace('{n}', String(picked.length))),
            install?.log
              ? button(TS.ghost, false, { type: 'button', onClick: () => setLogOpen((value) => !value) }, logOpen ? t('tools.logHide') : t('tools.log'))
              : null,
          ),
          logOpen && install?.log ? h('pre', { style: TS.log }, install.log) : null,
        ),
      )
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
      const [cpBusy, setCpBusy] = useState(null)
      const [wiring, setWiring] = useState(null)
      const [mapBusy, setMapBusy] = useState(false)
      const [pinSel, setPinSel] = useState('')
      const [pinLabel, setPinLabel] = useState('')
      const [lastTest, setLastTest] = useState(null)
      const [restored, setRestored] = useState(null)
      const [chipKind, setChipKind] = useState('qfp')
      const [chipNames, setChipNames] = useState('')
      const [chipBusy, setChipBusy] = useState(false)
      const [copied, setCopied] = useState(false)
      const [newMap, setNewMap] = useState(false)
      const [newMapName, setNewMapName] = useState('')
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
          setProject((current) => current || data.current?.project || data.remembered?.[0]?.project || '')
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

      const chooseProject = useCallback(async (value) => {
        setProject(value)
        if (value === '') return
        try {
          const data = await call('/board-lab/project/select', { project: value })
          if (data.ok !== false && data.current !== undefined) {
            append('project', `${t('log.projectSelected')} ${data.current.path}`)
          }
          await refresh()
        } catch (cause) {
          append('project', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        }
      }, [append, refresh, t])

      const openProjectFolder = useCallback(async (target) => {
        try {
          const data = await call('/board-lab/project/open', { target })
          append('project', `${t('log.folderOpened')} ${data.path}`)
        } catch (cause) {
          append('project', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        }
      }, [append, t])

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

      const createCheckpoint = useCallback(async () => {
        setCpBusy('create')
        try {
          const data = await call('/board-lab/checkpoints/create', { project: project === '' ? undefined : project })
          append('checkpoint', `${t('checkpoint.created')} ${data.checkpoint?.id ?? ''}`.trim(), true)
          setRestored(null)
        } catch (cause) {
          append('checkpoint', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        } finally {
          setCpBusy(null)
          await refresh()
        }
      }, [project, append, refresh, t])

      const restoreCheckpoint = useCallback(async (checkpoint) => {
        setCpBusy(checkpoint.id)
        try {
          const data = await call('/board-lab/checkpoints/restore', { id: checkpoint.id })
          append('checkpoint', `${t('checkpoint.restored')} ${checkpoint.id}`, true)
          setRestored({ id: checkpoint.id, label: checkpoint.label, guard: data.checkpoint?.guard, at: new Date() })
        } catch (cause) {
          append('checkpoint', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        } finally {
          setCpBusy(null)
          await refresh()
        }
      }, [append, refresh, t])

      const deleteCheckpoint = useCallback(async (checkpoint) => {
        setCpBusy(checkpoint.id)
        try {
          await call('/board-lab/checkpoints/delete', { id: checkpoint.id })
          append('checkpoint', `${t('checkpoint.deleted')} ${checkpoint.id}`, undefined)
          setRestored((current) => (current?.id === checkpoint.id ? null : current))
        } catch (cause) {
          append('checkpoint', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        } finally {
          setCpBusy(null)
          await refresh()
        }
      }, [append, refresh, t])

      const loadWiring = useCallback(async () => {
        try {
          setWiring(await call('/board-lab/wiring'))
        } catch {
          // The map tab keeps its last known state rather than blanking out.
        }
      }, [])

      useEffect(() => { loadWiring() }, [loadWiring, project])

      const pickBoard = useCallback(async (id) => {
        setMapBusy(true)
        try {
          setWiring(await call('/board-lab/wiring/board', { board: id, project: project === '' ? undefined : project }))
          setPinSel('')
          setPinLabel('')
        } catch (cause) {
          append('wiring', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        } finally {
          setMapBusy(false)
        }
      }, [project, append])

      const pickPin = useCallback((pin) => {
        setPinSel(pin)
        setPinLabel(wiring?.pins?.[pin]?.label ?? '')
      }, [wiring])

      const savePin = useCallback(async (pin, label) => {
        setMapBusy(true)
        try {
          setWiring(await call('/board-lab/wiring/set', {
            board: wiring?.board,
            pin,
            label,
            project: project === '' ? undefined : project,
          }))
          append('wiring', `${pin} → ${label === '' ? t('map.cleared') : label}`, true)
        } catch (cause) {
          append('wiring', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        } finally {
          setMapBusy(false)
        }
      }, [wiring, project, append, t])

      const draftPins = useCallback(async () => {
        setMapBusy(true)
        try {
          const data = await call('/board-lab/wiring/draft', {
            board: wiring?.board,
            project: project === '' ? undefined : project,
          })
          setWiring(data)
          append('wiring', `${t('map.drafted')} ${data.applied ?? 0}`, true)
        } catch (cause) {
          append('wiring', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        } finally {
          setMapBusy(false)
        }
      }, [wiring, project, append, t])

      /** A board nobody drew yet: one click adds its own empty table. */
      const createMap = useCallback(async () => {
        const name = newMapName.trim()
        const id = mapSlug(name === '' ? (wiring?.board ?? 'board') : name)
        setMapBusy(true)
        try {
          const result = await call('/board-lab/maps/new', { id, name: name === '' ? id : name, board: wiring?.board })
          if (result.ok !== true) throw new Error(result.error)
          append('map', `${t('map.created')} ${result.map.id}`, true)
          setNewMap(false)
          setNewMapName('')
          await loadWiring()
        } catch (cause) {
          append('map', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        } finally {
          setMapBusy(false)
        }
      }, [newMapName, wiring, append, loadWiring, t])

      /** The panel builds a chip map itself: package kind plus the datasheet pin table. */
      const createChip = useCallback(async () => {
        if (wiring?.map === undefined) return
        setChipBusy(true)
        try {
          // The field takes a pasted datasheet table as well as a plain list of
          // names: the server finds the pin-number column and the functions, so
          // nobody has to explain the columns to the agent.
          const parsed = await call('/board-lab/maps/parse', { text: chipNames })
          if (parsed.ok === false) throw new Error(parsed.error)
          if (parsed.count < 4) {
            append('map', t('map.chipFew'), false)
            return
          }
          const result = await call('/board-lab/maps/save', {
            id: wiring.map.id,
            name: wiring.map.name,
            // A typed pin table is not a checked one: the badge stays honest
            // until somebody rings the pins out on the real board.
            verified: false,
            package: { kind: chipKind },
            pins: parsed.pins,
            note: `${chipKind.toUpperCase()}${parsed.count}`,
          })
          if (result.ok !== true) throw new Error(result.error)
          setWiring(result.wiring ?? wiring)
          setChipNames('')
          setPinSel('')
          append('map', `${t('map.chipCreated')} ${result.map.id}`, true)
          await loadWiring()
        } catch (cause) {
          append('map', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        } finally {
          setChipBusy(false)
        }
      }, [chipNames, chipKind, wiring, append, loadWiring, t])

      useEffect(() => { setChipNames('') }, [wiring?.board])

      // One line is one pin, whether it is a bare name or a whole datasheet row.
      const chipLines = chipNames.split('\n').map((line) => line.trim()).filter((line) => line !== '').length
      const stubMap = wiring?.map !== undefined
        && Object.keys(wiring.map.sides ?? {}).length === 0
        && !(Array.isArray(wiring.map.pins) && wiring.map.pins.length > 0)
      const mapPins = mapPinList(wiring?.map)
      const pinFuncs = mapPins.find((pin) => pin.key === pinSel)?.func ?? []
      const pinName = (key) => {
        const index = Number(key) - 1
        const names = wiring?.map?.pins
        return Array.isArray(names) && Number.isInteger(index) && names[index] !== undefined ? names[index] : ''
      }
      const chatPrompt = t('map.chatPrompt')
        .replace('{name}', wiring?.map?.name ?? '')
        .replace('{id}', wiring?.map?.id ?? '')

      const copyPrompt = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(chatPrompt)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          append('map', chatPrompt, undefined)
        }
      }, [chatPrompt, append])

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
      const current = status?.current
      // Checkpoints belong to the project they were taken from: another sketch's
      // states are noise, and restoring the wrong one is a trap.
      const checkpoints = (status?.checkpoints ?? [])
        .filter((item) => current === undefined || item.project === current.path)
      const chip = ports.find((item) => item.path === port)
      const factsReady = facts !== null && facts.chip !== undefined
      const deviceRows = [
        { label: t('device.chip'), value: facts?.chip, mono: false },
        { label: t('device.revision'), value: facts?.revision, mono: false },
        { label: t('device.flash'), value: facts?.flashSize, mono: false },
        { label: t('device.psram'), value: facts?.psram, mono: false },
        { label: t('device.mac'), value: facts?.mac, mono: true },
      ]
      const quick = status?.commands ?? ['PING']

      const saveCommands = useCallback(async (commands) => {
        const result = await call('/board-lab/commands/set', { commands })
        if (result.ok !== true) throw new Error(result.error)
        await refresh()
      }, [refresh])

      const addCommand = useCallback(async () => {
        const text = writeText.trim()
        if (text === '') return
        try {
          await saveCommands([...quick, text].slice(0, 12))
          setWriteText('')
          append('system', `${t('command.added')} ${text}`, true)
        } catch (cause) {
          append('system', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        }
      }, [writeText, quick, saveCommands, append, t])

      const dropCommand = useCallback(async (text) => {
        try {
          await saveCommands(quick.filter((item) => item !== text))
        } catch (cause) {
          append('system', `✖ ${cause instanceof Error ? cause.message : String(cause)}`, false)
        }
      }, [quick, saveCommands, append])

      const clock = (iso) => {
        const when = new Date(iso)
        return Number.isNaN(when.getTime()) ? '' : when.toLocaleTimeString().slice(0, 5)
      }
      const cpName = (item) => {
        if (typeof item.label === 'string' && item.label.trim() !== '') return item.label
        if (item.guard === true) return t('checkpoint.guard')
        return `${t('checkpoint.auto')} ${clock(item.createdAt ?? '')}`.trim()
      }
      const cpState = (item) => {
        const state = item.state
        if (state === undefined) return null
        if (state.other === true) return h('span', { style: S.cpMeta }, t('checkpoint.otherProject'))
        if (state.missing === true) return h('span', { style: S.cpBadge('warn') }, t('checkpoint.broken'))
        if (state.same === true) return h('span', { style: S.cpBadge('done') }, t('checkpoint.same'))
        const drift = []
        if (state.changed > 0) drift.push(`${state.changed} ${t('checkpoint.changed')}`)
        if (state.added > 0) drift.push(`+${state.added}`)
        if (state.removed > 0) drift.push(`−${state.removed}`)
        return h('span', { style: S.cpBadge('warn') }, `${t('checkpoint.drift')} ${drift.join(' · ')}`)
      }

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
            h('section', { style: S.control },
              h('div', { style: S.fieldRow },
                h('span', { style: S.fieldLabel }, t('field.project')),
                h('select', {
                  style: S.input,
                  value: project,
                  title: current?.dir ?? '',
                  onChange: (event) => { chooseProject(event.target.value) },
                },
                  h('option', { value: '' }, t('field.projectAuto')),
                  (status?.projects ?? []).map((item) => h('option', { key: item.path, value: item.path }, `${item.name} (${item.kind})`)),
                ),
              ),
              h('div', { style: S.fieldRow },
                h('span', { style: S.fieldLabel }, t('field.port')),
                h('select', {
                  style: S.input,
                  value: port,
                  onChange: (event) => setPort(event.target.value),
                },
                  h('option', { value: '' }, t('field.auto')),
                  ports.map((item) => h('option', { key: item.path, value: item.path }, `${item.path}${item.vendorId ? ` · ${item.vendorId}:${item.productId ?? '?'}` : ''}`)),
                ),
                button(S.cpBtn, disabled, { onClick: detect, title: t('action.detect') },
                  busy === 'detect' ? '…' : '⟳'),
              ),
              h('div', { style: S.fieldRow },
                h('span', { style: S.fieldLabel }, t('field.baud')),
                h('input', {
                  style: { ...S.input, width: 96, justifySelf: 'start' },
                  value: baud,
                  inputMode: 'numeric',
                  onChange: (event) => setBaud(event.target.value),
                }),
                h('span'),
              ),
              h('div', { style: S.controlActions },
                button(S.primary, disabled, {
                  onClick: () => run('flash', '/board-lab/flash', {
                    project: project === '' ? undefined : project,
                    port,
                    baud: Number(baud) || undefined,
                  }),
                }, busy === 'flash' ? t('action.flashing') : t('action.flash')),
                button(S.ghost, disabled || project === '', { onClick: () => run('build', '/board-lab/build', { project }) },
                  busy === 'build' ? t('action.building') : t('action.build')),
              ),
            ),

            h('section', { style: { ...S.card, ...S.logCard, paddingBottom: 12 } },
              h('div', { style: S.cardHead },
                h('span', { style: S.kicker }, t('log.title')),
                h('span', { style: S.dot(monitoring ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)') }),
                h('span', { style: S.hint }, monitoring ? t('log.live') : t('log.paused')),
                button(S.cpBtn, disabled || port === '', {
                  onClick: monitoring ? stopMonitor : startMonitor,
                  title: monitoring ? t('action.monitorStop') : t('action.monitorStart'),
                }, monitoring ? '■' : '▶'),
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
              h('div', { style: S.stepsInline },
                quick.map((text) => h('button', {
                  key: text,
                  style: { ...S.chip, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer' },
                  disabled,
                  title: t('command.remove'),
                  onClick: () => sendText(text),
                  onContextMenu: (event) => {
                    event.preventDefault()
                    dropCommand(text)
                  },
                }, text)),
                h('button', {
                  style: { ...S.chip, opacity: disabled || writeText.trim() === '' ? 0.45 : 1, cursor: disabled || writeText.trim() === '' ? 'default' : 'pointer' },
                  disabled: disabled || writeText.trim() === '',
                  title: t('command.add'),
                  onClick: addCommand,
                }, '＋'),
                h('div', { style: S.spacer }),
                button(S.quiet, disabled || port === '', { onClick: resetBoard }, t('action.reset')),
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

            h('section', { style: { ...S.card, ...S.testsCard, gap: 8 } },
              h('div', { style: S.cardHead },
                h('span', { style: S.kicker }, t('section.test')),
                h('div', { style: S.spacer }),
                button(S.ghost, disabled || project === '', { onClick: runTests },
                  busy === 'test' ? t('action.testing') : t('action.test')),
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
            h('section', { style: { ...S.card, ...S.railCard } },
              h('div', { style: S.cardHead },
                h('span', { style: S.kicker }, t('section.checkpoints')),
                h('div', { style: S.spacer }),
                button(S.quiet, disabled || current === undefined, { onClick: createCheckpoint },
                  cpBusy === 'create' ? t('checkpoint.creating') : t('checkpoint.create')),
              ),
              restored === null
                ? null
                : h('div', { style: S.stateNote },
                    h('span', { style: { color: 'var(--dsw-alias-state-success-primary)', fontWeight: 700 } }, '✓'),
                    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
                      h('span', { style: { fontSize: 12 } }, `${t('checkpoint.restoredFrom')} ${cpName(restored)}`),
                      h('span', { style: { ...S.cpMeta } }, t('checkpoint.restoredHint')),
                    ),
                  ),
              checkpoints.length === 0
                ? h('div', { style: S.hint }, t('checkpoint.none'))
                : h('div', { style: S.cpList },
                    checkpoints.map((item) => h('div', { key: item.id, style: S.cpRow },
                      h('div', { style: { minWidth: 0 } },
                        h('div', { style: S.cpTitle }, cpName(item)),
                        h('div', { style: { ...S.cpMeta, ...S.nowrap } },
                          `${clock(item.createdAt)} · ${item.files} ${t('checkpoint.files')} · ${Math.max(1, Math.round((item.bytes ?? 0) / 1024))} KB`),
                        cpState(item),
                      ),
                      h('div', { style: { display: 'flex', gap: 4 } },
                        button(S.cpBtn, cpBusy !== null, {
                          onClick: () => restoreCheckpoint(item),
                          title: t('checkpoint.restore'),
                        }, cpBusy === item.id ? '…' : '↩'),
                        button(S.cpBtn, cpBusy !== null, {
                          onClick: () => deleteCheckpoint(item),
                          title: t('checkpoint.delete'),
                        }, '✕'),
                      ),
                    )),
                  ),
            ),

            h('section', { style: S.folderRow },
              button(S.ghost, disabled || current === undefined, { onClick: () => openProjectFolder('root') }, t('action.openFolder')),
              button(S.ghost, disabled || current === undefined, { onClick: () => openProjectFolder('lib') }, t('action.openLib')),
            ),
            h('section', { style: { ...S.card, ...S.mapCard } },
              h('div', { style: { ...S.cardHead, flexWrap: 'wrap', rowGap: 6 } },
                h('span', { style: S.kicker }, t('map.title')),
                h('div', { style: S.spacer }),
                h('select', {
                  style: { ...S.input, height: 24, padding: '0 6px', fontSize: 11.5, maxWidth: 210 },
                  value: newMap === true ? '__new' : wiring?.board ?? '',
                  disabled: mapBusy,
                  onChange: (event) => {
                    if (event.target.value === '__new') {
                      setNewMap(true)
                      return
                    }
                    setNewMap(false)
                    pickBoard(event.target.value)
                  },
                },
                  (wiring?.maps ?? []).map((item) => h('option', { key: item.id, value: item.id }, item.name)),
                  h('option', { key: '__new', value: '__new' }, `＋ ${t('map.new')}`),
                ),
                newMap === true
                  ? h('span', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                      h('input', {
                        style: { ...S.input, height: 24, width: 132, fontSize: 11.5 },
                        value: newMapName,
                        placeholder: t('map.newName'),
                        autoFocus: true,
                        onChange: (event) => setNewMapName(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter') createMap()
                          if (event.key === 'Escape') { setNewMap(false); setNewMapName('') }
                        },
                      }),
                      button(S.ghost, mapBusy, { onClick: createMap }, '✓'))
                  : null,
                button(S.ghost, disabled || mapBusy || wiring?.map === undefined, { onClick: draftPins }, t('map.draft')),
              ),
              stubMap
                ? h('div', { style: S.mapPrompt },
                    h('div', { style: { fontSize: 12, fontWeight: 600 } }, t('map.chipLead')),
                    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                      h('select', {
                        style: { ...S.input, height: 24, padding: '0 6px', fontSize: 11.5 },
                        value: chipKind,
                        disabled: chipBusy,
                        onChange: (event) => setChipKind(event.target.value),
                      },
                        ['qfp', 'qfn', 'dip', 'soic', 'tssop'].map((kind) => h('option', { key: kind, value: kind }, kind.toUpperCase())),
                      ),
                      h('span', { style: S.hint }, `${chipLines} ${t('map.chipPins')}`),
                    ),
                    h('textarea', {
                      style: { ...S.input, width: '100%', boxSizing: 'border-box', height: 92, padding: '6px 7px', fontFamily: MONO, fontSize: 11, resize: 'vertical' },
                      value: chipNames,
                      placeholder: t('map.chipNames'),
                      disabled: chipBusy,
                      onChange: (event) => setChipNames(event.target.value),
                    }),
                    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                      button(S.ghost, chipBusy || chipLines < 4, { onClick: createChip },
                        chipBusy ? t('map.chipBusy') : t('map.chipCreate')),
                      h('span', { style: S.hint }, t('map.chipCount')),
                    ),
                    h('details', null,
                      h('summary', { style: { ...S.hint, cursor: 'pointer' } }, t('map.chipAgent')),
                      h('code', { style: S.mapPromptText }, chatPrompt),
                      button(S.ghost, false, { onClick: copyPrompt }, copied === true ? t('map.copied') : t('map.copyPrompt')),
                    ),
                  )
                : null,
              wiring?.map === undefined
                ? h('div', { style: S.mapEmpty },
                    h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('map.none')),
                    h('div', { style: S.hint }, t('map.noneHint')))
                : stubMap
                  ? null
                  : h('div', { style: S.mapWrap },
                      h('div', { style: S.mapBody },
                        h(MapView, {
                          t,
                          // A board is wide and wants to stay near 100 %; a chip
                          // fits whole at 100 %, so both start where their labels
                          // are still legible.
                          initial: Array.isArray(wiring.map?.pins) && wiring.map.pins.length > 0 ? 1 : 2,
                        }, mapCanvas(wiring.map, wiring.pins ?? {}, pinSel, pickPin)),
                        wiring?.map?.verified === false
                          ? h('div', { style: S.mapNote }, t('map.unverified'))
                          : null,
                      ),
                      h(PinTable, { rows: mapPins, pins: wiring.pins ?? {}, selected: pinSel, onPick: pickPin, t }),
                    ),
              pinSel === ''
                ? h('div', { style: { ...S.hint, flex: '0 0 auto' } }, t('map.pick'))
                : h('div', { style: { ...S.pinRow, flex: '0 0 auto' } },
                    h('span', { style: { ...S.monoValue, minWidth: 54 } },
                      pinName(pinSel) === '' ? pinSel : `${pinSel} ${pinName(pinSel)}`),
                    h('input', {
                      style: { ...S.input, height: 24, fontSize: 11, flex: '1 1 auto', minWidth: 0 },
                      value: pinLabel,
                      placeholder: t('map.placeholder'),
                      onChange: (event) => setPinLabel(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') savePin(pinSel, pinLabel)
                      },
                    }),
                    button(S.cpBtn, mapBusy, { onClick: () => savePin(pinSel, pinLabel), title: t('map.save') }, '✓'),
                    wiring?.pins?.[pinSel] !== undefined
                      ? button(S.cpBtn, mapBusy, { onClick: () => savePin(pinSel, ''), title: t('map.clear') }, '✕')
                      : null,
                  ),
              pinFuncs.length === 0
                ? null
                : h('div', { style: { ...S.hint, flex: '0 0 auto', fontFamily: MONO, fontSize: 10.5 } },
                    `${t('map.pinFuncs')}: ${pinFuncs.join(' · ')}`),
            ),

            h('section', { style: { ...S.card, ...S.deviceCard } },
              h('div', { style: S.cardHead },
                h('span', { style: S.kicker }, t('device.title')),
                h('div', { style: S.spacer }),
                factsReady
                  ? h('span', { style: { ...S.hint, fontSize: 11 } }, t('device.fromChip'))
                  : null,
              ),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 } },
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
                h('div', { style: S.sectionGap }),
                h('div', { style: S.hint }, monitoring ? t('log.liveHint') : t('log.idleHint')),
                h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  button(S.ghost, disabled || port === '', { onClick: inspect },
                    busy === 'info' ? t('action.inspecting') : t('action.info')),
                ),
              ),
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
        'settings.title': 'Board tools',
        'tools.lead': 'What is installed on this machine and what the agent still needs to build and flash boards.',
        'tools.count': '{done} of {total} installed',
        'tools.refresh': 'Refresh',
        'tools.install': 'Download selected',
        'tools.installing': 'Installing…',
        'tools.selected': '{n} selected',
        'tools.pick': 'add',
        'tools.installed': 'installed',
        'tools.hintEmpty': 'Everything the agent needs is installed.',
        'tools.hintPick': 'Tick the missing tools, then download them in one go.',
        'tools.log': 'Details',
        'tools.logHide': 'Hide details',
        'tools.error': 'Could not read the tool list: {message}',
        'tools.kind.pip': 'pip package',
        'tools.kind.platform': 'PlatformIO platform',
        'tools.kind.tool': 'PlatformIO tool',
        'tools.kind.toolchain': 'toolchain',
        'tools.status.queued': 'queued',
        'tools.status.running': 'installing…',
        'tools.status.done': 'done',
        'tools.status.failed': 'failed',
        'tools.section.core': 'Core',
        'tools.section.common': 'Common',
        'tools.section.esp32': 'ESP32',
        'tools.section.avr': 'Arduino AVR',
        'tools.section.stm32': 'STM32',
        'tools.section.at32': 'AT32 / ARM',
        'panel.subtitle': 'Build, flash and watch the device without unplugging it.',
        'section.connection': 'Board',
        'section.project': 'Project',
        'section.quick': 'Commands',
        'command.add': 'Add the text in the input as a command of this project',
        'command.remove': 'Click sends, right-click removes',
        'command.added': 'Command added:',
        'section.test': 'Scenario run',
        'section.checkpoints': 'Checkpoints',
        'checkpoint.create': '+ Save',
        'checkpoint.creating': '+ …',
        'checkpoint.none': 'No checkpoints yet — save one before a risky edit.',
        'checkpoint.created': 'checkpoint saved',
        'checkpoint.restored': 'restored to',
        'checkpoint.kept': 'previous state kept as',
        'checkpoint.deleted': 'checkpoint removed',
        'checkpoint.files': 'files',
        'checkpoint.restore': 'Restore this checkpoint',
        'checkpoint.delete': 'Remove this checkpoint',
        'checkpoint.auto': 'point',
        'checkpoint.guard': 'state before the restore',
        'checkpoint.restoredFrom': 'Restored to',
        'checkpoint.restoredHint': 'Not what you wanted? Restore the "state before the restore" point.',
        'checkpoint.same': 'matches the code',
        'checkpoint.drift': 'code moved on:',
        'checkpoint.changed': 'changed',
        'checkpoint.otherProject': 'another project',
        'checkpoint.broken': 'snapshot damaged',
        'device.title': 'Device',
        'map.title': 'Board map',
        'map.new': 'New board map',
        'map.newName': 'name or id',
        'map.created': 'Board map created:',
        'map.chipLead': 'A chip: pick the package, paste the datasheet pin table — pin 1 first.',
        'map.chipNames': 'Paste the datasheet table, or VBAT, PC13, PC14 … one pin per line, pin 1 first',
        'map.chipPins': 'pins',
        'map.chipCount': 'the count must fit the package: multiple of 4 for QFP/QFN, of 2 for DIP/SOIC/TSSOP',
        'map.chipCreate': 'Build the chip',
        'map.chipBusy': 'Building…',
        'map.chipFew': 'At least 4 pin names, one per line, pin 1 first.',
        'map.chipCreated': 'Chip map built:',
        'map.chipAgent': 'or let the agent fill it',
        'map.pinNo': '#',
        'map.pinName': 'pin',
        'map.pinWired': 'wired / AF',
        'map.pinFuncs': 'AF',
        'map.zoomIn': 'Zoom in',
        'map.zoomOut': 'Zoom out',
        'map.zoomFit': 'Fit',
        'map.zoomIn': 'Приблизить',
        'map.zoomOut': 'Отдалить',
        'map.zoomFit': 'Вписать',
        'map.copyPrompt': 'Copy the message',
        'map.copied': 'Copied',
        'map.chatPrompt': 'Build the chip map «{name}» (id {id}): take the pin table from the datasheet, list the pin names in physical order (pin 1 first), then save it with board_maps action save, package.kind and pins. No coordinates.',
        'map.none': 'No pin table matched this board.',
        'map.noneHint': 'Pick a map above, or create one with its name.',
        'map.pick': 'Click a pin to say what is wired to it.',
        'map.placeholder': 'what is wired here',
        'map.save': 'Save this pin',
        'map.clear': 'Clear this pin',
        'map.draft': 'Draft from source',
        'map.drafted': 'connections drafted from the source:',
        'map.cleared': 'pin cleared',
        'map.unverified': 'Layout not checked against the physical board yet — fix it in maps/*.json.',

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
        'project.current': 'current',
        'project.none': 'No project selected yet. Pick one above or press “Detect board”.',
        'project.folder': 'Folder',
        'project.path': 'Path',
        'project.board': 'Board',
        'project.hint': 'Drop libraries into lib/ — PlatformIO picks them up on the next build.',
        'action.openFolder': 'Open folder',
        'action.openLib': 'Libraries',
        'log.projectSelected': 'current project:',
        'log.folderOpened': 'opened:',
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
        'settings.title': 'Инструменты для плат',
        'tools.lead': 'Что установлено на этой машине и чего не хватает агенту, чтобы собирать и прошивать платы.',
        'tools.count': 'Установлено {done} из {total}',
        'tools.refresh': 'Обновить',
        'tools.install': 'Скачать выбранные',
        'tools.installing': 'Скачиваю…',
        'tools.selected': 'Выбрано: {n}',
        'tools.pick': 'добавить',
        'tools.installed': 'установлено',
        'tools.hintEmpty': 'Всё необходимое агенту уже установлено.',
        'tools.hintPick': 'Отметьте недостающие инструменты и скачайте их разом.',
        'tools.log': 'Подробности',
        'tools.logHide': 'Скрыть подробности',
        'tools.error': 'Не удалось прочитать список инструментов: {message}',
        'tools.kind.pip': 'pip-пакет',
        'tools.kind.platform': 'платформа PlatformIO',
        'tools.kind.tool': 'инструмент PlatformIO',
        'tools.kind.toolchain': 'тулчейн',
        'tools.status.queued': 'в очереди',
        'tools.status.running': 'ставится…',
        'tools.status.done': 'готово',
        'tools.status.failed': 'ошибка',
        'tools.section.core': 'Основа',
        'tools.section.common': 'Общее',
        'tools.section.esp32': 'ESP32',
        'tools.section.avr': 'Arduino AVR',
        'tools.section.stm32': 'STM32',
        'tools.section.at32': 'AT32 / ARM',
        'panel.subtitle': 'Сборка, прошивка и живой UART — не отключая плату.',
        'section.connection': 'Плата',
        'section.project': 'Проект',
        'section.quick': 'Команды',
        'command.add': 'Добавить текст из поля ввода в команды этого проекта',
        'command.remove': 'Клик — отправить, правый клик — убрать',
        'command.added': 'Команда добавлена:',
        'section.test': 'Прогон сценария',
        'section.checkpoints': 'Контрольные точки',
        'checkpoint.create': '+ Точка',
        'checkpoint.creating': '+ …',
        'checkpoint.none': 'Точек пока нет — поставь перед рискованной правкой.',
        'checkpoint.created': 'точка создана',
        'checkpoint.restored': 'откатился к',
        'checkpoint.kept': 'прошлое состояние сохранено как',
        'checkpoint.deleted': 'точка удалена',
        'checkpoint.files': 'файлов',
        'checkpoint.restore': 'Откатить к этой точке',
        'checkpoint.delete': 'Удалить точку',
        'checkpoint.auto': 'точка',
        'checkpoint.guard': 'состояние до отката',
        'checkpoint.restoredFrom': 'Откатились к',
        'checkpoint.restoredHint': 'Не то? Верни точку «состояние до отката».',
        'checkpoint.same': 'совпадает с кодом',
        'checkpoint.drift': 'код изменился:',
        'checkpoint.changed': 'файлов',
        'checkpoint.otherProject': 'другой проект',
        'checkpoint.broken': 'снимок повреждён',
        'device.title': 'Устройство',
        'map.title': 'Макет',
        'map.new': 'Новый макет',
        'map.newName': 'имя или id',
        'map.created': 'Макет создан:',
        'map.chipLead': 'Чип: выбери корпус и вставь таблицу ножек из даташита — первая строка это ножка 1.',
        'map.chipNames': 'Вставь таблицу из даташита, или VBAT, PC13, PC14 … одна ножка на строку, ножка 1 первая',
        'map.chipPins': 'ножек',
        'map.chipCount': 'число должно подходить корпусу: кратно 4 для QFP/QFN, кратно 2 для DIP/SOIC/TSSOP',
        'map.chipCreate': 'Собрать чип',
        'map.chipBusy': 'Собираю…',
        'map.chipFew': 'Нужно минимум 4 имени ножек, по одному на строку, ножка 1 первая.',
        'map.chipCreated': 'Макет чипа собран:',
        'map.chipAgent': 'или пусть заполнит агент',
        'map.pinNo': '#',
        'map.pinName': 'ножка',
        'map.pinWired': 'подключено / AF',
        'map.pinFuncs': 'AF',
        'map.copyPrompt': 'Скопировать сообщение',
        'map.copied': 'Скопировано',
        'map.chatPrompt': 'Сделай макет чипа «{name}» (id {id}): возьми таблицу ножек из даташита, выпиши имена в физическом порядке (ножка 1 первая) и сохрани через board_maps action save с package.kind и pins. Координаты не нужны.',
        'map.none': 'Под эту плату нет таблицы пинов.',
        'map.noneHint': 'Выбери макет выше или создай новый по имени.',
        'map.pick': 'Щёлкни по ножке, чтобы написать, что к ней подключено.',
        'map.placeholder': 'что подключено',
        'map.save': 'Сохранить ножку',
        'map.clear': 'Очистить ножку',
        'map.draft': 'Черновик из кода',
        'map.drafted': 'подключений из кода:',
        'map.cleared': 'ножка очищена',
        'map.unverified': 'Раскладка ещё не сверена с платой — поправь maps/*.json.',

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
        'project.current': 'текущий',
        'project.none': 'Проект ещё не выбран. Выберите выше или нажмите «Определить плату».',
        'project.folder': 'Папка',
        'project.path': 'Путь',
        'project.board': 'Плата',
        'project.hint': 'Кидайте библиотеки в lib/ — PlatformIO подхватит их при следующей сборке.',
        'action.openFolder': 'Открыть папку',
        'action.openLib': 'Библиотеки',
        'log.projectSelected': 'текущий проект:',
        'log.folderOpened': 'открыто:',
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

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'board-lab',
          order: 60,
          label: () => translate('settings.title'),
          locale: NS,
        }, ToolSettingsPage))

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
