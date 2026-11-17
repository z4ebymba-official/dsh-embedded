/**
 * Tool allowlist for the «Плата-дев» preset.
 *
 * The preset only mounts its own tools (filesystem, bash, ask-user), but the
 * profile's host plugins register global tools into every agent: memory,
 * skills, web, schedules, workflows, subagents, the ACP/compaction stack and
 * the whole board-lab catalog. Those are what make a small edit take ten
 * minutes, so they are cut here.
 *
 * `tools.restrict({ allow })` hides every global tool that is not named, which
 * is the safe direction: a tool added by a future plugin stays hidden instead
 * of silently leaking in. The catch is that `restrict()` rejects any name the
 * registry cannot see, so the list is intersected with the probe below. If the
 * probe fails, restriction is skipped rather than bricking the preset — the
 * agent then has too many tools, not zero.
 */
export const name = 'board-lab-dev-restrict'

export const inject = ['tools']

const PROBE = '__board_lab_dev_probe__'

/**
 * Global tools the preset keeps. Board tools are read-only or harmless:
 * build/compile, port enumeration, monitor read, a line to the device, waiting
 * for a pattern, panic decoding, plus `board_cycle` — build, flash and the
 * first UART chunk in one call, so a change can be proven on the device without
 * a round trip through the panel — `board_checkpoint`, so a risky edit can be
 * rolled back in one call, and `board_maps`, so the agent can look up which pin
 * a signal is on before it touches the code. `board_flash` and `board_test`
 * stay out: the human flashes from the panel, and the regression runner is
 * main-session work.
 */
const ALLOW = [
  'board_build',
  'board_checkpoint',
  'board_cycle',
  'board_decode',
  'board_detect',
  'board_doctor',
  'board_info',
  'board_maps',
  'board_monitor',
  'board_ports',
  'board_project',
  'board_watch',
  'board_write',
]

/**
 * Ask the registry which names it can restrict. The only supported way to
 * learn that set is the rejection message of a bogus probe.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Set<string> | undefined} restrictable names, or undefined when unknown
 */
function restrictableNames(ctx) {
  try {
    ctx.tools.restrict({ deny: [PROBE] })
  } catch (error) {
    const match = /known global tools:\s*(.*)$/s.exec(String(error?.message ?? ''))
    if (!match) return undefined
    const list = match[1].trim()
    if (list === '' || list === '(none)') return new Set()
    return new Set(list.split(',').map((entry) => entry.trim()).filter(Boolean))
  }
  return undefined
}

export function apply(ctx) {
  ctx.effect(() => {
    const known = restrictableNames(ctx)
    if (known === undefined) return
    const allow = ALLOW.filter((name) => known.has(name))
    // Nothing to allow means the board plugin is not mounted; an empty allow
    // list would hide every global tool, so leave the roster alone instead.
    if (allow.length === 0) return
    try {
      return ctx.tools.restrict({ allow })
    } catch {
      return undefined
    }
  })
}
