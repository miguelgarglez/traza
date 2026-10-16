import type { Network, Station } from './metro.ts'
import type { Session, Step, Weave } from './model.ts'

// links.ts — cross-agent threading. When a reviewer session (codex, cursor)
// belongs to the same burst of work as a bigger session, the step that
// launched it earns a tether: a dashed thread drawn across the cloth to the
// child's first knot. Text evidence wins; pure timing earns an "≈" mark.

export interface Tether {
  id: string
  fromStationId: string
  toStationId: string
  from: { x: number; y: number }
  to: { x: number; y: number }
  label: string
  childAgent: string
  inferred: boolean
}

const HINT = /(codex|cursor|claude|review(?:er|ing)?|subagent|sidekick|second opinion|delegate|spawn|ask .* to|hand ?off|audit|double.?check|agent)/i
const RUNNING_GRACE = 120_000 // a child starting while the parent is still warm
const AFTER_GRACE = 90 * 60_000 // a reviewer spun up in the same burst of work still counts
const LOOKBACK = 10 // parent steps searched for evidence

function haystack(s: Step): string {
  return [s.title, s.body, s.thinking, ...(s.calls ?? []).flatMap((c) => [c.name, c.args ?? ''])]
    .filter(Boolean)
    .join('\n')
}

// distinctive words from the child's title — evidence that the parent knew
// the job it was handing off ("codex · palette" matches "the palette pass")
function titleWords(s: Session): RegExp | null {
  const words = s.title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !['with', 'from', 'that', 'this', 'the', 'agent', 'session', 'chat'].includes(w))
  if (!words.length) return null
  return new RegExp(`\\b(${words.slice(0, 6).join('|')})\\b`, 'i')
}

export function buildTethers(weave: Weave, net: Network): Tether[] {
  const stationOf = new Map<string, Station>()
  for (const c of net.corridors)
    for (const l of c.lines)
      for (const s of l.stations) stationOf.set(`${c.session.id}/${s.step.id}`, s)

  const out: Tether[] = []
  const sessions = weave.sessions.filter((s) => s.start != null)
  for (const child of sessions) {
    // a session can't parent itself; a parent either contains the child's
    // birth or finished recently enough to have handed off
    const parents = sessions.filter((p) => {
      if (p.id === child.id) return false
      const pEnd = p.end ?? p.start ?? 0
      if ((p.start ?? 0) <= child.start! && child.start! <= pEnd + RUNNING_GRACE) return true
      const gap = child.start! - pEnd
      return gap > 0 && gap <= AFTER_GRACE
    })
    if (!parents.length) continue
    // prefer the parent that brackets the child; ties → the nearest end
    const parent = parents.reduce((a, b) => {
      const aEnd = a.end ?? a.start ?? 0
      const bEnd = b.end ?? b.start ?? 0
      return child.start! - aEnd <= child.start! - bEnd ? a : b
    })
    const spine = parent.threads.find((t) => t.kind === 'spine') ?? parent.threads[0]
    if (!spine?.steps.length) continue

    // anchor search: the few parent steps nearest the child's birth
    const before = spine.steps.filter((s) => s.ts != null && s.ts <= child.start! + RUNNING_GRACE)
    const nearest = before[before.length - 1] ?? spine.steps[0]!
    const window = before.slice(-LOOKBACK)
    const named = new RegExp(child.agent, 'i')
    const titles = titleWords(child)
    const evStep =
      window.find((s) => named.test(haystack(s))) ??
      (titles ? window.find((s) => titles.test(haystack(s))) : undefined) ??
      window.find((s) => HINT.test(haystack(s)))
    const anchor = evStep ?? nearest

    const from = stationOf.get(`${parent.id}/${anchor.id}`)
    const childSpine = child.threads.find((t) => t.kind === 'spine') ?? child.threads[0]
    const to = childSpine?.steps[0] ? stationOf.get(`${child.id}/${childSpine.steps[0].id}`) : undefined
    if (!from || !to) continue
    out.push({
      id: `tether-${child.id}`,
      fromStationId: from.id,
      toStationId: to.id,
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y },
      label: `${child.agent} picked it up ${evStep ? 'here' : '≈ here'}`,
      childAgent: child.agent,
      inferred: !evStep,
    })
  }
  return out
}
