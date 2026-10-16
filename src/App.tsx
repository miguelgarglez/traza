import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ingest, type DroppedFile } from './lib/parse/ingest.ts'
import { buildNetwork, type Network, type Station, type Works } from './lib/metro.ts'
import { buildRide, legPoint, type Ride } from './lib/ride.ts'
import type { Weave } from './lib/model.ts'
import { filesFromDrop, filesFromInput, loadDemo } from './lib/files.ts'
import { buildTethers } from './lib/links.ts'
import { callFailed, stepText, stepTitle, toolKind, type ToolKind } from './lib/title.ts'
import MapView, { type MapHandle } from './MapView.tsx'
import Inspector from './Inspector.tsx'
import Waterfall from './Waterfall.tsx'
import { haptic, hapticsOn, setHaptics } from './lib/haptics.ts'

type Status = 'boot' | 'ready' | 'empty' | 'lineclosed'
type Pace = 'tour' | 'study' | 'real'

// how each pace spends time on a leg (ms per world-px speed is derived)
const TOUR_PXS = 300
const STUDY_PXS = 250
const REAL_SCALE = 60 // 1 wall-clock minute of agent work = 1s of replay
const REAL_MIN = 260 // never faster than this per leg, even on a 0ms step
const REAL_MAX = 7000 // long idles fold — the gap is named, not endured
const REAL_FOLD = 30_000 // raw idle longer than this gets the '…idle' note

function useReducedMotion() {
  const [r, setR] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const f = () => setR(mq.matches)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [])
  return r
}

export default function App() {
  const [weave, setWeave] = useState<Weave | null>(null)
  const [files, setFiles] = useState<DroppedFile[]>([])
  const [status, setStatus] = useState<Status>('boot')
  const [busy, setBusy] = useState<string | null>('surveying the export…')
  const [sel, setSel] = useState<string | null>(null)
  const [keyOpen, setKeyOpen] = useState(() => typeof innerWidth === 'undefined' || innerWidth > 720)
  // the user asked for the key body themselves — during the tour's first
  // step the panel stays shut unless explicitly pinned open
  const [keyPinned, setKeyPinned] = useState(false)
  // first paint is a held system beat: chrome waits for the opening dive
  // to land (or for a gesture to steal the camera) before it appears
  const [landed, setLanded] = useState(false)
  const [srcOpen, setSrcOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [fallOpen, setFallOpen] = useState(false)
  const map = useRef<MapHandle>(null)
  const filePick = useRef<HTMLInputElement>(null)
  const dirPick = useRef<HTMLInputElement>(null)

  const net: Network | null = useMemo(() => (weave && weave.sessions.length ? buildNetwork(weave) : null), [weave])
  const tethers = useMemo(() => (weave && net ? buildTethers(weave, net) : []), [weave, net])

  // ---- the ride ----
  const [svcIdx, setSvcIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [pace, setPace] = useState<Pace>('study')
  const [speed, setSpeed] = useState(1)
  const [rideUi, setRideUi] = useState<{ stop: number; total: number; name: string; next: string; clock: string; idle?: string } | null>(null)
  const rideRef = useRef<{ leg: number; dist: number; dwell: number }>({ leg: 0, dist: 0, dwell: 0 })
  // express seek: a pending stop index the shuttle fast-travels to along the
  // real thread — forward through knots, backward by rewinding legs
  const seekRef = useRef<number | null>(null)
  const [seeking, setSeeking] = useState<number | null>(null)
  const reduced = useReducedMotion()
  const dockRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const [pickOpen, setPickOpen] = useState(false)

  const ride: Ride | null = useMemo(
    () => (net && net.corridors.length ? buildRide(net, Math.min(svcIdx, net.corridors.length - 1)) : null),
    [net, svcIdx],
  )

  const stationOf = useMemo(() => {
    const m = new Map<string, { s: Station; lineIdx: number; corridorIdx: number }>()
    if (!net) return m
    net.corridors.forEach((c, ci) => c.lines.forEach((l, li) => l.stations.forEach((s) => m.set(s.id, { s, lineIdx: li, corridorIdx: ci }))))
    return m
  }, [net])

  // wall-clock per stop — nulls filled by interpolation so untimed steps
  // still ride the loom at the session's median step pace
  const times = useMemo(() => {
    if (!ride) return [] as number[]
    const raw = ride.stops.map((s) => s.step?.ts ?? null)
    const known = raw.map((t, i) => ({ t, i })).filter((x) => x.t != null)
    const med =
      known.length > 1
        ? known
            .slice(1)
            .map((k, i) => k.t! - known[i]!.t!)
            .filter((d) => d > 0)
            .sort((a, b) => a - b)[Math.floor(known.length / 2)] ?? 2000
        : 2000
    return raw.map((t, i) => {
      if (t != null) return t
      // interpolate between nearest known neighbours, else walk back at median
      const prev = [...known].reverse().find((k) => k.i < i)
      return prev ? prev.t! + med * (i - prev.i) : (known[0]?.t ?? 0) - med * (known[0]?.i ?? 0 - i) * -1
    })
  }, [ride])

  // compressed scrubber fractions: real time, each gap folded at 30s —
  // the loomline and the waterfall draw the same clock
  const eff = useMemo(() => {
    if (!ride || !times.length) return [] as number[]
    const pos: number[] = [0]
    let acc = 0
    for (let i = 1; i < times.length; i++) {
      acc += Math.min(Math.max(times[i]! - times[i - 1]!, 150), REAL_FOLD)
      pos.push(acc)
    }
    return pos.map((p, i) => (acc ? p / acc : i / Math.max(1, times.length - 1)))
  }, [ride, times])

  const legMs = useCallback(
    (i: number): number => {
      if (pace === 'real') {
        const dt = Math.max(0, (times[i + 1] ?? 0) - (times[i] ?? 0))
        return Math.min(Math.max(dt / REAL_SCALE, REAL_MIN), REAL_MAX) / speed
      }
      const pxps = pace === 'study' ? STUDY_PXS : TOUR_PXS
      const leg = ride?.legs[i]
      return ((leg?.len ?? 100) / pxps) * 1000 / speed
    },
    [pace, speed, ride, times],
  )

  const dwellFor = useCallback(
    (stopId: string): number => {
      if (pace === 'real') return 160
      if (pace === 'tour') return 200
      // study: a turn earns a reading pause scaled by what it's saying
      const st = stationOf.get(stopId)?.s
      if (!st?.turnStart) return 340
      const line = net?.corridors.flatMap((c) => c.lines).find((l) => l.id === st.lineId)
      const turn = st.turnIdx != null ? line?.turns[st.turnIdx] : undefined
      const weight = turn ? turn.label.length * 22 + turn.stepIds.length * 240 : 0
      return Math.min(1200 + weight, 5200)
    },
    [pace, stationOf, net],
  )

  // fare meter — cumulative tokens spent, knot by knot
  const fares = useMemo(() => {
    if (!ride) return [] as number[]
    let acc = 0
    return ride.stops.map((s) => {
      const t = s.step?.tokens
      acc += (t?.input ?? 0) + (t?.output ?? 0)
      return acc
    })
  }, [ride])

  // turn key for j/k stepping — (line,turnIdx) pairs along the ride
  const turnKeyAt = useCallback(
    (stopIdx: number): string => {
      const stop = ride?.stops[stopIdx]
      const st = stop ? stationOf.get(stop.id)?.s : undefined
      return st ? `${st.lineId}:${st.turnIdx ?? -1}` : `w:${stop?.id ?? stopIdx}`
    },
    [ride, stationOf],
  )

  const rideClock = (i: number) => {
    const t = times[i]
    if (t == null) return ''
    const d = new Date(t)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  }

  const [solo, setSolo] = useState<number | null>(null)
  const [finder, setFinder] = useState(false)
  const switchFired = useRef(new Set<string>())
  const [guide, setGuide] = useState(0) // 0 off, 1 drag, 2 interchange, 3 ride
  // ride camera follow: any manual gesture suspends it until resumed
  const [follow, setFollow] = useState(true)
  const followRef = useRef(true)
  const setFollowOn = (v: boolean) => {
    followRef.current = v
    setFollow(v)
  }

  // touch feedback — iOS-capable via web-haptics, user-switchable
  const [hap, setHap] = useState(hapticsOn())

  // ---- the pick: filters dim what doesn't match ----
  const [fAgents, setFAgents] = useState<Set<string>>(new Set())
  const [fKinds, setFKinds] = useState<Set<ToolKind>>(new Set())
  const [fErr, setFErr] = useState(false)
  const [q, setQ] = useState('')

  const agents = useMemo(() => (weave ? [...new Set(weave.sessions.map((s) => s.agent))] : []), [weave])
  const filterOn = fAgents.size > 0 || fKinds.size > 0 || fErr || q.trim().length > 0

  const { fout, matches } = useMemo(() => {
    const out = new Set<string>()
    const hits: Station[] = []
    if (!net || !filterOn) return { fout: out, matches: hits }
    const t = q.trim().toLowerCase()
    const pass = (s: Station, agent: string): boolean => {
      if (fAgents.size && !fAgents.has(agent)) return false
      if (fErr && !(s.step.calls ?? []).some(callFailed)) return false
      if (fKinds.size) {
        const ks = new Set((s.step.calls ?? []).map((c) => toolKind(c.name)))
        if (s.step.actor === 'user') ks.add('other')
        if (![...fKinds].some((k) => ks.has(k))) return false
      }
      if (t && !stepText(s.step).toLowerCase().includes(t) && !s.name.toLowerCase().includes(t)) return false
      return true
    }
    for (const c of net.corridors)
      for (const l of c.lines)
        for (const s of l.stations) {
          if (pass(s, c.session.agent)) hits.push(s)
          else out.add(s.id)
        }
    return { fout: out, matches: hits }
  }, [net, filterOn, fAgents, fKinds, fErr, q])

  // Enter in the search field cycles straight through the matching knots
  const matchCycle = useRef(0)
  const cycleMatch = useCallback(() => {
    if (!matches.length) return
    const s = matches[matchCycle.current % matches.length]!
    matchCycle.current++
    jump(s.id)
  }, [matches])

  // first run: hanging-tag guide, three learn-by-doing steps — the first
  // tag hangs once the opening dive has landed, so it owns the frame
  useEffect(() => {
    if (!net || localStorage.getItem('traza.guide')) return
    const t = setTimeout(() => setGuide(1), 3000)
    return () => clearTimeout(t)
  }, [net])

  // a new network re-runs the opening beat — chrome waits for the dive;
  // the fallback covers paths where no flight ever fires
  useEffect(() => {
    if (!net) return
    setLanded(false)
    const t = setTimeout(() => setLanded(true), 4600)
    return () => clearTimeout(t)
  }, [net])

  // each guide step anchors to the real thing it teaches — a station's
  // screen position, or the play button's rect for the ride step
  const [gpos, setGpos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!guide || !net) {
      setGpos(null)
      return
    }
    if (guide === 3) {
      const track = () => {
        const r = document.querySelector('.dock .play')?.getBoundingClientRect()
        if (r)
          setGpos((prev) =>
            prev && Math.abs(prev.x - (r.left + r.width / 2)) < 0.5 && Math.abs(prev.y - r.top) < 0.5
              ? prev
              : { x: r.left + r.width / 2, y: r.top },
          )
      }
      let raf = requestAnimationFrame(function loop() {
        track()
        raf = requestAnimationFrame(loop)
      })
      return () => cancelAnimationFrame(raf)
    }
    const ix =
      guide === 2
        ? net.corridors[0]?.lines.flatMap((l) => l.stations).find((s) => s.tier === 'interchange')
        : net.corridors[0]?.lines.find((l) => l.trunk)?.stations.find((s) => s.tier !== 'local') ??
          net.corridors[0]?.lines.find((l) => l.trunk)?.stations[0]
    if (!ix) {
      setGpos(null)
      return
    }
    if (guide === 2) {
      map.current?.flyTo(ix.x, ix.y - 60, 640, 400)
    }
    const tick = () => {
      const p = map.current?.screenPos(ix.id)
      if (p)
        setGpos((prev) => (prev && Math.abs(prev.x - p.px) < 0.5 && Math.abs(prev.y - p.py) < 0.5 ? prev : { x: p.px, y: p.py }))
    }
    let raf = requestAnimationFrame(function loop() {
      tick()
      raf = requestAnimationFrame(loop)
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide, net])

  const guideDone = () => {
    setGuide(0)
    localStorage.setItem('traza.guide', '1')
  }

  // ghost shuttle — after 20 idle seconds a dim weft drifts the warp
  const lastAct = useRef(performance.now())
  useEffect(() => {
    const bump = () => {
      lastAct.current = performance.now()
    }
    for (const ev of ['pointerdown', 'wheel', 'keydown']) addEventListener(ev, bump, { passive: true })
    return () => {
      for (const ev of ['pointerdown', 'wheel', 'keydown']) removeEventListener(ev, bump)
    }
  }, [])

  useEffect(() => {
    if (!net || reduced) return
    const trunk = net.corridors[0]?.lines.find((l) => l.trunk)
    const pts = trunk?.segs[0]?.pts
    if (!pts || pts.length < 2 || !trunk) return
    const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y))
    const total = lens.reduce((a, b) => a + b, 0)
    if (!total) return

    let running = false
    let raf = 0
    let d = 0
    let dir = 1
    let last = 0
    const at = (dist: number) => {
      let left = dist
      for (let i = 0; i < lens.length; i++) {
        const l = lens[i]!
        if (left <= l || i === lens.length - 1) {
          const a = pts[i]!
          const b = pts[i + 1]!
          const t = l ? Math.min(1, left / l) : 1
          return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI }
        }
        left -= l
      }
      return { ...pts[0]!, angle: 0 }
    }
    const paint = (now: number) => {
      if (!running) return
      if (!last) last = now
      d += (dir * 68 * (now - last)) / 1000
      last = now
      if (d >= total) (d = total), (dir = -1)
      else if (d <= 0) (d = 0), (dir = 1)
      const p = at(d)
      map.current?.setGhost(p.x, p.y, dir > 0 ? p.angle : p.angle + 180, true, trunk.color)
      raf = requestAnimationFrame(paint)
    }
    const stop = () => {
      if (!running) return
      running = false
      cancelAnimationFrame(raf)
      map.current?.setGhost(0, 0, 0, false)
    }
    const poke = () => {
      lastAct.current = performance.now()
      stop()
    }
    const iv = setInterval(() => {
      if (document.hidden) return
      if (!running && !playing && performance.now() - lastAct.current > 20000) {
        running = true
        last = 0
        raf = requestAnimationFrame(paint)
      }
    }, 1000)
    for (const ev of ['pointerdown', 'wheel', 'keydown']) addEventListener(ev, poke, { passive: true })
    return () => {
      clearInterval(iv)
      stop()
      for (const ev of ['pointerdown', 'wheel', 'keydown']) removeEventListener(ev, poke)
    }
  }, [net, reduced, playing])

  // reset ride when the network or service changes
  useEffect(() => {
    rideRef.current = { leg: 0, dist: 0, dwell: 0 }
    switchFired.current.clear()
    setPlaying(false)
    setRideUi(
      ride && ride.stops.length > 1
        ? { stop: 1, total: ride.stops.length, name: ride.stops[0]!.name, next: ride.stops[1]!.name, clock: rideClock(0) }
        : null,
    )
    map.current?.setTrain(0, 0, 0, false)
  }, [ride])

  useEffect(() => {
    if (!playing || !ride?.legs.length) return
    let raf = 0
    let last = performance.now()
    let legBudget = 0 // ms of travel time the current leg earned under the pace
    const tick = (now: number) => {
      const dt = Math.min(64, now - last)
      last = now
      const rp = rideRef.current
      if (seekRef.current !== null) {
        raf = requestAnimationFrame(tick)
        return
      }
      const leg = ride.legs[rp.leg]
      if (!leg) {
        raf = requestAnimationFrame(tick)
        return
      }
      if (rp.dwell > 0) {
        rp.dwell -= dt * speed
        raf = requestAnimationFrame(tick)
        return
      }
      if (legBudget <= 0) legBudget = legMs(rp.leg)
      if (reduced) {
        rp.dist = leg.len
      } else {
        rp.dist += (leg.len / legBudget) * dt
      }
      leg.switches.forEach((sw, si) => {
        const key = `${rp.leg}:${si}`
        if (switchFired.current.has(key)) return
        const p = legPoint(leg, Math.min(rp.dist, leg.len))
        if (Math.hypot(p.x - sw.x, p.y - sw.y) < 16) {
          switchFired.current.add(key)
          map.current?.switchThrow(sw.x, sw.y)
          haptic('buzz')
        }
      })
      if (rp.dist >= leg.len) {
        const end = legPoint(leg, leg.len)
        rp.leg += 1
        rp.dist = 0
        legBudget = 0
        const arrived = leg.stop
        rp.dwell = dwellFor(arrived.id)
        const rawGap = (times[rp.leg] ?? 0) - (times[rp.leg - 1] ?? 0)
        setSel(arrived.id)
        setRideUi({
          stop: rp.leg + 1,
          total: ride.stops.length,
          name: arrived.name,
          next: ride.legs[rp.leg]?.stop.name ?? 'end of the weft',
          clock: rideClock(rp.leg),
          idle: pace === 'real' && rawGap > REAL_FOLD ? `…idle ${fmtDur(rawGap)} folded` : undefined,
        })
        map.current?.setTrain(arrived.x, arrived.y, end.angle, true, lineColorOf(net, arrived.lineId))
        if (followRef.current) map.current?.keepInView(arrived.x, arrived.y)
        if (rp.leg >= ride.legs.length) {
          map.current?.terminusGlow(ride.corridorIdx)
          setRideUi({
            stop: ride.stops.length,
            total: ride.stops.length,
            name: 'end of the weft — all change',
            next: `${arrived.name} · ${fmtK(fares[fares.length - 1] ?? 0)} tok`,
            clock: rideClock(ride.stops.length - 1),
          })
          haptic('success')
          setTimeout(() => setPlaying(false), reduced ? 60 : 1700)
          return
        }
      } else {
        const p = legPoint(leg, rp.dist)
        map.current?.setTrain(p.x, p.y, p.angle, true, lineColorOf(net, leg.stop.lineId))
        if (followRef.current) map.current?.keepInView(p.x, p.y)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, ride, speed, reduced, net, pace])

  const placeTrainAt = useCallback(
    (k: number) => {
      if (!ride) return
      const stop = ride.stops[k]!
      const prev = ride.legs[k - 1]
      const heading = prev ? legPoint(prev, prev.len).angle : 0
      map.current?.setTrain(stop.x, stop.y, heading, true, lineColorOf(net, stop.lineId))
    },
    [ride, net],
  )

  // express seek — the shuttle fast-travels the real thread to the target:
  // forward through each leg, backward by rewinding. Nothing teleports.
  useEffect(() => {
    if (seeking === null || !ride || !ride.stops.length) return
    const rp = rideRef.current
    rp.dwell = 0
    const RATE = 2400
    let last = performance.now()
    let lastLeg = -1
    let raf = requestAnimationFrame(function step(now: number) {
      const dt = Math.min(64, now - last)
      last = now
      const target = seekRef.current
      if (target === null) return
      const px = (RATE * dt) / 1000
      if (rp.leg > target) {
        rp.dist -= px
        while (rp.dist <= 0 && rp.leg > target) {
          rp.leg -= 1
          rp.dist = ride.legs[rp.leg]?.len ?? 0
        }
      } else if (rp.leg < target) {
        rp.dist += px
        while (rp.dist >= (ride.legs[rp.leg]?.len ?? 0) && rp.leg < target) {
          rp.dist -= ride.legs[rp.leg]!.len
          rp.leg += 1
        }
      }
      if (rp.leg === target) {
        rp.dist = 0
        rp.dwell = 0
        const stop = ride.stops[target]!
        setSel(stop.id)
        if (target >= ride.legs.length) {
          map.current?.terminusGlow(ride.corridorIdx)
          setRideUi({
            stop: ride.stops.length,
            total: ride.stops.length,
            name: 'end of the weft — all change',
            next: `${stop.name} · ${fmtK(fares[fares.length - 1] ?? 0)} tok`,
            clock: rideClock(ride.stops.length - 1),
          })
          haptic('success')
          setTimeout(() => setPlaying(false), reduced ? 60 : 1700)
        } else {
          setRideUi({
            stop: target + 1,
            total: ride.stops.length,
            name: stop.name,
            next: ride.stops[target + 1]?.name ?? 'end of the weft',
            clock: rideClock(target),
          })
        }
        placeTrainAt(target)
        if (followRef.current) map.current?.keepInView(stop.x, stop.y)
        seekRef.current = null
        setSeeking(null)
        return
      }
      const leg = ride.legs[rp.leg]
      if (leg) {
        const p = legPoint(leg, Math.max(0, Math.min(rp.dist, leg.len)))
        map.current?.setTrain(p.x, p.y, p.angle, true, lineColorOf(net, leg.stop.lineId))
        if (followRef.current) map.current?.keepInView(p.x, p.y)
        leg.switches.forEach((sw) => {
          if (Math.hypot(p.x - sw.x, p.y - sw.y) < 16) map.current?.switchThrow(sw.x, sw.y)
        })
      }
      if (rp.leg !== lastLeg) {
        lastLeg = rp.leg
        setRideUi({
          stop: rp.leg + 1,
          total: ride.stops.length,
          name: ride.stops[rp.leg]?.name ?? '',
          next: ride.stops[rp.leg + 1]?.name ?? 'end of the weft',
          clock: rideClock(rp.leg),
        })
      }
      raf = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeking, ride, net])

  const rideTo = useCallback(
    (stopIdx: number) => {
      if (!ride || !ride.stops.length) return
      const k = Math.max(0, Math.min(ride.stops.length - 1, stopIdx))
      switchFired.current.clear()
      setFollowOn(true)
      haptic('nudge')
      if (reduced) {
        rideRef.current = { leg: Math.min(k, ride.legs.length - 1), dist: 0, dwell: 0 }
        seekRef.current = null
        setSeeking(null)
        const stop = ride.stops[k]!
        setSel(stop.id)
        setRideUi({ stop: k + 1, total: ride.stops.length, name: stop.name, next: ride.stops[k + 1]?.name ?? 'end of the weft', clock: rideClock(k) })
        placeTrainAt(k)
        map.current?.flyTo(stop.x, stop.y, 700, 420)
        return
      }
      seekRef.current = k
      setSeeking(k)
    },
    [ride, net, reduced, placeTrainAt],
  )

  // j/k — step the replay by turn, not by knot
  const stepTurn = useCallback(
    (dir: 1 | -1) => {
      if (!ride || !rideUi) return
      const cur = rideUi.stop - 1
      const curKey = turnKeyAt(cur)
      if (dir > 0) {
        for (let i = cur + 1; i < ride.stops.length; i++)
          if (turnKeyAt(i) !== curKey) return rideTo(i)
        return rideTo(ride.stops.length - 1)
      }
      // backward: find the turn before the one we're in, land on its first knot
      let prevKey = ''
      for (let i = cur - 1; i >= 0; i--) {
        const k = turnKeyAt(i)
        if (k !== curKey) {
          prevKey = k
          for (let j = i; j >= 0; j--) {
            if (turnKeyAt(j) !== prevKey) return rideTo(j + 1)
          }
          return rideTo(0)
        }
      }
      rideTo(0)
    },
    [ride, rideUi, turnKeyAt, rideTo],
  )

  const load = useCallback(async (dropped: DroppedFile[], staged = true) => {
    if (!dropped.length) {
      setStatus('empty')
      setBusy(null)
      return
    }
    if (staged) setBusy(`surveying ${dropped.length} file${dropped.length === 1 ? '' : 's'}…`)
    await new Promise((r) => setTimeout(r, staged ? 60 : 0))
    const w = ingest(dropped)
    setFiles(dropped)
    setWeave(w)
    setSel(null)
    if (staged) {
      setBusy('laying the warp…')
      await new Promise((r) => setTimeout(r, 140))
    }
    setBusy(null)
    setStatus(w.sessions.length ? 'ready' : 'lineclosed')
  }, [])

  // test hook: live-check/perf scripts inject files without simulating drops
  useEffect(() => {
    if (new URLSearchParams(location.search).has('test')) {
      ;(window as unknown as { __trazaLoad?: typeof load }).__trazaLoad = load
    }
  }, [load])

  // first visit: open on the demo weave so the first thing seen is cloth
  useEffect(() => {
    loadDemo()
      .then((d) => load(d, false))
      .catch(() => {
        setBusy(null)
        setStatus('empty')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // drop anywhere
  useEffect(() => {
    const over = (e: DragEvent) => {
      e.preventDefault()
      setDragOver(true)
    }
    const leave = (e: DragEvent) => {
      if (e.relatedTarget == null) setDragOver(false)
    }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      if (e.dataTransfer) filesFromDrop(e.dataTransfer).then(load)
    }
    addEventListener('dragover', over)
    addEventListener('dragleave', leave)
    addEventListener('drop', drop)
    return () => {
      removeEventListener('dragover', over)
      removeEventListener('dragleave', leave)
      removeEventListener('drop', drop)
    }
  }, [load])

  const jump = useCallback(
    (stationId: string) => {
      const hit = stationOf.get(stationId)
      if (!hit || !net) return
      setSel(stationId)
      map.current?.flyTo(hit.s.x, hit.s.y, 900, 500)
    },
    [stationOf, net],
  )

  const stepAlong = useCallback(
    (dir: 1 | -1) => {
      if (!net) return
      if (!sel || !stationOf.has(sel)) {
        const first = net.corridors[0]?.lines[0]?.stations[0]
        if (first) jump(first.id)
        return
      }
      const { s } = stationOf.get(sel)!
      const line = net.corridors.flatMap((c) => c.lines).find((l) => l.id === s.lineId)
      const next = line?.stations[s.ord + dir]
      if (next) jump(next.id)
    },
    [net, sel, stationOf, jump],
  )

  const switchLine = useCallback(
    (dir: 1 | -1) => {
      if (!net || !sel) return
      const hit = stationOf.get(sel)
      if (!hit) return
      const c = net.corridors[hit.corridorIdx]!
      const cur = c.lines[hit.lineIdx]!
      if (dir > 0) {
        const child = c.lines.find((l) => l.forkStation?.stationId === sel)
        if (child?.stations[0]) return jump(child.stations[0].id)
      } else if (cur.forkStation) {
        const parent = c.lines.find((l) => l.id === cur.forkStation!.lineId)
        const st = parent?.stations.find((x) => x.id === cur.forkStation!.stationId)
        if (st) return jump(st.id)
      }
      const near = c.lines[hit.lineIdx + dir]
      if (near) {
        const best = near.stations.reduce((a, b) => (Math.abs(b.x - hit.s.x) < Math.abs(a.x - hit.s.x) ? b : a))
        jump(best.id)
      }
    },
    [net, sel, stationOf, jump],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const k = e.key
      if ((tag === 'BUTTON' || tag === 'A') && (k === ' ' || k === 'Enter')) return
      if (k === 'ArrowLeft') (e.preventDefault(), stepAlong(-1))
      else if (k === 'ArrowRight') (e.preventDefault(), stepAlong(1))
      else if (k === 'ArrowDown') (e.preventDefault(), switchLine(1))
      else if (k === 'ArrowUp') (e.preventDefault(), switchLine(-1))
      else if (k === 'j') stepTurn(1)
      else if (k === 'k') stepTurn(-1)
      else if (k === 'w') setFallOpen((v) => !v)
      else if (k === 'Escape') (setSel(null), setFinder(false), setPickOpen(false))
      else if (k === 'f' || k === '0') map.current?.fit()
      else if (k === '+' || k === '=') map.current?.zoomBy(1.5)
      else if (k === '-') map.current?.zoomBy(1 / 1.5)
      else if (k === 'o') filePick.current?.click()
      else if (k === '/') (e.preventDefault(), setFinder(true))
      else if (k === ' ') {
        e.preventDefault()
        if (ride?.legs.length) {
          if (!playing && rideRef.current.leg >= ride.legs.length) rideTo(0)
          setPlaying((p) => !p)
        }
        if (guide) guideDone()
      } else if (k === '[' && ride && rideUi) rideTo(rideUi.stop - 2)
      else if (k === ']' && ride && rideUi) rideTo(rideUi.stop)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [stepAlong, switchLine, stepTurn, ride, rideUi, rideTo, playing, guide])

  // the pick card folds when you click anywhere off it
  useEffect(() => {
    if (!pickOpen) return
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement
      if (!el.closest('.fbar') && !el.closest('.pickbtn')) setPickOpen(false)
    }
    addEventListener('pointerdown', onDown)
    return () => removeEventListener('pointerdown', onDown)
  }, [pickOpen])

  const stats = weave?.stats
  const demoLoaded = files.some((f) => f.path.startsWith('demo/'))
  const curCorridor = net && ride ? net.corridors[ride.corridorIdx] : undefined
  const KINDS: ToolKind[] = ['edit', 'exec', 'read', 'web', 'mcp']

  return (
    <main
      ref={mainRef}
      className={`stage${net ? ' hasnet' : ''}${playing ? ' lamp' : ''}${sel ? ' selopen' : ''}${net && !landed ? ' boot' : ''}`}
    >
      {/* the loom's header bar — brand, one tab per session strand, the
          search that filters the cloth, and the audit tools */}
      <header className="top">
        <div className="brand">
          <span className="mark">~</span>
          <span className="word">trenza</span>
          <span className="sub">agent sessions, woven</span>
        </div>
        {net && (
          <nav className="strands" aria-label="sessions">
            {net.corridors.map((c, i) => {
              const trunk = c.lines.find((l) => l.trunk)
              return (
                <button
                  key={c.session.id}
                  className={`stab${svcIdx === i ? ' on' : ''}`}
                  title={`${c.session.title} — ${c.session.agent}`}
                  onClick={() => {
                    setSvcIdx(i)
                    const xs = c.lines.flatMap((l) => l.segs.flatMap((s) => s.pts.map((p) => p.x)))
                    if (xs.length)
                      map.current?.flyTo(
                        (Math.min(...xs) + Math.max(...xs)) / 2,
                        c.trunkY + c.height / 2,
                        Math.max(...xs) - Math.min(...xs) + 200,
                        c.height + 200,
                      )
                  }}
                >
                  <i className="sdot" style={{ background: trunk?.color }} />
                  {c.session.title}
                </button>
              )
            })}
          </nav>
        )}
        {net && (
          <div className="tsearch">
            <span className="tic">⌕</span>
            <input
              value={q}
              placeholder="search the weave…"
              aria-label="search steps — text, tools, output"
              onChange={(e) => {
                setQ(e.target.value)
                matchCycle.current = 0
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') cycleMatch()
                else if (e.key === 'Escape') setQ('')
              }}
            />
            {q.trim() && <span className="tcount">{matches.length}</span>}
          </div>
        )}
        {net && (
          <div className="tstats">
            <b>{net.corridors.length}</b> session{net.corridors.length === 1 ? '' : 's'}
            <span className="sep">·</span>
            <b>{net.stats.stations}</b> knots
            <span className="sep">·</span>
            <b>{stats?.calls ?? 0}</b> calls
            {stats?.redactions ? (
              <>
                <span className="sep">·</span>
                <span className="hot">{stats.redactions} scrubbed</span>
              </>
            ) : null}
          </div>
        )}
        <div className="tacts">
          {net && (
            <button
              className={`hbtn pickbtn${pickOpen || filterOn ? ' on' : ''}`}
              aria-expanded={pickOpen}
              title="pick — filter strands by agent, tool kind, errors"
              onClick={() => setPickOpen((v) => !v)}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                <path d="M2 4h12M4.5 8h7M7 12h2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              pick{filterOn ? ` ${matches.length}` : ''}
            </button>
          )}
          {net && curCorridor && (
            <button
              className={`hbtn${fallOpen ? ' on' : ''}`}
              aria-pressed={fallOpen}
              title="time on the loom — duration waterfall (w)"
              onClick={() => setFallOpen((v) => !v)}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                <rect x="1.5" y="2" width="9" height="3" rx="1.5" fill="currentColor" />
                <rect x="4" y="6.5" width="10.5" height="3" rx="1.5" fill="currentColor" opacity={0.75} />
                <rect x="7" y="11" width="6" height="3" rx="1.5" fill="currentColor" opacity={0.5} />
              </svg>
              falls
            </button>
          )}
          <button
            className="hbtn"
            aria-label="open your export"
            title="open your exported agent sessions (o)"
            onClick={() => filePick.current?.click()}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
              <path d="M8 11V2M5 5l3-3 3 3M2.5 11v2.5h11V11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            open
          </button>
          <button className="hbtn" aria-label="find a knot ( / )" title="find a knot" onClick={() => setFinder(true)}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
              <circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button className="hbtn" aria-label="fit the whole weave ( f )" title="fit the whole weave" onClick={() => map.current?.fit()}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
              <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </header>

      {/* the pick — a filter card that folds away; nonmatching knots
          fade to warp-shadows while it's on */}
      {net && pickOpen && (
        <div className="fbar" role="toolbar" aria-label="filter the weave">
          <span className="flabel">pick</span>
          {agents.map((a) => (
            <button
              key={a}
              className={`ftog${fAgents.size && !fAgents.has(a) ? ' off' : ''}`}
              aria-pressed={!fAgents.size || fAgents.has(a)}
              onClick={() =>
                setFAgents((prev) => {
                  const n = new Set(prev)
                  if (n.has(a)) n.delete(a)
                  else n.add(a)
                  // selecting any agents while the set was empty = only that agent
                  return prev.size === 0 ? new Set([a]) : n.size === agents.length ? new Set() : n
                })
              }
            >
              <i className="fdot" style={{ background: agentColor(a) }} />
              {a}
            </button>
          ))}
          <span className="fsep" />
          {KINDS.map((k) => (
            <button
              key={k}
              className={`ftog${fKinds.has(k) ? ' on-hot' : ''}`}
              aria-pressed={fKinds.has(k)}
              onClick={() =>
                setFKinds((prev) => {
                  const n = new Set(prev)
                  if (n.has(k)) n.delete(k)
                  else n.add(k)
                  return n
                })
              }
            >
              {k}
            </button>
          ))}
          <span className="fsep" />
          <button className={`ftog${fErr ? ' on-hot' : ''}`} aria-pressed={fErr} onClick={() => setFErr(!fErr)}>
            errors only
          </button>
          {filterOn && (
            <>
              <span className="fmatch">
                <b>{matches.length}</b> of {net.stats.stations} lit
              </span>
              <button
                className="fclear"
                onClick={() => {
                  setFAgents(new Set())
                  setFKinds(new Set())
                  setFErr(false)
                  setQ('')
                }}
              >
                clear
              </button>
            </>
          )}
        </div>
      )}

      {/* the cloth */}
      <div className="cloth">
        {net && (
          <MapView
            ref={map}
            net={net}
            sel={sel}
            onPick={(id) => {
              setSel(id)
              if (id && innerWidth <= 720) setKeyOpen(false)
              if (guide === 2 || guide === 1) setGuide(3)
            }}
            onPickWorks={(w: Works) => {
              setSel(w.id)
              if (innerWidth <= 720) setKeyOpen(false)
              if (guide === 2 || guide === 1) setGuide(3)
            }}
            riding={playing}
            solo={solo ?? (playing && ride ? ride.corridorIdx : null)}
            tethers={tethers}
            rideLabel={playing ? rideUi?.name : null}
            fout={filterOn ? fout : undefined}
            onUserPan={() => guide === 1 && setGuide(2)}
            onUserGesture={() => setFollowOn(false)}
            onArrive={() => setLanded(true)}
          />
        )}

        {/* wordmark lives inside the cloth (the signature patch) — the DOM
            only carries it for assistive tech and document title semantics */}
        <h1 className="sr">trenza — agent sessions, woven</h1>

        {/* follow suspended by a gesture — a small way back onto the shuttle */}
        {playing && !follow && (
          <button className="followpill" onClick={() => setFollowOn(true)}>
            follow the shuttle ▸
          </button>
        )}

        {/* pattern card — session legend, bottom left */}
        {net && (
          <section className={keyOpen && landed && (guide !== 1 || keyPinned) ? 'key' : 'key shut'} aria-label="pattern card">
            <button
              className="keyhead"
              onClick={() => {
                if (keyOpen && landed && (guide !== 1 || keyPinned)) setKeyOpen(false)
                else {
                  setKeyOpen(true)
                  setKeyPinned(true)
                }
              }}
            >
              <b>pattern</b>
              <span>
                {net.stats.stations} knots · {net.stats.lines} strands{net.stats.works ? ` · ${net.stats.works} frays` : ''}
              </span>
              <i>{keyOpen && landed && (guide !== 1 || keyPinned) ? '▾' : '▴'}</i>
            </button>
            {keyOpen && landed && (guide !== 1 || keyPinned) && (
              <div className="keybody">
                {net.corridors.map((c, i) => {
                  const trunk = c.lines.find((l) => l.trunk)
                  const branchN = c.lines.length - 1
                  return (
                    <button
                      key={c.session.id}
                      className="svc"
                      onPointerEnter={() => setSolo(i)}
                      onPointerLeave={() => setSolo(null)}
                      onClick={() => {
                        if (!trunk) return
                        const xs = c.lines.flatMap((l) => l.segs.flatMap((s) => s.pts.map((p) => p.x)))
                        map.current?.flyTo(
                          (Math.min(...xs) + Math.max(...xs)) / 2,
                          c.trunkY + c.height / 2,
                          Math.max(...xs) - Math.min(...xs) + 200,
                          c.height + 200,
                        )
                      }}
                    >
                      <i className="svcchip" style={{ background: trunk?.color }}>
                        S{i + 1}
                      </i>
                      <span className="svcname">{c.session.title}</span>
                      <span className="svcmeta">
                        {c.session.agent} · {trunk?.stations.length ?? 0} knots{branchN ? ` · ${branchN} strand${branchN === 1 ? '' : 's'}` : ''}
                      </span>
                    </button>
                  )
                })}
                <button className="keyrow" onClick={() => setSrcOpen(!srcOpen)}>
                  <b>sources</b>
                  <span>
                    {weave?.files.length} files{stats?.redactions ? ` · ${stats.redactions} secrets scrubbed` : ''}
                  </span>
                  <i>{srcOpen ? '▾' : '▸'}</i>
                </button>
                {srcOpen && (
                  <ul className="srclist">
                    {weave?.files.map((f) => (
                      <li key={f.path} className={f.ok ? '' : 'bad'}>
                        <code>{f.path.replace(/^demo\//, '')}</code>
                        <span>{f.ok ? f.format : f.note ?? 'unread'}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="keyfoot">
                  <button onClick={() => dirPick.current?.click()}>open folder</button>
                  <button onClick={() => filePick.current?.click()}>open files</button>
                  <button aria-label="replay the tour" title="replay the tour" onClick={() => setGuide(1)}>
                    ?
                  </button>
                  <button
                    className={hap ? 'haptoggle on' : 'haptoggle'}
                    aria-pressed={hap}
                    title={hap ? 'haptics on' : 'haptics off'}
                    onClick={() => {
                      const v = !hap
                      setHap(v)
                      setHaptics(v)
                      if (v) haptic('success')
                    }}
                  >
                    buzz {hap ? 'on' : 'off'}
                  </button>
                  {demoLoaded ? (
                    <span className="demopill">demo export</span>
                  ) : (
                    <button onClick={() => loadDemo().then((d) => load(d))}>demo</button>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {/* the shuttle dock — pace, transport, the time-loom scrubber */}
        {net && ride && ride.stops.length > 1 && rideUi && (
          <section ref={dockRef} className="dock" aria-label="replay controls">
            {/* row one of the beam: the wall-clock loomline */}
            <LoomLine
              pos={eff}
              stop={rideUi.stop}
              total={rideUi.total}
              ride={ride}
              times={times}
              stationOf={stationOf}
              net={net}
              onSeek={rideTo}
            />
            <div className="paces" role="group" aria-label="replay pace">
              {(['tour', 'study', 'real'] as Pace[]).map((p) => (
                <button
                  key={p}
                  className={pace === p ? 'on' : ''}
                  title={
                    p === 'tour'
                      ? 'tour — glide the whole weave at a glance'
                      : p === 'study'
                        ? 'study — dwell on each turn, inspector follows'
                        : 'real — wall-clock time, scaled 60×, gaps folded'
                  }
                  onClick={() => setPace(p)}
                >
                  {p}
                </button>
              ))}
            </div>
            <div className="svcpick">
              <button aria-label="previous session" onClick={() => setSvcIdx((i) => (i - 1 + net.corridors.length) % net.corridors.length)}>
                ‹
              </button>
              <i className="svcchip" style={{ background: curCorridor?.lines.find((l) => l.trunk)?.color }}>
                S{ride.corridorIdx + 1}
              </i>
              <button aria-label="next session" onClick={() => setSvcIdx((i) => (i + 1) % net.corridors.length)}>
                ›
              </button>
            </div>
            <div className="transport">
              <button className="skip" aria-label="previous turn (k)" onClick={() => stepTurn(-1)} disabled={rideUi.stop <= 1}>
                |◀
              </button>
              <button
                className={`play${playing ? ' on' : ''}${guide === 3 ? ' nudge' : ''}`}
                onClick={() => {
                  if (!playing && rideRef.current.leg >= ride.legs.length) rideTo(0)
                  if (!playing && !reduced) rideRef.current.dwell = 480
                  setFollowOn(true)
                  setPlaying(!playing)
                  if (guide) guideDone()
                }}
                aria-label={playing ? 'pause the replay' : 'run the replay'}
              >
                {playing ? '❚❚' : '▶'}
              </button>
              <button className="skip" aria-label="next turn (j)" onClick={() => stepTurn(1)} disabled={rideUi.stop >= rideUi.total}>
                ▶|
              </button>
            </div>
            <div className="rideinfo">
              <div className="led">
                <span className="led-tag">{rideUi.stop >= rideUi.total ? 'selvedge' : 'next'}</span>
                <MorphText text={rideUi.next} />
              </div>
              <div className="ridesub">
                {rideUi.name} · {rideUi.stop}/{rideUi.total}
                {rideUi.clock ? ` · ${rideUi.clock}` : ''}
                {rideUi.idle ? ` · ${rideUi.idle}` : ''}
              </div>
            </div>
            <div className="fare" title="tokens spent so far on this session">
              <FareMeter value={fares[rideUi.stop - 1] ?? 0} reduced={reduced} />
              <span>tok</span>
            </div>
            <div className="speeds">
              {[1, 2, 4].map((s) => (
                <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>
                  {s}×
                </button>
              ))}
            </div>
            <button className="speedcycle" aria-label={`replay speed ${speed}× — tap to change`} onClick={() => setSpeed((s) => (s === 1 ? 2 : s === 2 ? 4 : 1))}>
              {speed}×
            </button>
          </section>
        )}

        {/* time on the loom — the waterfall drawer */}
        {fallOpen && net && curCorridor && (
          <Waterfall
            corridor={curCorridor}
            sel={sel}
            playhead={rideUi ? (times[Math.max(0, rideUi.stop - 1)] ?? null) : null}
            onPick={(id) => {
              jump(id)
              if (innerWidth <= 720) setFallOpen(false)
            }}
            onClose={() => setFallOpen(false)}
          />
        )}

        {net && <Inspector net={net} sel={sel} onClose={() => setSel(null)} onJump={jump} onPrevNext={stepAlong} />}
      </div>

      {finder && net && (
        <Finder
          net={net}
          onGo={(s) => {
            setSel(s.id)
            map.current?.flyTo(s.x, s.y, 700, 420)
          }}
          onClose={() => setFinder(false)}
        />
      )}

      {/* first-run guide — hanging tags, each pinned above the thing it
          teaches. The replay supersedes it. */}
      {guide > 0 && !playing && (
        <div
          className={`gsign g${guide}`}
          role="note"
          style={{ top: gpos ? Math.max(60, Math.min(innerHeight - 220, gpos.y - 34)) : '30%' }}
        >
          {/* thread runs from the label's right edge to the subject */}
          {gpos &&
            (() => {
              const sy = Math.max(60, Math.min(innerHeight - 220, gpos.y - 34)) + 30
              const dx = gpos.x - 240
              const dy = gpos.y - sy
              const len = Math.hypot(dx, dy)
              if (dx < 26 || len < 30) return null
              return (
                <span
                  className="gthread"
                  style={{ ['--gl' as string]: `${Math.max(0, len - 10)}px`, ['--ga' as string]: `${(Math.atan2(dy, dx) * 180) / Math.PI}deg` }}
                />
              )
            })()}
          <div className="sign">
            <b>{guide === 1 ? 'every knot is a step the agent took' : guide === 2 ? 'a strand unthreads here — a subagent ran alongside' : 'run the shuttle'}</b>
            <p>
              {guide === 1
                ? 'drag the cloth to look around'
                : guide === 2
                  ? 'click the twist knot to meet the sidekick'
                  : 'press play — study pace dwells on each turn so you can read'}
            </p>
            <div className="gsteps">
              <span>step {guide} of 3</span>
              <button onClick={guideDone}>skip the tour</button>
            </div>
          </div>
        </div>
      )}

      {busy && (
        <div className="veil">
          <div className="plaque">
            <span className="pulse" />
            <p>{busy}</p>
          </div>
        </div>
      )}

      {dragOver && (
        <div className="dropveil">
          <div className="dropplaque">
            <span className="bring" />
            <b>drop the export on the loom</b>
            <p>nodes.jsonl · rollout-*.jsonl · messages.jsonl · ATIF</p>
          </div>
        </div>
      )}

      {status === 'empty' && !busy && (
        <div className="veil">
          <div className="plaque empty">
            <GhostBraid />
            <h2>the loom is bare</h2>
            <p>Drop an agent session export — a folder or loose jsonl files — and trenza weaves it into cloth.</p>
            <div className="actions">
              <button onClick={() => dirPick.current?.click()}>open a folder</button>
              <button onClick={() => filePick.current?.click()}>open files</button>
              <button className="ghost" onClick={() => loadDemo().then((d) => load(d))}>weave the demo</button>
            </div>
          </div>
        </div>
      )}

      {status === 'lineclosed' && !busy && (
        <div className="veil">
          <div className="plaque empty">
            <span className="closedbadge">no thread found</span>
            <h2>nothing here looks like a session</h2>
            <p>
              {files.length} file{files.length === 1 ? '' : 's'} surveyed — the sniffers found no devin nodes, codex rollouts,
              cursor messages or ATIF traces in them.
            </p>
            <ul className="srclist inline">
              {weave?.files.slice(0, 6).map((f) => (
                <li key={f.path} className="bad">
                  <code>{f.path}</code>
                  <span>{f.note ?? f.format}</span>
                </li>
              ))}
            </ul>
            <div className="actions">
              <button onClick={() => dirPick.current?.click()}>try another folder</button>
              <button className="ghost" onClick={() => loadDemo().then((d) => load(d))}>weave the demo</button>
            </div>
          </div>
        </div>
      )}

      <input ref={filePick} type="file" multiple hidden onChange={(e) => filesFromInput(e.target.files).then(load)} />
      <input
        ref={dirPick}
        type="file"
        // @ts-expect-error nonstandard but universal
        webkitdirectory=""
        hidden
        onChange={(e) => filesFromInput(e.target.files).then(load)}
      />
    </main>
  )
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
function fmtDur(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}
const AGENT_HEX: Record<string, string> = { devin: '#9a7ff0', codex: '#4fb083', cursor: '#6a9fe0', atif: '#d89a4a', unknown: '#a08b6c' }
function agentColor(a: string) {
  return AGENT_HEX[a] ?? '#a08b6c'
}

/** fare meter — counts up to the cumulative token spend, never remounts */
function FareMeter({ value, reduced }: { value: number; reduced: boolean }) {
  const [shown, setShown] = useState(value)
  const disp = useRef(value)
  useEffect(() => {
    const start = disp.current
    if (start === value || reduced) {
      disp.current = value
      setShown(value)
      return
    }
    const t0 = performance.now()
    const dur = Math.min(560, 160 + Math.abs(value - start) / 500)
    let raf = 0
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur)
      const v = Math.round(start + (value - start) * (1 - Math.pow(1 - p, 3)))
      disp.current = v
      setShown(v)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, reduced])
  return <b>{fmtK(shown)}</b>
}

/** a text fragment that slides its replacement in from the right */
function MorphText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLElement | null>(null)
  const prev = useRef(text)
  const anim = useRef<Animation | null>(null)
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const stop = () => {
      anim.current?.cancel()
      anim.current = null
    }
    mq.addEventListener('change', stop)
    return () => mq.removeEventListener('change', stop)
  }, [])
  useEffect(() => {
    if (prev.current === text) return
    prev.current = text
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    anim.current?.cancel()
    anim.current =
      ref.current?.animate(
        [
          { opacity: 0.15, transform: 'translateX(12px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' },
      ) ?? null
  }, [text])
  return (
    <b ref={ref} className={className}>
      {text}
    </b>
  )
}

/** the time loom — a scrubber laid on compressed wall-clock; turn starts are
    beads, user turns amber, failed turns hot. Drag anywhere to seek. */
function LoomLine({
  pos,
  stop,
  total,
  ride,
  times,
  stationOf,
  net,
  onSeek,
}: {
  pos: number[]
  stop: number
  total: number
  ride: Ride
  times: number[]
  stationOf: Map<string, { s: Station }>
  net: Network
  onSeek: (i: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<number | null>(null)
  const frac = pos.length ? (pos[Math.min(stop - 1, pos.length - 1)] ?? 0) : stop / total
  const idxAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    // nearest stop by compressed-time fraction
    let best = 0
    let bd = 1
    pos.forEach((p, i) => {
      const d = Math.abs(p - f)
      if (d < bd) {
        bd = d
        best = i
      }
    })
    return best
  }
  const beads = useMemo(() => {
    const lines = net.corridors.flatMap((c) => c.lines)
    const out: { i: number; f: number; cls: string }[] = []
    ride.stops.forEach((st, i) => {
      const s = stationOf.get(st.id)?.s
      if (!s?.turnStart) return
      const turn = s.turnIdx != null ? lines.find((l) => l.id === s.lineId)?.turns[s.turnIdx] : undefined
      out.push({ i, f: pos[i] ?? 0, cls: turn?.kind === 'user' ? 'user' : turn?.failed ? 'err' : '' })
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ride, pos, stationOf, net])
  const clock = preview != null ? times[preview] : times[Math.min(stop - 1, times.length - 1)]
  return (
    <div
      ref={ref}
      className="loomline"
      role="slider"
      aria-label="replay position — drag to scrub along real time"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={stop}
      tabIndex={0}
      onKeyDown={(e) => {
        const go = (i: number) => {
          e.preventDefault()
          e.stopPropagation()
          onSeek(i)
        }
        if (e.key === 'ArrowLeft') go(stop - 2)
        else if (e.key === 'ArrowRight') go(stop)
        else if (e.key === 'Home') go(-1)
        else if (e.key === 'End') go(total - 1)
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        const i = idxAt(e.clientX)
        setPreview(i)
        onSeek(i)
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        const i = idxAt(e.clientX)
        setPreview(i)
        onSeek(i)
      }}
      onPointerUp={() => setPreview(null)}
      onPointerCancel={() => setPreview(null)}
    >
      <div className="ltrack" />
      <div className="lfill" style={{ width: `${frac * 100}%` }} />
      {beads.map((b) => (
        <span key={b.i} className={`lturn ${b.cls}`} style={{ left: `${b.f * 100}%` }} />
      ))}
      <div className="lhead" style={{ left: `${(preview != null ? (pos[preview] ?? 0) : frac) * 100}%` }} />
      {clock != null && (
        <span className="lclock" style={{ left: `${Math.min(92, Math.max(8, (preview != null ? (pos[preview] ?? 0) : frac) * 100))}%` }}>
          {new Date(clock).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
    </div>
  )
}

/** "where to?" — finder over names, actors and tools. */
function Finder({ net, onGo, onClose }: { net: Network; onGo: (s: Station) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])

  const all = useMemo(() => {
    const out: { s: Station; svc: string; color: string }[] = []
    net.corridors.forEach((c, ci) => c.lines.forEach((l) => l.stations.forEach((s) => out.push({ s, svc: `S${ci + 1}`, color: l.color }))))
    return out
  }, [net])

  const hits = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return all.slice(0, 8)
    return all
      .filter(
        ({ s }) =>
          s.name.toLowerCase().includes(t) ||
          s.step.actor.includes(t) ||
          (s.step.calls ?? []).some((c) => c.name.toLowerCase().includes(t)),
      )
      .slice(0, 8)
  }, [all, q])

  return (
    <div className="finderwrap" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="finder" role="dialog" aria-label="where to">
        <div className="findhead">
          <input
            ref={inputRef}
            value={q}
            placeholder="a knot, a tool, an actor…"
            onChange={(e) => (setQ(e.target.value), setIdx(0))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') (e.preventDefault(), setIdx((i) => Math.min(hits.length - 1, i + 1)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)))
              else if (e.key === 'Enter' && hits[idx]) (onGo(hits[idx].s), onClose())
            }}
          />
        </div>
        <ul>
          {hits.map((h, i) => (
            <li key={h.s.id} className={i === idx ? 'sel' : ''} onPointerEnter={() => setIdx(i)} onClick={() => (onGo(h.s), onClose())}>
              <i className="fdot" style={{ background: h.color }} />
              <span className="fname">{stepTitle(h.s.step)}</span>
              <span className="fmeta">
                {h.svc} · {h.s.step.actor}
                {h.s.step.calls?.[0] ? ` · ${h.s.step.calls[0].name}` : ''}
              </span>
            </li>
          ))}
          {!hits.length && <li className="fnone">no knot answers to that</li>}
        </ul>
      </div>
    </div>
  )
}

function lineColorOf(net: Network | null, lineId?: string): string {
  if (!net || !lineId) return '#9a7ff0'
  for (const c of net.corridors) for (const l of c.lines) if (l.id === lineId) return l.color
  return '#9a7ff0'
}

// decorative ghost braid for the empty state
function GhostBraid() {
  return (
    <svg viewBox="0 0 220 90" className="e-braid" width="220" height="90" aria-hidden>
      <path d="M8 45 C40 10 60 80 92 45 S144 10 176 45 208 70 212 45" fill="none" stroke="#9a7ff0" strokeWidth="2.6" strokeLinecap="round" opacity=".85" />
      <path d="M8 45 C40 80 60 10 92 45 S144 80 176 45" fill="none" stroke="#4fb083" strokeWidth="2.6" strokeLinecap="round" opacity=".85" />
      {[8, 92, 176].map((x) => (
        <circle key={x} cx={x} cy={45} r="4.4" fill="#24242e" stroke="#e6dcc0" strokeWidth="2" />
      ))}
      <path d="M176 45 q10 -8 20 -4 M176 45 q12 0 20 4" fill="none" stroke="#4fb083" strokeWidth="1.4" strokeLinecap="round" opacity=".6" />
    </svg>
  )
}
