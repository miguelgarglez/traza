import type { Session, Step, Thread, Weave } from './model.ts'
import { redactText } from './redact.ts'

// metro.ts — turn a Session's threads into an octilinear (45°/90°) schematic:
// the spine is a straight trunk line, branches arc off at 45° onto parallel
// rows and either rejoin (interchange) or terminate. Collapsed offshoots
// become "closed works" spurs. Geometry is Beck-style: reading direction is
// always left-to-right, scale is distorted for clarity, never direction.

export type Pt = { x: number; y: number }
export type Tier = 'terminus' | 'interchange' | 'major' | 'local'

export interface Station {
  id: string
  stepIds: string[]
  step: Step
  name: string
  tier: Tier
  x: number
  y: number
  ord: number
  threadId: string
  lineId: string
}

export interface TrackSeg {
  pts: Pt[]
  /** link = transfer connector back to a merge station, not a ridden track */
  kind: 'track' | 'link' | 'stub'
  inferred?: boolean
  /** far link: span too long to draw — UI shows a nub + "returns to" tag */
  far?: boolean
}

export interface Line {
  id: string // thread id
  sessionId: string
  service: string
  agent: Session['agent']
  color: string
  trunk: boolean
  stations: Station[]
  segs: TrackSeg[]
  /** corridor row (0 = trunk), in offset units below the trunk */
  row: number
  forkStation?: { lineId: string; stationId: string; inferred: boolean }
  mergeStation?: { lineId: string; stationId: string; inferred: boolean }
  worksOnly?: { count: number; label: string }
}

export interface Works {
  id: string
  at: { lineId: string; stationId: string }
  x: number
  y: number
  count: number
  label: string
  stepIds: string[]
  steps: Step[]
}

export interface Label {
  x: number
  y: number
  side: 1 | -1
  text: string
  lod: number
  stationId: string
}

export interface Corridor {
  session: Session
  lines: Line[]
  works: Works[]
  labels: Label[]
  y0: number
  height: number
  trunkY: number
}

export interface Network {
  corridors: Corridor[]
  bounds: { x0: number; y0: number; x1: number; y1: number }
  stats: { stations: number; lines: number; works: number }
}

export const AGENT_COLORS: Record<string, string> = {
  devin: '#0F4E9E', // L10 dark blue
  codex: '#E2001A', // L2 red
  cursor: '#6BBE45', // L5 green
  atif: '#F6B100', // L3 yellow
  unknown: '#7D6B2D', // L12 olive
}
const EXTRA_COLORS = ['#8C2A93', '#00A3E0', '#E87500', '#4B4E9B'] // L9, L9B, L4, L7-ish

export const P = 26 // station pitch
export const U = 72 // branch row offset
const WORKS_LEN = 42
const MAX_DEPTH = 6 // deeper nesting collapses to a works spur
const LABEL_MIN = 4 // min major stations always labelled at lod 0

const short = (t: string, n = 26) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t)

function tierOf(step: Step): Tier {
  if (step.actor === 'user') return 'major'
  if ((step.calls ?? []).some((c) => c.ok === false)) return 'major'
  return 'local'
}

function nameOf(step: Step): string {
  const t = step.title?.trim().replace(/^<[^>]+>\s*/, '')
  if (t) return short(redactText(t).text)
  if (step.calls?.length) return short(step.calls.map((c) => c.name).join(', '))
  return step.kind
}

interface MarkBag {
  marks?: { anchorNode: number | null; label: string; count: number; steps: Step[] }[]
}

export function buildCorridor(session: Session): Omit<Corridor, 'y0'> {
  const spine = session.threads.find((t) => t.kind === 'spine') ?? session.threads[0]
  if (!spine) return { session, lines: [], works: [], labels: [], height: U * 1.6, trunkY: 0 }
  const color = AGENT_COLORS[session.agent] ?? EXTRA_COLORS[0] ?? '#0F4E9E'
  const lines: Line[] = []
  const works: Works[] = []
  const stationOf = new Map<string, Station>() // step id -> station

  // 1. The trunk.
  const trunk: Line = {
    id: spine.id,
    sessionId: session.id,
    service: session.title,
    agent: session.agent,
    color,
    trunk: true,
    stations: spine.steps.map((st, i) => {
      const s: Station = {
        id: `${session.id}/${spine.id}/${st.id}`,
        stepIds: [st.id],
        step: st,
        name: nameOf(st),
        tier: i === 0 || i === spine.steps.length - 1 ? 'terminus' : tierOf(st),
        x: i * P,
        y: 0,
        ord: i,
        threadId: spine.id,
        lineId: spine.id,
      }
      stationOf.set(st.id, s)
      return s
    }),
    segs: [],
    row: 0,
  }
  if (trunk.stations.length) {
    trunk.segs.push({
      kind: 'track',
      pts: [
        { x: trunk.stations[0]!.x - P * 1.4, y: 0 },
        { x: trunk.stations[trunk.stations.length - 1]!.x + P * 1.4, y: 0 },
      ],
    })
  }
  lines.push(trunk)

  // Rows: y-offset -> occupied x ranges (for collision-free parallel rows),
  // and row -> station x positions (so a crossing diagonal misses glyphs).
  const rowRanges = new Map<number, { x0: number; x1: number }[]>()
  const stationsOnRow = new Map<number, number[]>()
  const occupy = (row: number, x0: number, x1: number) => {
    const arr = rowRanges.get(row) ?? []
    arr.push({ x0, x1 })
    rowRanges.set(row, arr)
  }
  const rowFree = (row: number, x0: number, x1: number) =>
    !(rowRanges.get(row) ?? []).some((r) => x0 <= r.x1 + P && x1 >= r.x0 - P)
  stationsOnRow.set(0, trunk.stations.map((s) => s.x))

  // 2. Branch lines, parent-first, in fork order. Real exports carry noise:
  // chains of 1-2 step handoff threads (tangle chatter) are collapsed into
  // works spurs and their children re-anchored to the nearest real ancestor.
  const byId = new Map<string, Line>()
  byId.set(trunk.id, trunk)
  const threadOf = new Map(session.threads.map((t) => [t.id, t]))
  const stepStation = (id: string | undefined) => (id ? stationOf.get(id) : undefined)

  const collapsed = new Set<string>()
  for (const t of session.threads) {
    if (t.id === spine.id) continue
    if (t.kind === 'tangle' || (t.kind === 'branch' && t.steps.length <= 2)) collapsed.add(t.id)
  }

  // For a branch: nearest non-collapsed ancestor line + fork candidates
  // (its own forkStep first, then each collapsed ancestor's — the deepest
  // resolvable anchor wins).
  const effParent = (t: Thread) => {
    const chain: Thread[] = []
    let p = t.parent
    while (p && collapsed.has(p) && threadOf.has(p)) {
      chain.push(threadOf.get(p)!)
      p = threadOf.get(p)!.parent
    }
    return { parentId: p ?? spine.id, chain }
  }

  const collapsedWorks: { line: Line; station: Station; count: number; label: string; stepIds: string[]; steps: Step[] }[] = []
  const collapsedSeen = new Set<string>()
  const worksFrom = (t: Thread) => {
    if (collapsedSeen.has(t.id)) return
    collapsedSeen.add(t.id)
    const { parentId, chain } = effParent(t)
    const parentLine = byId.get(parentId) ?? trunk
    let st: Station | undefined
    for (const c of [t, ...chain]) {
      const hit = c.forkStep ? stationOf.get(c.forkStep) : undefined
      if (hit && hit.lineId === parentLine.id) { st = hit; break }
    }
    st ??= parentLine.stations[Math.max(0, parentLine.stations.length - 2)] ?? parentLine.stations[0]
    if (!st) return
    collapsedWorks.push({ line: parentLine, station: st, count: t.steps.length, label: t.label || 'offshoot', stepIds: t.steps.map((s) => s.id), steps: t.steps })
  }

  // Resolve a step id to a station on a line; when it doesn't resolve, fall
  // back to the closest station by time (before = last at-or-before ts,
  // after = first at-or-after ts), then to a line end for untimed parents.
  const anchor = (line: Line, stepId: string | undefined, ts: number | null | undefined, dir: 'before' | 'after') => {
    const hit = stepStation(stepId)
    if (hit && hit.lineId === line.id) return { s: hit, inferred: false }
    let best: Station | undefined
    let sawTs = false
    for (const s of line.stations) {
      const t = s.step.ts
      if (t == null || ts == null) continue
      sawTs = true
      if (dir === 'before' ? t <= ts : t >= ts) {
        best = s
        if (dir === 'after') break
      }
    }
    if (!sawTs) best = dir === 'before' ? line.stations[Math.max(0, line.stations.length - 2)] : line.stations[line.stations.length - 1]
    return { s: best ?? line.stations[0]!, inferred: true }
  }

  // devin step ids are n<nodeId>; a branch's result rejoins the parent at the
  // first parent node numbered after the branch's last node. Real provenance.
  const numOf = (id?: string) => {
    const m = id?.match(/^n(\d+)$/)
    return m ? parseInt(m[1]!, 10) : NaN
  }
  const mergeByOrd = (line: Line, t: Thread): Station | undefined => {
    const nums = t.steps.map((s) => numOf(s.id)).filter((n) => !isNaN(n))
    if (!nums.length) return undefined
    const max = Math.max(...nums)
    return line.stations.find((s) => numOf(s.step.id) > max)
  }

  const queue = session.threads.filter((t) => t.id !== spine.id && !collapsed.has(t.id))
  let progress = true
  let extraIdx = 0

  while (queue.length && progress) {
    progress = false
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i]!
      const { parentId, chain } = effParent(t)
      const parentLine = byId.get(parentId)
      if (!parentLine || (parentId !== spine.id && !byId.has(parentId))) continue
      queue.splice(i, 1)
      i--
      progress = true

      const depth = parentLine.row + 1
      if (depth > MAX_DEPTH) {
        worksFrom(t)
        continue
      }
      const firstTs = t.steps.find((s) => s.ts != null)?.ts ?? null
      const lastTs = [...t.steps].reverse().find((s) => s.ts != null)?.ts ?? firstTs
      // fork: own forkStep, then collapsed ancestors', then time fallback
      let forkSt: Station | undefined
      let forkInferred = false
      for (const c of [t, ...chain]) {
        const hit = c.forkStep ? stationOf.get(c.forkStep) : undefined
        if (hit && hit.lineId === parentLine.id) { forkSt = hit; forkInferred = chain.length > 0; break }
      }
      if (!forkSt) {
        const a = anchor(parentLine, t.forkStep, firstTs, 'before')
        forkSt = a.s
        forkInferred = true
      }
      if (!forkSt) {
        // parent line has no stations to hang a fork from (empty spine)
        worksFrom(t)
        continue
      }
      // merge: explicit anchor, else node-order inference (a subagent's
      // result lands on the first parent step after the branch's last node),
      // else time inference. Nothing means the branch really terminates.
      let merge: { s: Station; inferred: boolean } | undefined
      if (t.mergeStep) merge = anchor(parentLine, t.mergeStep, lastTs, 'after')
      else {
        const byOrd = mergeByOrd(parentLine, t)
        if (byOrd && byOrd.ord > forkSt.ord) merge = { s: byOrd, inferred: true }
        else if (lastTs != null) {
          const after = parentLine.stations.find((s) => s.step.ts != null && s.step.ts > lastTs)
          if (after) merge = { s: after, inferred: true }
        }
      }

      // pick a row and a small fork jog: the branch's row must be free over
      // its x-extent, and its 45° descent must not pass within ~11px of a
      // station glyph on any row it crosses. The jog (a short horizontal run
      // on the parent row before descending) sidesteps blocked crossings.
      const n = t.steps.length
      const baseX = forkSt.x
      const parentRow = parentLine.row
      const mergeX = merge?.s.x ?? -Infinity
      const SHIFTS = [0, 13, 26, 39, 52, 65, 78]
      let row = depth
      let jog = 0
      let firstX = 0
      let endX = 0
      let extentX = 0
      outer: for (; row <= depth + 60; row++) {
        for (const s of SHIFTS) {
          const fx = baseX + s + (row - parentRow) * U
          const ex = fx + Math.max(0, n - 1) * P
          const extent = Math.max(ex, mergeX)
          if (!rowFree(row, Math.min(baseX + s, fx) - U * 0.4, extent + U * 0.4)) continue
          const hit = Array.from({ length: row - parentRow - 1 }, (_, i) => parentRow + 1 + i)
            .some((r) => (stationsOnRow.get(r) ?? []).some((sx) => Math.abs(sx - (baseX + s + (r - parentRow) * U)) < 11))
          if (!hit) {
            jog = s
            firstX = fx
            endX = ex
            extentX = extent
            break outer
          }
        }
        if (row >= depth + 60) {
          // give up glyph-avoidance before geometry: deepest free row, no jog
          firstX = baseX + (row - parentRow) * U
          endX = firstX + Math.max(0, n - 1) * P
          extentX = Math.max(endX, mergeX)
          if (rowFree(row, Math.min(baseX, firstX) - U * 0.4, extentX + U * 0.4)) break
        }
      }
      occupy(row, Math.min(baseX, firstX) - U * 0.4, extentX + U * 0.4)
      stationsOnRow.set(row, [...(stationsOnRow.get(row) ?? []), ...Array.from({ length: n }, (_, j) => firstX + j * P)])

      const lineColor = session.agent === 'unknown' ? (EXTRA_COLORS[extraIdx++ % EXTRA_COLORS.length] ?? color) : color
      const y = row * U
      const line: Line = {
        id: t.id,
        sessionId: session.id,
        service: t.label,
        agent: session.agent,
        color: lineColor,
        trunk: false,
        stations: [],
        segs: [],
        row,
        forkStation: { lineId: parentLine.id, stationId: forkSt!.id, inferred: forkInferred },
      }
      // fork -> (optional jog along the parent track) -> 45° descent -> row
      const pts: Pt[] = [{ x: forkSt.x, y: forkSt.y }]
      if (jog !== 0) pts.push({ x: forkSt.x + jog, y: forkSt.y })
      pts.push({ x: firstX, y })
      for (let j = 0; j < n; j++) {
        const st = t.steps[j]!
        const s: Station = {
          id: `${session.id}/${t.id}/${st.id}`,
          stepIds: [st.id],
          step: st,
          name: nameOf(st),
          tier: j === n - 1 && !merge ? 'terminus' : tierOf(st),
          x: firstX + j * P,
          y,
          ord: j,
          threadId: t.id,
          lineId: line.id,
        }
        if (j > 0) pts.push({ x: s.x, y })
        stationOf.set(st.id, s)
        line.stations.push(s)
      }
      line.segs.push({ kind: 'track', pts })

      if (merge) {
        const M = merge.s
        const dyUp = y - M.y // vertical distance the return climb covers
        if (M.x >= endX + dyUp) {
          // junction rejoin: extend horizontally then a 45° climb into M
          line.segs.push({ kind: 'track', pts: [{ x: endX, y }, { x: M.x - dyUp, y }, { x: M.x, y: M.y }], inferred: merge.inferred })
        } else {
          // transfer link: branch ends past the merge. Short spans draw the
          // full dashed connector; long ones get far=true (UI shows a nub
          // off the terminus + a "returns to" tag at both ends).
          const far = endX - M.x > U * 5
          line.segs.push({
            kind: 'link',
            inferred: true,
            far,
            pts: far
              ? [{ x: endX, y }, { x: endX + 44, y: y - 8 }]
              : [
                  { x: endX, y },
                  { x: endX + Math.min(36, Math.max(14, (endX - M.x) * 0.15)), y: M.y + 5 },
                  { x: M.x, y: M.y },
                ],
          })
        }
        line.mergeStation = { lineId: parentLine.id, stationId: M.id, inferred: merge.inferred }
      }

      forkSt.tier = 'interchange'
      if (merge) merge.s.tier = 'interchange'
      byId.set(t.id, line)
      lines.push(line)
    }
  }

  // collapsed threads resolve their anchors now that every line is laid
  for (const t of session.threads) if (collapsed.has(t.id)) worksFrom(t)

  // 3. Works spurs: collapsed threads + per-thread marks -> "closed works"
  // stubs. Real exports generate hundreds of tiny marks; a corridor shows at
  // most ~3 spurs per line — individual when few, one aggregated spur at the
  // median anchor when many.
  interface WorkItem { line: Line; station: Station; count: number; label: string; stepIds: string[]; steps: Step[] }
  const workItems = new Map<string, WorkItem[]>()
  const pushWork = (line: Line, station: Station | undefined, count: number, label: string, stepIds: string[], steps: Step[]) => {
    if (!station) return
    const arr = workItems.get(line.id) ?? []
    arr.push({ line, station, count, label, stepIds, steps })
    workItems.set(line.id, arr)
  }
  for (const w of collapsedWorks) pushWork(w.line, w.station, w.count, w.label, w.stepIds, w.steps)
  for (const t of session.threads) {
    const bag = (t as Thread & MarkBag).marks ?? []
    const line = byId.get(t.id) ?? trunk
    for (const m of bag) {
      const st =
        (m.anchorNode != null ? stationOf.get(`n${m.anchorNode}`) : undefined) ??
        line.stations[line.stations.length - 1]
      pushWork(line, st, m.count, m.label, m.steps.map((s) => s.id), m.steps)
    }
  }
  for (const [lineId, items] of workItems) {
    items.sort((a, b) => a.station.x - b.station.x)
    const emit = (group: WorkItem[], k: number) => {
      const mid = group[Math.floor(group.length / 2)]!
      works.push({
        id: `${session.id}/${lineId}#w${works.length}`,
        at: { lineId, stationId: mid.station.id },
        x: mid.station.x + (k % 2 ? -1 : 1) * WORKS_LEN * 0.28,
        y: mid.station.y + WORKS_LEN * (1 + (k % 3) * 0.35),
        count: group.reduce((n, g) => n + g.count, 0),
        label: group.length === 1 ? group[0]!.label : 'offshoots',
        stepIds: group.flatMap((g) => g.stepIds),
        steps: group.flatMap((g) => g.steps),
      })
    }
    if (items.length <= 3) items.forEach((w, k) => emit([w], k))
    else {
      // bucket into up-to-3 clusters over the line's span
      const x0 = items[0]!.station.x
      const x1 = items[items.length - 1]!.station.x
      const span = Math.max(1, x1 - x0)
      const buckets: WorkItem[][] = [[], [], []]
      for (const w of items) buckets[Math.min(2, Math.floor(((w.station.x - x0) / span) * 3))]?.push(w)
      buckets.filter((b) => b.length).forEach((b, k) => emit(b, k))
    }
  }

  // 4. Labels: majors get horizontal labels centered on the station,
  // alternating above/below the line; collisions demote lod.
  const labels: Label[] = []
  const placed: { x0: number; x1: number; y: number }[] = []
  const candidates = lines
    .flatMap((l) => l.stations)
    .filter((s) => s.tier !== 'local')
    .sort((a, b) => (a.tier === 'terminus' ? -1 : b.tier === 'terminus' ? 1 : a.tier === 'interchange' ? -1 : 0) || a.x - b.x)
  let lod0 = 0
  for (const s of candidates) {
    const side: 1 | -1 = s.ord % 2 === 0 ? -1 : 1
    const w = s.name.length * 5.1 + 12
    const lx = s.x
    // two tiers per side, like a real map stacking labels when space is tight;
    // a name that finds no clean slot is dropped — the dot, hover name and
    // inspector still carry it
    const offs = side < 0 ? [-14, -34] : [22, 42]
    let lod = s.tier === 'local' ? 2 : 0
    for (const off of offs) {
      const ly = s.y + off
      const box = { x0: lx - w / 2, x1: lx + w / 2, y: ly }
      if (!placed.some((b) => Math.abs(b.y - ly) < 13 && !(box.x1 < b.x0 - 3 || box.x0 - 3 > b.x1))) {
        placed.push(box)
        labels.push({ x: lx, y: ly, side, text: s.name, lod, stationId: s.id })
        if (lod === 0) lod0++
        break
      }
    }
  }
  // guarantee a few lod-0 names even on dense maps: upgrade the first majors
  if (lod0 < LABEL_MIN) {
    for (const l of labels) if (l.lod > 0 && lod0 < LABEL_MIN) (l.lod = 0, lod0++)
  }

  const maxRow = Math.max(0, ...lines.map((l) => l.row)) * U
  const maxWorks = Math.max(0, ...works.map((w) => w.y))
  const height = U * 1.6 + maxRow + Math.max(maxWorks, 0) + U * 1.2
  return { session, lines, works, labels, height, trunkY: 0 }
}

export function buildNetwork(weave: Weave): Network {
  const corridors: Corridor[] = []
  let y = 0
  const sorted = [...weave.sessions].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity))
  sorted.forEach((s) => {
    const c = buildCorridor(s)
    corridors.push({ ...c, y0: y, trunkY: y })
    // shift all geometry down by corridor base
    for (const l of c.lines) {
      for (const st of l.stations) st.y += y
      for (const sg of l.segs) for (const p of sg.pts) p.y += y
    }
    for (const w of c.works) w.y += y
    for (const l of c.labels) l.y += y
    y += c.height + U * 1.6
  })
  const x1 = Math.max(600, ...corridors.flatMap((c) => c.lines.flatMap((l) => l.segs.flatMap((s) => s.pts.map((p) => p.x)))), ...corridors.flatMap((c) => c.works.map((w) => w.x)))
  // nameboards anchor left of each trunk's first stop; reserve the room
  const nbPad = Math.max(0, ...corridors.map((c) => {
    const t = c.lines.find((l) => l.trunk)
    return t ? t.service.length * 7 + 80 : 0
  }))
  const stations = corridors.reduce((n, c) => n + c.lines.reduce((m, l) => m + l.stations.length, 0), 0)
  return {
    corridors,
    bounds: { x0: -Math.max(P * 6, nbPad), y0: -U, x1: x1 + P * 6, y1: y },
    stats: { stations, lines: corridors.reduce((n, c) => n + c.lines.length, 0), works: corridors.reduce((n, c) => n + c.works.length, 0) },
  }
}

// Flattened ride order for one corridor: DFS — ride the trunk, detour onto
// each branch fully at its fork, then resume the trunk (terminus reversal).
export interface RideStop {
  station: Station
  line: Line
  branch: boolean
}
export function rideRoute(c: Corridor): RideStop[] {
  const out: RideStop[] = []
  const trunk = c.lines.find((l) => l.trunk)
  if (!trunk) return out
  const branchesFrom = new Map<string, Line[]>()
  for (const l of c.lines) {
    if (l.trunk || !l.forkStation) continue
    const arr = branchesFrom.get(l.forkStation.stationId) ?? []
    arr.push(l)
    branchesFrom.set(l.forkStation.stationId, arr)
  }
  const walk = (line: Line, branch: boolean) => {
    for (const s of line.stations) {
      out.push({ station: s, line, branch })
      for (const b of branchesFrom.get(s.id) ?? []) walk(b, true)
    }
  }
  walk(trunk, false)
  return out
}
