import type { Line, Network, Pt, Station, Works } from './metro.ts'
import type { Step } from './model.ts'
import { buildTape } from './weave.ts'

// ride.ts — the replay. The tape's event order becomes a train ride through
// the network: consecutive stops on the same line are a leg, line changes
// route through real fork/merge geometry, and folded offshoots are stops at
// their works spur. The marker is a cursor, not a train timetable — it can
// run a track in either direction and it hops across symbolic far-links.

export interface RideStop {
  /** station id or works id */
  id: string
  kind: 'station' | 'works'
  x: number
  y: number
  name: string
  lineId?: string
  step?: Step
}

export interface RideLeg {
  stop: RideStop
  /** subpaths; a break between them is a hop (far transfer link) */
  path: Pt[][]
  /** arc length in world px */
  len: number
  /** world points where the train crosses a junction: fork descents and merge rejoins */
  switches: Pt[]
}

export interface Ride {
  corridorIdx: number
  legs: RideLeg[]
  total: number
  stops: RideStop[]
}

const segLen = (pts: Pt[]) => {
  let n = 0
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
  return n
}
const pathLen = (p: Pt[][]) => p.reduce((n, s) => n + segLen(s), 0)

interface Ctx {
  lineOf: Map<string, Line> // line id -> line
  stationOf: Map<string, Station>
  worksOf: Map<string, Works>
  /** line -> {parent line, fork station, merge station} */
}

/** Straight travel along one line between two points on its row. */
const travel = (a: Pt, b: Pt): Pt[] => [a, b]

function descentPts(line: Line): Pt[] {
  const pts = line.segs[0]?.pts ?? []
  // seg[0] = fork..descent..then every station on the row; take up to first station
  const first = line.stations[0]
  if (!first) return pts
  const end = pts.findIndex((p) => p.x === first.x && p.y === first.y)
  return end < 0 ? pts.slice(0, 3) : pts.slice(0, end + 1)
}

function mergeJoin(line: Line): Pt[][] {
  // after the last station: either the rejoin track arc or the link nub
  const tail = line.segs.slice(1).find((s) => s.kind !== 'stub')
  if (!tail) return []
  const end = line.stations.at(-1)
  if (!end) return []
  return [[{ x: end.x, y: end.y }, ...tail.pts.slice(1)]]
}

export function buildRide(net: Network, corridorIdx: number): Ride | null {
  const c = net.corridors[corridorIdx]
  if (!c) return null
  const ctx: Ctx = {
    lineOf: new Map(c.lines.map((l) => [l.id, l])),
    stationOf: new Map(c.lines.flatMap((l) => l.stations.map((s) => [s.id, s]))),
    worksOf: new Map(c.works.map((w) => [w.id, w])),
  }
  const stepToWorks = new Map<string, Works>()
  for (const w of c.works) for (const id of w.stepIds) stepToWorks.set(id, w)
  const stationByStep = new Map<string, Station>()
  for (const l of c.lines) for (const s of l.stations) stationByStep.set(`${s.threadId}/${s.step.id}`, s)

  const tape = buildTape(c.session)
  interface Ev { gi: number; stop: RideStop }
  const events: Ev[] = []
  for (const r of tape.rows) {
    const st = stationByStep.get(`${r.threadId}/${r.step.id}`)
    if (st) {
      events.push({
        gi: r.gi,
        stop: { id: st.id, kind: 'station', x: st.x, y: st.y, name: st.name, lineId: st.lineId, step: st.step },
      })
      continue
    }
    // folded step — visit its works spur
    const w = stepToWorks.get(r.step.id)
    if (w) events.push({ gi: r.gi, stop: { id: w.id, kind: 'works', x: w.x, y: w.y, name: w.label, step: r.step } })
  }
  for (const tg of tape.tangles) {
    const sid = tg.steps[0] && stepToWorks.get(tg.steps[0].id)
    if (sid) events.push({ gi: tg.gi, stop: { id: sid.id, kind: 'works', x: sid.x, y: sid.y, name: sid.label, step: tg.steps[0] } })
  }
  events.sort((a, b) => a.gi - b.gi)

  // collapse consecutive duplicates (a station can own several steps)
  const stops: RideStop[] = []
  for (const e of events) if (stops.at(-1)?.id !== e.stop.id) stops.push(e.stop)
  if (stops.length < 2) return { corridorIdx, legs: [], total: 0, stops }

  // ---- path between consecutive stops, through real track geometry ----
  const parentOf = (line: Line): { line: Line; viaFork: Station; viaMerge?: Station } | null => {
    if (!line.forkStation) return null
    const pl = ctx.lineOf.get(line.forkStation.lineId)
    const fs = ctx.stationOf.get(line.forkStation.stationId)
    if (!pl || !fs) return null
    const ms = line.mergeStation ? ctx.stationOf.get(line.mergeStation.stationId) : undefined
    return { line: pl, viaFork: fs, viaMerge: ms }
  }
  const ancestors = (line: Line): Line[] => {
    const out: Line[] = []
    let cur: Line | undefined = line
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      const p = parentOf(cur)
      if (!p) break
      out.push(p.line)
      cur = p.line
    }
    return out
  }

  const route = (a: RideStop, b: RideStop): { path: Pt[][]; switches: Pt[] } => {
    const switches: Pt[] = []
    const direct = (path: Pt[][]) => ({ path, switches })
    // works spurs: hop straight to/from the badge — it's a fly-off, not a track
    if (b.kind === 'works' || a.kind === 'works') return direct([[{ x: a.x, y: a.y }, { x: b.x, y: b.y }]])
    const lineA = ctx.lineOf.get(a.lineId!)
    const lineB = ctx.lineOf.get(b.lineId!)
    if (!lineA || !lineB) return direct([[{ x: a.x, y: a.y }, { x: b.x, y: b.y }]])
    if (lineA.id === lineB.id) return direct([travel({ x: a.x, y: a.y }, { x: b.x, y: b.y })])

    const parts: Pt[][] = []
    let cur: Pt = { x: a.x, y: a.y }
    let curLine = lineA

    // climb until b's line is reachable below us (or is our line)
    const climbGuard = new Set<string>()
    while (!ancestors(lineB).includes(curLine) && curLine.id !== lineB.id) {
      if (climbGuard.has(curLine.id)) break
      climbGuard.add(curLine.id)
      const p = parentOf(curLine)
      if (!p) break
      const last = curLine.stations.at(-1)
      if (p.viaMerge && last) {
        // forward along the branch to its end, then the rejoin arc / link nub
        parts.push(travel(cur, { x: last.x, y: last.y }))
        for (const jp of mergeJoin(curLine)) parts.push(jp)
        cur = { x: p.viaMerge.x, y: p.viaMerge.y }
        switches.push({ x: p.viaMerge.x, y: p.viaMerge.y })
      } else {
        // no recorded merge: back up the descent to the fork
        parts.push(travel(cur, { x: p.viaFork.x, y: p.viaFork.y }))
        cur = { x: p.viaFork.x, y: p.viaFork.y }
      }
      curLine = p.line
    }

    // descend from curLine toward lineB
    const desGuard = new Set<string>()
    while (curLine.id !== lineB.id) {
      if (desGuard.has(curLine.id)) break
      desGuard.add(curLine.id)
      // find the child of curLine on b's ancestry path
      const bAnc = ancestors(lineB)
      const idx = bAnc.indexOf(curLine)
      const child = idx > 0 ? bAnc[idx - 1]! : lineB
      const pc = child.forkStation
      const F = pc ? ctx.stationOf.get(pc.stationId) : undefined
      if (!pc || !F || pc.lineId !== curLine.id) break
      parts.push(travel(cur, { x: F.x, y: F.y }))
      parts.push(descentPts(child))
      switches.push({ x: F.x, y: F.y })
      cur = child.stations[0] ? { x: child.stations[0].x, y: child.stations[0].y } : { x: F.x, y: F.y }
      curLine = child
    }
    parts.push(travel(cur, { x: b.x, y: b.y }))
    // split at hop boundaries: a >260px jump inside a part becomes a break —
    // the marker fades across it like a transfer, not a ride
    const out: Pt[][] = []
    for (const p of parts) {
      let cut = -1
      for (let i = 1; i < p.length; i++) {
        if (Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y) > 260) {
          cut = i
          break
        }
      }
      if (cut > 0) out.push(p.slice(0, cut), p.slice(cut))
      else out.push(p)
    }
    return direct(out.filter((s) => s.length > 1))
  }

  const legs: RideLeg[] = []
  for (let i = 1; i < stops.length; i++) {
    const { path, switches } = route(stops[i - 1]!, stops[i]!)
    legs.push({ stop: stops[i]!, path, len: Math.max(1, pathLen(path)), switches })
  }
  return { corridorIdx, legs, total: legs.reduce((n, l) => n + l.len, 0), stops }
}

/** Position+angle at arc distance d into a leg. */
export function legPoint(leg: RideLeg, dist: number): { x: number; y: number; angle: number; hop: boolean } {
  let dLeft = dist
  for (let si = 0; si < leg.path.length; si++) {
    const seg = leg.path[si]!
    const sl = segLen(seg)
    if (dLeft <= sl || si === leg.path.length - 1) {
      // walk the polyline
      for (let i = 1; i < seg.length; i++) {
        const a = seg[i - 1]!
        const b = seg[i]!
        const l = Math.hypot(b.x - a.x, b.y - a.y)
        if (dLeft <= l || i === seg.length - 1) {
          const t = l ? Math.min(1, dLeft / l) : 1
          return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI, hop: false }
        }
        dLeft -= l
      }
      const last = seg.at(-1)!
      return { x: last.x, y: last.y, angle: 0, hop: false }
    }
    dLeft -= sl
  }
  const last = leg.path.at(-1)?.at(-1)
  return { x: last?.x ?? 0, y: last?.y ?? 0, angle: 0, hop: true }
}
