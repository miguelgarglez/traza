import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ingest, type DroppedFile } from './lib/parse/ingest.ts'
import { buildNetwork, type Network, type Station, type Works } from './lib/metro.ts'
import { buildRide, legPoint, type Ride } from './lib/ride.ts'
import type { Weave } from './lib/model.ts'
import { filesFromDrop, filesFromInput, loadDemo } from './lib/files.ts'
import MapView, { type MapHandle } from './MapView.tsx'
import Inspector from './Inspector.tsx'
import { haptic, hapticsOn, setHaptics } from './lib/haptics.ts'

type Status = 'boot' | 'ready' | 'empty' | 'lineclosed'

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
  const map = useRef<MapHandle>(null)
  const filePick = useRef<HTMLInputElement>(null)
  const dirPick = useRef<HTMLInputElement>(null)

  const net: Network | null = useMemo(() => (weave && weave.sessions.length ? buildNetwork(weave) : null), [weave])

  // ---- the ride ----
  const [svcIdx, setSvcIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [rideUi, setRideUi] = useState<{ stop: number; total: number; name: string; next: string } | null>(null)
  const rideRef = useRef<{ leg: number; dist: number; dwell: number }>({ leg: 0, dist: 0, dwell: 0 })
  // express seek: a pending stop index the train fast-travels to along the
  // real track — forward through stops, backward by rewinding legs
  const seekRef = useRef<number | null>(null)
  const [seeking, setSeeking] = useState<number | null>(null)
  const reduced = useReducedMotion()
  const dockRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)

  const ride: Ride | null = useMemo(
    () => (net && net.corridors.length ? buildRide(net, Math.min(svcIdx, net.corridors.length - 1)) : null),
    [net, svcIdx],
  )

  // fare meter — cumulative tokens spent, stop by stop
  const fares = useMemo(() => {
    if (!ride) return [] as number[]
    let acc = 0
    return ride.stops.map((s) => {
      const t = s.step?.tokens
      acc += (t?.input ?? 0) + (t?.output ?? 0)
      return acc
    })
  }, [ride])

  // the mobile inspector sheet rests on the dock — observe it directly so
  // wraps, font or content changes can never strand the sheet underneath
  useEffect(() => {
    const el = dockRef.current
    const host = mainRef.current
    if (!el || !host) return
    const measure = () => {
      host.style.setProperty('--dockh', `${el.getBoundingClientRect().height}px`)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      removeEventListener('resize', measure)
    }
  }, [!!ride])

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

  // first run: platform-sign guide, three learn-by-doing steps — the first
  // sign hangs once the opening dive has landed, so it owns the frame
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
    if (!guide || !net) { setGpos(null); return }
    if (guide === 3) {
      // the play button's rect moves when the dock reflows — track it on
      // animation frames like the map anchors do
      const track = () => {
        const r = document.querySelector('.dock .play')?.getBoundingClientRect()
        if (r) setGpos((prev) => (prev && Math.abs(prev.x - (r.left + r.width / 2)) < 0.5 && Math.abs(prev.y - r.top) < 0.5 ? prev : { x: r.left + r.width / 2, y: r.top }))
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
    if (!ix) { setGpos(null); return }
    if (guide === 2) {
      map.current?.flyTo(ix.x, ix.y - 60, 640, 400)
      // don't setSel here — opening the inspector would hide this very sign
      // (selopen); the learner opens the branch by clicking it themselves
    }
    // keep the sign pinned to its target — tracked on animation frames so
    // the camera flight and the sign move together, no stepped pursuit
    const tick = () => {
      const p = map.current?.screenPos(ix.id)
      if (p) setGpos((prev) => (prev && Math.abs(prev.x - p.px) < 0.5 && Math.abs(prev.y - p.py) < 0.5 ? prev : { x: p.px, y: p.py }))
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

  // ghost service — after 20 idle seconds a dim train drifts the trunk
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
      if (document.hidden) return // no idle work on a backgrounded tab
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
        ? { stop: 1, total: ride.stops.length, name: ride.stops[0]!.name, next: ride.stops[1]!.name }
        : null,
    )
    map.current?.setTrain(0, 0, 0, false)
  }, [ride])

  useEffect(() => {
    if (!playing || !ride?.legs.length) return
    let raf = 0
    let last = performance.now()
    const PXS = 300 // world px/s at 1×
    const tick = (now: number) => {
      const dt = Math.min(64, now - last)
      last = now
      const rp = rideRef.current
      // an express seek owns the train while it's travelling — the normal
      // loop just holds the frame until the seek releases it
      if (seekRef.current !== null) {
        raf = requestAnimationFrame(tick)
        return
      }
      const leg = ride.legs[rp.leg]
      if (!leg) {
        // past the terminus leg — the 'all change' hold is time-based;
        // its timeout flips `playing`, so a re-ticked loop just idles
        raf = requestAnimationFrame(tick)
        return
      }
      if (rp.dwell > 0) {
        rp.dwell -= dt * speed
        raf = requestAnimationFrame(tick)
        return
      }
      if (reduced) {
        // reduced motion: hop straight to the next stop, short beat
        rp.dist = leg.len
      } else {
        rp.dist += (PXS * speed * dt) / 1000
      }
      // points throw: flash the junction as the train crosses it
      leg.switches.forEach((sw, si) => {
        const key = `${rp.leg}:${si}`
        if (switchFired.current.has(key)) return
        const p = legPoint(leg, Math.min(rp.dist, leg.len))
        if (Math.hypot(p.x - sw.x, p.y - sw.y) < 16) {
          switchFired.current.add(key)
          map.current?.switchThrow(sw.x, sw.y)
          haptic('buzz') // points throw — a small mechanical tick
        }
      })
      if (rp.dist >= leg.len) {
        // arrived at leg.stop — keep the approach heading; nothing teleports
        const end = legPoint(leg, leg.len)
        rp.leg += 1
        rp.dist = 0
        rp.dwell = 190
        const arrived = leg.stop
        setSel(arrived.id)
        setRideUi({
          stop: rp.leg + 1,
          total: ride.stops.length,
          name: arrived.name,
          next: ride.legs[rp.leg]?.stop.name ?? 'terminus',
        })
        map.current?.setTrain(arrived.x, arrived.y, end.angle, true, lineColorOf(net, arrived.lineId))
        if (followRef.current) map.current?.keepInView(arrived.x, arrived.y)
        // no haptic on ordinary arrivals — at speed that's constant noise;
        // physical feedback stays for seeks, detents and the switch throw
        if (rp.leg >= ride.legs.length) {
          map.current?.terminusGlow(ride.corridorIdx)
          setRideUi({
            stop: ride.stops.length,
            total: ride.stops.length,
            name: 'terminus — all change',
            next: `${arrived.name} · ${fmtK(fares[fares.length - 1] ?? 0)} tok`,
          })
          haptic('success') // arrived — the platform chime
          // the held beat: the train stays parked, night and the corridor
          // flare burn while 'all change' reads on the board — then the
          // lights come up and the service releases
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
  }, [playing, ride, speed, reduced, net])

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

  // express seek — the train fast-travels the real track to the target:
  // forward through each leg, backward by rewinding. Nothing teleports.
  useEffect(() => {
    if (seeking === null || !ride || !ride.stops.length) return
    const rp = rideRef.current
    rp.dwell = 0
    const RATE = 2400 // world px/s — brisk, readable, proportional to track
    let last = performance.now()
    let lastLeg = -1
    let raf = requestAnimationFrame(function step(now: number) {
      const dt = Math.min(64, now - last)
      last = now
      const target = seekRef.current
      if (target === null) return
      const px = (RATE * dt) / 1000
      if (rp.leg > target) {
        // rewind — walk the legs backward
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
        // arrived — release the train back to the normal loop
        rp.dist = 0
        rp.dwell = 0
        const stop = ride.stops[target]!
        setSel(stop.id)
        if (target >= ride.legs.length) {
          // sought straight to the terminus — it earns the same held beat
          // as a ridden arrival: corridor flare + 'all change' on the board
          map.current?.terminusGlow(ride.corridorIdx)
          setRideUi({
            stop: ride.stops.length,
            total: ride.stops.length,
            name: 'terminus — all change',
            next: `${stop.name} · ${fmtK(fares[fares.length - 1] ?? 0)} tok`,
          })
          haptic('success')
          setTimeout(() => setPlaying(false), reduced ? 60 : 1700)
        } else {
          setRideUi({
            stop: target + 1,
            total: ride.stops.length,
            name: stop.name,
            next: ride.stops[target + 1]?.name ?? 'terminus',
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
        // flash the junctions it crosses, silently — haptics stay on the
        // user's own throws, not express transit
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
          next: ride.stops[rp.leg + 1]?.name ?? 'terminus',
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
      haptic('nudge') // user-initiated seek
      if (reduced) {
        // reduced motion: arrive instantly, skip the express
        rideRef.current = { leg: Math.min(k, ride.legs.length - 1), dist: 0, dwell: 0 }
        seekRef.current = null
        setSeeking(null)
        const stop = ride.stops[k]!
        setSel(stop.id)
        setRideUi({ stop: k + 1, total: ride.stops.length, name: stop.name, next: ride.stops[k + 1]?.name ?? 'terminus' })
        placeTrainAt(k)
        map.current?.flyTo(stop.x, stop.y, 700, 420)
        return
      }
      seekRef.current = k
      setSeeking(k)
    },
    [ride, net, reduced, placeTrainAt],
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
      setBusy('laying track…')
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

  // first visit: open on the demo service so the first thing seen is a plano
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

  const indexes = useMemo(() => {
    const st = new Map<string, { s: Station; lineIdx: number; corridorIdx: number }>()
    if (!net) return { st }
    net.corridors.forEach((c, ci) =>
      c.lines.forEach((l, li) => l.stations.forEach((s) => st.set(s.id, { s, lineIdx: li, corridorIdx: ci }))),
    )
    return { st }
  }, [net])

  const jump = useCallback(
    (stationId: string) => {
      const hit = indexes.st.get(stationId)
      if (!hit || !net) return
      setSel(stationId)
      map.current?.flyTo(hit.s.x, hit.s.y, 900, 500)
    },
    [indexes, net],
  )

  const stepAlong = useCallback(
    (dir: 1 | -1) => {
      if (!net) return
      if (!sel || !indexes.st.has(sel)) {
        const first = net.corridors[0]?.lines[0]?.stations[0]
        if (first) jump(first.id)
        return
      }
      const { s } = indexes.st.get(sel)!
      const line = net.corridors
        .flatMap((c) => c.lines)
        .find((l) => l.id === s.lineId)
      const next = line?.stations[s.ord + dir]
      if (next) jump(next.id)
    },
    [net, sel, indexes, jump],
  )

  const switchLine = useCallback(
    (dir: 1 | -1) => {
      if (!net || !sel) return
      const hit = indexes.st.get(sel)
      if (!hit) return
      const c = net.corridors[hit.corridorIdx]!
      const cur = c.lines[hit.lineIdx]!
      // at a fork interchange, ↓ takes the departing branch; at a branch, ↑ returns to parent
      if (dir > 0) {
        const child = c.lines.find((l) => l.forkStation?.stationId === sel)
        if (child?.stations[0]) return jump(child.stations[0].id)
      } else if (cur.forkStation) {
        const parent = c.lines.find((l) => l.id === cur.forkStation!.lineId)
        const st = parent?.stations.find((x) => x.id === cur.forkStation!.stationId)
        if (st) return jump(st.id)
      }
      // else nearest line by row
      const near = c.lines[hit.lineIdx + dir]
      if (near) {
        const best = near.stations.reduce((a, b) => (Math.abs(b.x - hit.s.x) < Math.abs(a.x - hit.s.x) ? b : a))
        jump(best.id)
      }
    },
    [net, sel, indexes, jump],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const k = e.key
      // let focused buttons/links keep their native activation keys
      if ((tag === 'BUTTON' || tag === 'A') && (k === ' ' || k === 'Enter')) return
      if (k === 'ArrowLeft') (e.preventDefault(), stepAlong(-1))
      else if (k === 'ArrowRight') (e.preventDefault(), stepAlong(1))
      else if (k === 'ArrowDown') (e.preventDefault(), switchLine(1))
      else if (k === 'ArrowUp') (e.preventDefault(), switchLine(-1))
      else if (k === 'Escape') setSel(null)
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
  }, [stepAlong, switchLine, ride, rideUi, rideTo, playing, guide])

  const stats = weave?.stats
  const demoLoaded = files.some((f) => f.path.startsWith('demo/'))

  return (
    <main
      ref={mainRef}
      className={`stage${net ? ' hasnet' : ''}${playing ? ' night' : ''}${sel ? ' selopen' : ''}${net && !landed ? ' boot' : ''}`}
    >
      {net && (
        <MapView
          ref={map}
          net={net}
          sel={sel}
          onPick={(id) => {
            setSel(id)
            // one thing at a time: the sheet owns the small screen
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
          onUserPan={() => guide === 1 && setGuide(2)}
          onUserGesture={() => setFollowOn(false)}
          onArrive={() => setLanded(true)}
        />
      )}

      {/* wordmark lives inside the plano (the headboard) — the DOM only
          carries it for assistive tech and document title semantics */}
      <h1 className="sr">traza — the metro map of your agent sessions</h1>

      {/* map tools — visible affordances for what the keys also do */}
      {net && (
        <div className="maptools">
          <span className="brand" aria-hidden>traza</span>
          <button
            className="openbtn"
            aria-label="open your export"
            title="open your exported agent sessions"
            onClick={() => filePick.current?.click()}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
              <path d="M8 11V2M5 5l3-3 3 3M2.5 11v2.5h11V11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>open</span>
          </button>
          <span className="brandcap" aria-hidden>agent-session exports · files stay local</span>
          <button aria-label="find a station ( / )" title="find a station" onClick={() => setFinder(true)}>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
              <circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            aria-label="fit the whole plano ( f )"
            title="fit the whole plano"
            onClick={() => map.current?.fit()}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
              <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}

      {/* follow suspended by a gesture — a small way back onto the train */}
      {playing && !follow && (
        <button className="followpill" onClick={() => setFollowOn(true)}>
          follow the train ▸
        </button>
      )}

      {/* key — service legend, bottom left */}
      {net && (
        /* the panel is 'shut' whenever its body isn't actually showing —
           the class follows the render, not the user's stored toggle, so
           the collapsed header can never clip its meta counts behind an
           open-class layout */
        <section className={keyOpen && landed && (guide !== 1 || keyPinned) ? 'key' : 'key shut'} aria-label="service key">
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
            <b>key</b>
            <span>{net.stats.stations} stops · {net.stats.lines} lines{net.stats.works ? ` · ${net.stats.works} works` : ''}</span>
            <i>{keyOpen && landed && (guide !== 1 || keyPinned) ? '▾' : '▴'}</i>
          </button>
          {/* during the opening beat and the tour's first step the key
              stays a single row — the dive and the hanging sign own the
              frame; a tap on the header always overrides */}
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
                    <i className="svcchip" style={{ background: trunk?.color }}>S{i + 1}</i>
                    <span className="svcname">{c.session.title}</span>
                    <span className="svcmeta">
                      {c.session.agent} · {trunk?.stations.length ?? 0} stops{branchN ? ` · ${branchN} branch${branchN === 1 ? 'es' : ''}` : ''}
                    </span>
                  </button>
                )
              })}
              <button className="keyrow" onClick={() => setSrcOpen(!srcOpen)}>
                <b>sources</b>
                <span>{weave?.files.length} files{stats?.redactions ? ` · ${stats.redactions} secrets patched` : ''}</span>
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
                <button aria-label="replay the tour" title="replay the tour" onClick={() => setGuide(1)}>?</button>
                <button
                  className={hap ? 'haptoggle on' : 'haptoggle'}
                  aria-pressed={hap}
                  title={hap ? 'haptics on — taps, detents and the switch-throw tick' : 'haptics off'}
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

      {/* transport dock — the ride */}
      {net && ride && ride.stops.length > 1 && rideUi && (
        <section ref={dockRef} className="dock" aria-label="ride controls">
          <div className="svcpick">
            <button aria-label="previous service" onClick={() => setSvcIdx((i) => (i - 1 + net.corridors.length) % net.corridors.length)}>‹</button>
            <i className="svcchip" style={{ background: net.corridors[ride.corridorIdx]?.lines.find((l) => l.trunk)?.color }}>
              S{ride.corridorIdx + 1}
            </i>
            <button aria-label="next service" onClick={() => setSvcIdx((i) => (i + 1) % net.corridors.length)}>›</button>
          </div>
          <button className="skip" aria-label="previous stop" onClick={() => rideTo(rideUi.stop - 2)} disabled={rideUi.stop <= 1}>|◀</button>
          <button
            className={`play${playing ? ' on' : ''}${guide === 3 ? ' nudge' : ''}`}
            onClick={() => {
              if (!playing && rideRef.current.leg >= ride.legs.length) rideTo(0)
              // a departure beat: the train dwells while the headlight ignites
              if (!playing && !reduced) rideRef.current.dwell = 480
              setFollowOn(true)
              setPlaying(!playing)
              if (guide) guideDone()
            }}
            aria-label={playing ? 'pause the ride' : 'ride the line'}
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <button className="skip" aria-label="next stop" onClick={() => rideTo(rideUi.stop)} disabled={rideUi.stop >= rideUi.total}>▶|</button>
          <div className="rideinfo">
            <div className="led">
              <LedText as="span" text={rideUi.stop >= rideUi.total ? 'all change' : 'next'} />
              <LedText text={rideUi.next} />
            </div>
            <RideProg
              stop={rideUi.stop}
              total={rideUi.total}
              names={ride.stops.map((s) => s.name)}
              onSeek={rideTo}
            />
            <LedText as="span" className="ridesub" text={`${rideUi.name} · ${rideUi.stop}/${rideUi.total}`} />
          </div>
          <div className="fare" title="tokens spent so far on this service">
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
          {/* phones: one control cycles the rate instead of a second row */}
          <button
            className="speedcycle"
            aria-label={`ride speed ${speed}× — tap to change`}
            onClick={() => setSpeed((s) => (s === 1 ? 2 : s === 2 ? 4 : 1))}
          >
            {speed}×
          </button>
        </section>
      )}

      {net && <Inspector net={net} sel={sel} onClose={() => setSel(null)} onJump={jump} onPrevNext={stepAlong} />}

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

      {/* first-run guide — hanging platform signs, each pinned above the
          station or control it teaches. The ride supersedes it. */}
      {guide > 0 && !playing && (
        <div
          className={`gsign g${guide}`}
          role="note"
          style={
            gpos
              ? {
                  left: Math.max(140, Math.min(innerWidth - 140, gpos.x)),
                  top: Math.max(14, gpos.y - (guide === 3 ? 108 : 128)),
                  bottom: 'auto',
                  transform: 'translateX(-50%)',
                }
              : undefined
          }
        >
          <div className="sign">
            <b>{guide === 1 ? 'every station is a step the agent took' : guide === 2 ? 'a branch peeled off — a subagent ran alongside' : 'ride the line'}</b>
            <p>
              {guide === 1
                ? 'drag the plano to look around'
                : guide === 2
                  ? 'click the interchange ring to meet the sidekick'
                  : 'press play — the train re-runs the session through the night'}
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
            <b>drop the export</b>
            <p>nodes.jsonl · rollout-*.jsonl · messages.jsonl · ATIF</p>
          </div>
        </div>
      )}

      {status === 'empty' && !busy && (
        <div className="veil">
          <div className="plaque empty">
            <GhostMap />
            <h2>no service running</h2>
            <p>Drop an agent session export — a folder or loose jsonl files — and traza draws the plano.</p>
            <div className="actions">
              <button onClick={() => dirPick.current?.click()}>open a folder</button>
              <button onClick={() => filePick.current?.click()}>open files</button>
              <button className="ghost" onClick={() => loadDemo().then((d) => load(d))}>ride the demo</button>
            </div>
          </div>
        </div>
      )}

      {status === 'lineclosed' && !busy && (
        <div className="veil">
          <div className="plaque empty">
            <span className="closedbadge">line closed</span>
            <h2>nothing here looks like a session</h2>
            <p>{files.length} file{files.length === 1 ? '' : 's'} surveyed — the sniffers found no devin nodes, codex rollouts, cursor messages or ATIF traces in them.</p>
            <ul className="srclist inline">
              {weave?.files.slice(0, 6).map((f) => (
                <li key={f.path} className="bad"><code>{f.path}</code><span>{f.note ?? f.format}</span></li>
              ))}
            </ul>
            <div className="actions">
              <button onClick={() => dirPick.current?.click()}>try another folder</button>
              <button className="ghost" onClick={() => loadDemo().then((d) => load(d))}>ride the demo</button>
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

/** a text fragment that slides its replacement in from the right — the
    LED board's destination, its mode label, and the position line all
    morph instead of hard-cutting */
function LedText({ text, as = 'b', className }: { text: string; as?: 'b' | 'span'; className?: string }) {
  const ref = useRef<HTMLElement | null>(null)
  const prev = useRef(text)
  const anim = useRef<Animation | null>(null)
  // if the user flips reduced-motion mid-flight, the in-flight swap dies too
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
    anim.current = ref.current?.animate(
      [
        { opacity: 0.15, transform: 'translateX(12px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' },
    ) ?? null
  }, [text])
  return as === 'b' ? (
    <b ref={ref} className={className}>
      {text}
    </b>
  ) : (
    <span ref={ref} className={className}>
      {text}
    </span>
  )
}

/** progress slider — drag to scrub with a station preview, arrows when focused */
function RideProg({ stop, total, names, onSeek }: { stop: number; total: number; names: string[]; onSeek: (i: number) => void }) {
  const [preview, setPreview] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const stopAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.max(0, Math.min(total - 1, Math.round(((clientX - r.left) / r.width) * total) - 1))
  }
  return (
    <div
      ref={ref}
      className="rideprog"
      role="slider"
      aria-label="ride progress — drag to scrub"
      aria-valuemin={1}
      aria-valuenow={stop}
      aria-valuemax={total}
      aria-valuetext={names[stop - 1]}
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
        const i = stopAt(e.clientX)
        setPreview(i)
        onSeek(i)
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        const i = stopAt(e.clientX)
        setPreview(i)
        onSeek(i)
      }}
      onPointerUp={() => setPreview(null)}
      onPointerCancel={() => setPreview(null)}
      onLostPointerCapture={() => setPreview(null)}
    >
      <i style={{ width: `${(stop / total) * 100}%` }} />
      <b className="progthumb" style={{ left: `${(stop / total) * 100}%` }} />
      {preview != null && (
        <span className="progprev" style={{ left: `${((preview + 1) / total) * 100}%` }}>
          {names[preview]}
        </span>
      )}
    </div>
  )
}

/** full step title — the map label is truncated for the plano */
const fullTitle = (s: Station) => s.step.title?.trim().replace(/^<[^>]+>\s*/, '') || s.name

/** "Where to?" — citymapper-style station finder over names, actors and tools. */
function Finder({ net, onGo, onClose }: { net: Network; onGo: (s: Station) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])

  const all = useMemo(() => {
    const out: { s: Station; svc: string; color: string }[] = []
    net.corridors.forEach((c, ci) =>
      c.lines.forEach((l) =>
        l.stations.forEach((s) =>
          out.push({ s, svc: `S${ci + 1}`, color: l.color }),
        ),
      ),
    )
    return out
  }, [net])

  const hits = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return all.slice(0, 8)
    return all
      .filter(
        ({ s }) =>
          fullTitle(s).toLowerCase().includes(t) ||
          s.step.actor.includes(t) ||
          (s.step.calls ?? []).some((c) => c.name.toLowerCase().includes(t)),
      )
      .slice(0, 8)
  }, [all, q])

  return (
    <div className="finderwrap" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="finder" role="dialog" aria-label="where to">
        <div className="findhead">
          <span>where to?</span>
          <input
            ref={inputRef}
            value={q}
            placeholder="station, tool, actor…"
            onChange={(e) => (setQ(e.target.value), setIdx(0))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') (e.preventDefault(), setIdx((i) => Math.min(hits.length - 1, i + 1)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)))
              else if (e.key === 'Enter' && hits[idx]) (onGo(hits[idx].s), onClose())
            }}
          />
          <kbd>esc</kbd>
        </div>
        <ul>
          {hits.map((h, i) => (
            <li key={h.s.id} className={i === idx ? 'hit' : ''} onPointerEnter={() => setIdx(i)} onClick={() => (onGo(h.s), onClose())}>
              <i style={{ background: h.color }} />
              <b>{fullTitle(h.s)}</b>
              <span>
                {h.svc} · {h.s.step.actor}
                {h.s.step.calls?.[0] ? ` · ${h.s.step.calls[0].name}` : ''}
              </span>
            </li>
          ))}
          {!hits.length && <li className="nohit">no station answers to that</li>}
        </ul>
      </div>
    </div>
  )
}

function lineColorOf(net: Network | null, lineId?: string): string {
  if (!net || !lineId) return '#0F4E9E'
  for (const c of net.corridors) for (const l of c.lines) if (l.id === lineId) return l.color
  return '#0F4E9E'
}

// decorative ghost schematic for the empty state
function GhostMap() {
  return (
    <svg viewBox="0 0 220 90" className="ghostmap" aria-hidden>
      <path d="M8 30 H140 L170 60 H212" fill="none" stroke="#0F4E9E" strokeWidth="4" strokeLinecap="round" opacity=".9" />
      <path d="M96 30 L120 54 V74" fill="none" stroke="#E2001A" strokeWidth="4" strokeLinecap="round" opacity=".9" />
      {[8, 50, 96, 140].map((x) => (
        <circle key={x} cx={x} cy={30} r="4" fill="#fff" stroke="#0F4E9E" strokeWidth="3" />
      ))}
      <circle cx={170} cy={60} r="4" fill="#fff" stroke="#0F4E9E" strokeWidth="3" />
      <circle cx={120} cy={74} r="4" fill="#fff" stroke="#E2001A" strokeWidth="3" />
      <rect x={58} y={70} width="14" height="14" rx="3" fill="#fff" stroke="#5A6B80" strokeWidth="1.6" strokeDasharray="3 3" />
    </svg>
  )
}
