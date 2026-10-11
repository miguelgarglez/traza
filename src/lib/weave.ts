import type { Session, Step, Tape, Thread, TangleMark, Weave } from './model.ts'
import type { DevinMark } from './parse/devin.ts'

// weave.ts — turn a Session's threads into one flattened, chrono-ordered tape.
// Every step is a row; lanes are assigned greedily so sibling branches whose
// time ranges don't overlap share a lane (keeps the braid tight).

interface MarkBag {
  marks?: DevinMark[]
}

function stepKey(s: Step, prev: number): number {
  return s.ts != null ? s.ts : prev + 0.5
}

export function buildTape(session: Session): Tape {
  // 1. Collect every item: step rows and tangle marks, each with a sort key.
  interface Item {
    key: number
    seq: number
    kind: 'step' | 'mark'
    threadId: string
    step?: Step
    mark?: DevinMark
  }
  const items: Item[] = []
  let seq = 0

  const threadFirstKey = new Map<string, number>()

  for (const thread of session.threads) {
    let prev = thread.parent
      ? (threadFirstKey.get(thread.parent) ?? (session.start ?? 0))
      : (session.start ?? 0)
    for (const st of thread.steps) {
      prev = stepKey(st, prev)
      items.push({ key: prev, seq: seq++, kind: 'step', threadId: thread.id, step: st })
    }
    const marks = (thread as MarkBag).marks ?? []
    for (const m of marks) {
      // Dead stubs — offshoot steps with nothing in them — are dropped, not marked.
      const meaningful = m.steps.some(
        (s) => (s.body ?? '').trim() || (s.thinking ?? '').trim() || (s.calls ?? []).length || s.actor === 'user',
      )
      if (!meaningful) continue
      const mts = m.steps.map((s) => s.ts).find((t) => t != null)
      items.push({ key: mts ?? prev + 0.25, seq: seq++, kind: 'mark', threadId: thread.id, mark: m })
    }
    const first = items.filter((i) => i.threadId === thread.id).sort((a, b) => a.key - b.key)[0]
    if (first) threadFirstKey.set(thread.id, first.key)
  }

  items.sort((a, b) => a.key - b.key || a.seq - b.seq)

  // Coalesce runs of consecutive marks into one aggregate mark — real devin
  // exports spawn hundreds of adjacent 1-step stubs, and a wall of identical
  // tangle chips is worse than a single honest "23 offshoot steps" knot.
  {
    const merged: Item[] = []
    for (const it of items) {
      const prevIt = merged[merged.length - 1]
      if (it.kind === 'mark' && prevIt?.kind === 'mark' && prevIt.threadId === it.threadId) {
        const m = prevIt.mark!
        prevIt.mark = {
          anchorNode: null,
          label: 'offshoots',
          count: m.count + it.mark!.count,
          steps: [...m.steps, ...it.mark!.steps],
        }
        continue
      }
      merged.push(it)
    }
    items.length = 0
    items.push(...merged)
  }

  // 2. Lane assignment (DFS from spine; sibling branches share lanes when
  //    their global-index ranges don't overlap).
  const threadLane = new Map<string, number>()
  const spine = session.threads.find((t) => t.kind === 'spine') ?? session.threads[0]
  threadLane.set(spine?.id ?? '', 0)

  // First pass gi per item is needed before lanes: compute global order once.
  const giOfItem = new Map<Item, number>()
  items.forEach((it, gi) => giOfItem.set(it, gi))

  const rangeOf = new Map<string, { first: number; last: number }>()
  for (const t of session.threads) {
    const gis = items.filter((i) => i.threadId === t.id).map((i) => giOfItem.get(i)!)
    rangeOf.set(t.id, gis.length ? { first: Math.min(...gis), last: Math.max(...gis) } : { first: 0, last: 0 })
  }

  // Assign lanes parent-first: branches ordered by first appearance.
  const childrenOf = new Map<string, string[]>()
  for (const t of session.threads) {
    if (t.kind === 'spine') continue
    const p = t.parent ?? spine?.id ?? ''
    const arr = childrenOf.get(p) ?? []
    arr.push(t.id)
    childrenOf.set(p, arr)
  }
  const laneRanges = new Map<number, { first: number; last: number }[]>()
  const sortedBranches = [...session.threads]
    .filter((t) => t.kind !== 'spine')
    .sort((a, b) => (rangeOf.get(a.id)?.first ?? 0) - (rangeOf.get(b.id)?.first ?? 0))
  // Parent lanes must exist before children — iterate until stable.
  let progress = true
  while (progress) {
    progress = false
    for (const t of sortedBranches) {
      if (threadLane.has(t.id)) continue
      const parentLane = threadLane.get(t.parent ?? spine?.id ?? '') ?? 0
      if (t.parent && !threadLane.has(t.parent) && session.threads.some((x) => x.id === t.parent)) continue
      const r = rangeOf.get(t.id) ?? { first: 0, last: 0 }
      let lane = parentLane + 1
      for (;;) {
        const occupied = laneRanges.get(lane) ?? []
        const clash = occupied.some((o) => !(r.last < o.first || r.first > o.last))
        if (!clash || lane > 7) break
        lane++
      }
      const occ = laneRanges.get(lane) ?? []
      occ.push(r)
      laneRanges.set(lane, occ)
      threadLane.set(t.id, lane)
      progress = true
    }
  }

  // 3. Emit rows + marks with lanes; then fork/merge anchors.
  const rows: Tape['rows'] = []
  const tangles: TangleMark[] = []
  const lanes: Tape['lanes'] = []

  items.forEach((it, gi) => {
    const lane = threadLane.get(it.threadId) ?? 0
    if (it.kind === 'step' && it.step) {
      rows.push({ gi, sessionId: session.id, threadId: it.threadId, lane, step: it.step })
    } else if (it.mark) {
      tangles.push({ gi, sessionId: session.id, threadId: it.threadId, lane, count: it.mark.count, label: it.mark.label, steps: it.mark.steps })
    }
  })

  // Anchors: fork = parent step's gi if it exists, else last parent-lane row
  // before the branch's first row. Merge = first parent-lane row after its last.
  const stepGi = new Map<string, number>()
  for (const r of rows) stepGi.set(r.step.id, r.gi)
  const parentRowsAt = (lane: number) => rows.filter((r) => r.lane === lane)

  for (const t of session.threads) {
    const lane = threadLane.get(t.id) ?? 0
    const r = rangeOf.get(t.id) ?? { first: 0, last: 0 }
    const parentLane = threadLane.get(t.parent ?? '') ?? 0
    let forkGi: number | undefined
    let forkInferred = false
    if (t.forkStep && stepGi.has(t.forkStep)) forkGi = stepGi.get(t.forkStep)
    else {
      forkInferred = true
      const prow = parentRowsAt(parentLane)
      const before = prow.filter((x) => x.gi < r.first)
      forkGi = before.length ? before[before.length - 1]!.gi : Math.max(0, r.first - 1)
    }
    const prow = parentRowsAt(parentLane)
    let mergeGi: number | undefined
    let mergeInferred = false
    if (t.mergeStep && stepGi.has(t.mergeStep)) mergeGi = stepGi.get(t.mergeStep)
    else {
      // No explicit rejoin in the source: infer from chronology and mark it.
      mergeInferred = true
      const after = prow.filter((x) => x.gi > r.last)
      mergeGi = after.length ? after[0]!.gi : undefined
    }
    lanes.push({
      threadId: t.id, lane, label: t.label, kind: t.kind, agent: t.agent,
      firstGi: r.first, lastGi: r.last, forkGi, mergeGi, forkInferred, mergeInferred,
    })
  }

  return { sessionId: session.id, rows, tangles, lanes }
}

// Merge every session in a Weave into one chronological mega-session so all
// agents' strands braid on the same tape. Untimed sessions are appended in
// order after the last timed moment (their steps get synthetic timestamps).
// Each session's spine gets a 'meta' divider step announcing where it begins.
export function mergeSessions(weave: Weave): Session {
  const threads: Thread[] = []
  let cursor = Math.max(0, ...weave.sessions.map((s) => s.end ?? 0)) + 60_000
  const starts = weave.sessions.map((s) => s.start).filter((t): t is number => t != null)

  for (const s of weave.sessions) {
    const seen = new Map<string, string>() // step id -> namespaced id
    const cloneSteps = (steps: Step[]): Step[] =>
      steps.map((st) => {
        const id = `${s.id}/${st.id}`
        seen.set(st.id, id)
        return { ...st, id }
      })
    const sThreads = s.threads.map((t, i) => {
      const steps = cloneSteps(t.steps)
      // Session divider: a meta step at the head of each session's spine.
      if (i === 0 || t.kind === 'spine') {
        steps.unshift({
          id: `${s.id}/seg-mark`,
          ts: s.start,
          actor: 'system',
          kind: 'meta',
          title: s.title,
          body: `${s.agent} session${s.cwd ? ` — ${s.cwd}` : ''}${s.model ? ` — ${s.model}` : ''}`,
        })
      }
      return {
        ...t,
        id: `${s.id}/${t.id}`,
        agent: t.agent ?? s.agent,
        parent: t.parent ? `${s.id}/${t.parent}` : undefined,
        steps,
      }
    })
    // Repoint fork/merge anchors at the namespaced step ids.
    for (const t of sThreads) {
      if (t.forkStep) t.forkStep = seen.get(t.forkStep) ?? `${s.id}/${t.forkStep}`
      if (t.mergeStep) t.mergeStep = seen.get(t.mergeStep) ?? `${s.id}/${t.mergeStep}`
    }
    if (!s.timed) {
      // Synthetic time so the weave orders them after the timed strands.
      for (const t of sThreads) for (const st of t.steps) st.ts = cursor += 60_000
      cursor += 120_000
    }
    threads.push(...sThreads)
  }

  const end = Math.max(cursor, ...weave.sessions.map((s) => s.end ?? 0))
  return {
    id: 'all-strands',
    agent: 'unknown',
    title: 'all strands',
    start: starts.length ? Math.min(...starts) : null,
    end,
    timed: true,
    threads,
    files: weave.files.map((f) => f.path),
  }
}
