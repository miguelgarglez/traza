import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { Label, Network, Station, Works } from './lib/metro.ts'
import type { Tether } from './lib/links.ts'
import { P, U } from './lib/metro.ts'

export interface MapHandle {
  fit: () => void
  flyTo: (x: number, y: number, w?: number, h?: number) => void
  zoomBy: (f: number) => void
  /** move the ride token; 60fps-imperative, no react render */
  setTrain: (x: number, y: number, angle: number, visible: boolean, color?: string) => void
  /** keep a world point inside the comfortable view area (ride follow) */
  keepInView: (x: number, y: number) => void
  /** flash the points-throw glyph at a junction the train is crossing */
  switchThrow: (x: number, y: number) => void
  /** terminus reveal — the ridden corridor flares awake for a beat */
  terminusGlow: (corridorIdx: number) => void
  /** the idle ghost service — a dim train drifting the trunk */
  setGhost: (x: number, y: number, angle: number, visible: boolean, color?: string) => void
  /** screen px of a station, for anchoring DOM chrome to the plano */
  screenPos: (stationId: string) => { px: number; py: number } | null
}

interface Props {
  net: Network
  sel: string | null
  onPick: (id: string | null) => void
  onPickWorks: (w: Works) => void
  /** night service: the ride is running — dim the field, glow the tracks */
  riding: boolean
  /** solo a corridor index; null = everything lit */
  solo: number | null
  /** cross-session tethers — dashed threads between fabrics */
  tethers?: Tether[]
  /** station ids dimmed out by the active filter set */
  fout?: Set<string>
  /** the turn the shuttle is on — rides beside it while replaying */
  rideLabel?: string | null
  /** fired once per gesture when the user drags the plano (first-run guide) */
  onUserPan?: () => void
  /** fired on every manual gesture (drag, wheel, pinch) — suspends ride follow */
  onUserGesture?: () => void
  /** the opening camera beat landed or was stolen — chrome may arrive */
  onArrive?: () => void
}

const K_MIN = 0.02
const K_MAX = 8

const d = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')

// a strand is a thread, not a rail — smooth the polyline through midpoints
// so forks and rejoins flow like weft instead of snapping at 45°
const smooth = (pts: { x: number; y: number }[]) => {
  if (pts.length < 3) return d(pts)
  let out = `M${pts[0]!.x} ${pts[0]!.y}`
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!
    const n = pts[i + 1]!
    const mx = (p.x + n.x) / 2
    const my = (p.y + n.y) / 2
    out += ` Q${p.x} ${p.y} ${mx} ${my}`
  }
  const last = pts[pts.length - 1]!
  out += ` L${last.x} ${last.y}`
  return out
}

const PAPER = '#24242e'
const RING = '#0b0b10'

function stationGlyph(s: Station, color: string, sel: boolean) {
  if (s.tier === 'terminus')
    // a tied end — the strand's knot where the cloth starts or finishes
    return (
      <g key={s.id}>
        <circle cx={s.x} cy={s.y} r={6.2} fill={PAPER} stroke={color} strokeWidth={2.6} />
        <circle cx={s.x} cy={s.y} r={2.4} fill={color} />
        {sel && <circle cx={s.x} cy={s.y} r={9.4} fill="none" stroke="#e6dcc0" strokeWidth={1.2} />}
      </g>
    )
  if (s.tier === 'interchange')
    // a twist knot — two strands visibly cross and wrap here
    return (
      <g key={s.id}>
        <circle cx={s.x} cy={s.y} r={6.8} fill={PAPER} stroke={RING} strokeWidth={2.2} />
        <circle cx={s.x} cy={s.y} r={2.9} fill={color} />
        <path
          className="twistmark"
          d={`M${s.x - 6.8} ${s.y + 3.4} Q${s.x} ${s.y - 4.5} ${s.x + 6.8} ${s.y + 3.4}`}
          fill="none"
          stroke={color}
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      </g>
    )
  if (s.tier === 'major')
    // a bead on the thread — user words and failed calls earn presence
    return (
      <g key={s.id}>
        <circle cx={s.x} cy={s.y} r={4.6} fill={PAPER} stroke={color} strokeWidth={2.2} />
        <circle cx={s.x} cy={s.y} r={1.8} fill={color} />
      </g>
    )
  return <circle key={s.id} cx={s.x} cy={s.y} r={2.5} fill={color} />
}

const MapView = forwardRef<MapHandle, Props>(function MapView({ net, sel, onPick, onPickWorks, riding, solo, tethers, fout, rideLabel, onUserPan, onUserGesture, onArrive }, ref) {
  const svgRef = useRef<SVGSVGElement>(null)
  const worldRef = useRef<SVGGElement>(null)
  const trainRef = useRef<SVGGElement>(null)
  const switchRef = useRef<SVGGElement>(null)
  const ghostRef = useRef<SVGGElement>(null)
  const cam = useRef({ x: 0, y: 0, k: 0.1 })
  const raf = useRef(0)
  const flight = useRef<number | null>(null)
  const [hover, setHoverRaw] = useState<{ s: Station; px: number; py: number } | null>(null)
  const hoverRef = useRef<{ s: Station; px: number; py: number } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const setHover = (h: typeof hover) => {
    hoverRef.current = h
    setHoverRaw(h)
  }
  const [fresh, setFresh] = useState(true)
  const litEl = useRef<SVGGElement | null>(null)
  const litCheck = useRef<{ x: number; y: number } | null>(null)
  const setLit = (sid: string | null) => {
    litEl.current?.classList.remove('lit')
    litEl.current = sid ? (svgRef.current?.querySelector(`[data-sid="${CSS.escape(sid)}"]`) as SVGGElement | null) ?? null : null
    litEl.current?.classList.add('lit')
  }
  const selvRef = useRef<HTMLDivElement>(null)
  const slabelRef = useRef<SVGGElement>(null)
  const drag = useRef<{ px: number; py: number; cx: number; cy: number; moved: boolean; panning?: boolean } | null>(null)
  const pinch = useRef<{ d: number; k: number } | null>(null)
  const lastKiv = useRef(0)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const f = () => setReduced(mq.matches)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [])
  useEffect(() => {
    // live preference flip: cancel anything still in the air
    if (reduced && flight.current != null) {
      cancelAnimationFrame(flight.current)
      flight.current = null
    }
  }, [reduced])
  const gestureRef = useRef(onUserGesture)
  gestureRef.current = onUserGesture
  const arriveRef = useRef(onArrive)
  arriveRef.current = onArrive
  const arrived = useRef(false)
  const arrive = () => {
    if (arrived.current) return
    arrived.current = true
    arriveRef.current?.()
  }

  const apply = () => {
    const g = worldRef.current
    const svg = svgRef.current
    if (!g || !svg) return
    const { x, y, k } = cam.current
    // translation on the svg element → pure compositing during pans;
    // scale stays on the world group so vectors re-raster crisp only on zoom
    svg.style.transform = `translate(${x}px, ${y}px)`
    g.setAttribute('transform', `scale(${k})`)
    g.style.setProperty('--k', String(k))
    svg.dataset.z = k < 0.18 ? 'far' : k < 0.7 ? 'mid' : 'near'
    // reposition the tip imperatively — a setState here would re-render
    // the whole network every camera frame
    const h = hoverRef.current
    if (h && tipRef.current) {
      const { px, py } = toScreen(h.s.x, h.s.y)
      tipRef.current.style.left = `${px + 14}px`
      tipRef.current.style.top = `${py - 34}px`
    }
    // selvedge tabs track their session's band as the cloth pans
    const selv = selvRef.current
    if (selv && svg) {
      const vh = svg.clientHeight
      const kids = selv.children
      for (let i = 0; i < kids.length && i < selvAnchors.length; i++) {
        const el = kids[i] as HTMLElement
        const py = selvAnchors[i]! * k + y
        el.style.top = `${Math.max(56, Math.min(vh - 150, py))}px`
      }
    }
  }

  const toScreen = (wx: number, wy: number) => {
    const { x, y, k } = cam.current
    return { px: wx * k + x, py: wy * k + y }
  }
  const toWorld = (px: number, py: number) => {
    const { x, y, k } = cam.current
    return { wx: (px - x) / k, wy: (py - y) / k }
  }

  // the part of the wrap not covered by floating chrome — camera fits and
  // ride-follow compose inside this rect, so open panels never hide the map
  const viewRect = () => {
    const wrap = svgRef.current?.parentElement
    const r = (wrap ?? svgRef.current!).getBoundingClientRect()
    let right = 0
    let bottom = 0
    const insp = document.querySelector('.inspector')
    if (insp) {
      const ir = insp.getBoundingClientRect()
      // desktop sidebar eats the right edge; the mobile sheet eats the bottom
      if (ir.width > r.width * 0.55) bottom = Math.max(bottom, r.height - ir.top + 8)
      else right = Math.max(right, r.width - ir.left + 8)
    }
    const dock = document.querySelector('.dock')
    if (dock) bottom = Math.max(bottom, r.height - dock.getBoundingClientRect().top + 8)
    return { w: r.width, h: r.height, right, bottom }
  }

  const fitTo = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    animate = false,
    opts: { ms?: number; inout?: boolean; done?: () => void } = {},
  ) => {
    const svg = svgRef.current
    if (!svg) return
    // a new fit supersedes any flight still in the air
    if (flight.current != null) { cancelAnimationFrame(flight.current); flight.current = null }
    const v = viewRect()
    const aw = Math.max(1, v.w - v.right)
    const ah = Math.max(1, v.h - v.bottom)
    const w = Math.max(1, x1 - x0)
    const h = Math.max(1, y1 - y0)
    const k = Math.min(aw / w, ah / h, K_MAX) * 0.92
    const tx = aw / 2 - ((x0 + x1) / 2) * k
    const ty = ah / 2 - ((y0 + y1) / 2) * k
    const target = { x: tx, y: ty, k: Math.max(K_MIN, k) }
    if (!animate || reduced) {
      cam.current = target
      apply()
      opts.done?.()
      return
    }
    const from = { ...cam.current }
    const t0 = performance.now()
    const dur = opts.ms ?? 620
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur)
      // the dive uses easeInOut — accelerate away, settle into the station;
      // ordinary retargets stay ease-out, responsive to the user's hand
      const e = opts.inout
        ? p < 0.5
          ? 4 * p * p * p
          : 1 - Math.pow(-2 * p + 2, 3) / 2
        : 1 - Math.pow(1 - p, 3)
      cam.current = {
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        k: from.k * Math.pow(target.k / from.k, e),
      }
      apply()
      if (p < 1) flight.current = requestAnimationFrame(step)
      else {
        flight.current = null
        opts.done?.()
      }
    }
    flight.current = requestAnimationFrame(step)
  }

  useImperativeHandle(ref, () => ({
    fit: () => fitTo(net.bounds.x0, net.bounds.y0, net.bounds.x1, net.bounds.y1, true),
    flyTo: (x, y, w = 1400, h = 700) => fitTo(x - w / 2, y - h / 2, x + w / 2, y + h / 2, true),
    zoomBy: (f) => {
      const svg = svgRef.current
      if (!svg) return
      const r = svg.getBoundingClientRect()
      zoomAt(r.width / 2, r.height / 2, f)
    },
    setTrain: (wx, wy, angle, visible, color) => {
      const g = trainRef.current
      if (!g) return
      g.setAttribute('transform', `translate(${wx} ${wy}) rotate(${angle})`)
      g.style.display = visible ? '' : 'none'
      if (color) g.style.setProperty('--train', color)
      // the shuttle's read rides beside it, unrotated
      const q = slabelRef.current
      if (q) {
        q.setAttribute('transform', `translate(${wx + 16} ${wy - 18})`)
        q.style.display = visible ? '' : 'none'
      }
      // platform lights: the station the train is at or approaching glows
      if (!visible) {
        setLit(null)
        return
      }
      if (!litCheck.current || Math.hypot(wx - litCheck.current.x, wy - litCheck.current.y) > 24) {
        litCheck.current = { x: wx, y: wy }
        let best: Station | null = null
        let bd = 72
        for (const s of stationIndex.values()) {
          const dd = Math.hypot(s.x - wx, s.y - wy)
          if (dd < bd) { bd = dd; best = s }
        }
        setLit(best?.id ?? null)
      }
    },
    keepInView: (wx, wy) => {
      const svg = svgRef.current
      if (!svg) return
      const v = viewRect()
      const { px, py } = toScreen(wx, wy)
      const aw = v.w - v.right
      const ah = v.h - v.bottom
      // while riding, the train sits in the left third so track ahead
      // — forks, the next interchange — is composed into the frame
      const lo = riding ? aw * 0.24 : aw * 0.16
      const hi = riding ? aw * 0.55 : aw * 0.84
      const my = ah * 0.18
      let tx = 0
      let ty = 0
      if (px < lo) tx = lo - px
      else if (px > hi) tx = hi - px
      if (py < my) ty = my - py
      else if (py > ah - my) ty = ah - my - py
      if (tx || ty) {
        // time-based easing — same feel at any refresh rate, never snaps
        const now = performance.now()
        const dt = Math.min(50, now - (lastKiv.current || now - 16))
        lastKiv.current = now
        const f = 1 - Math.exp(-dt / 110)
        cam.current.x += tx * f
        cam.current.y += ty * f
        apply()
      } else {
        lastKiv.current = 0
      }
    },
    switchThrow: (wx, wy) => {
      const g = switchRef.current
      if (!g) return
      g.setAttribute('transform', `translate(${wx} ${wy})`)
      g.classList.remove('live')
      void g.getBoundingClientRect() // restart the animation
      g.classList.add('live')
    },
    terminusGlow: (ci) => {
      const svg = svgRef.current
      if (!svg) return
      // celebrate the corridor that was ridden — not the whole map
      svg.querySelectorAll('.arr').forEach((el) => el.classList.remove('arr'))
      const groups = svg.querySelectorAll(`[data-ci="${ci}"]`)
      groups.forEach((el) => el.classList.add('arr'))
      setTimeout(() => groups.forEach((el) => el.classList.remove('arr')), 2900)
    },
    setGhost: (wx, wy, angle, visible, color) => {
      const g = ghostRef.current
      if (!g) return
      g.setAttribute('transform', `translate(${wx} ${wy}) rotate(${angle})`)
      g.style.display = visible ? '' : 'none'
      if (color) g.style.setProperty('--train', color)
    },
    screenPos: (sid) => {
      const s = stationIndex.get(sid)
      if (!s) return null
      return toScreen(s.x, s.y)
    },
  }))

  const zoomAt = (px: number, py: number, f: number) => {
    const c = cam.current
    const k = Math.min(K_MAX, Math.max(K_MIN, c.k * f))
    const { wx, wy } = toWorld(px, py)
    cam.current = { k, x: px - wx * k, y: py - wy * k }
    apply()
  }

  // initial fit once the net changes; the plano "lays track" for a moment.
  // The opening is a two-beat move: frame the whole first service while
  // the track draws in, then dive to a readable neighborhood — a screenful
  // of trunk at k≈1, not the whole service shrunk thin. A user gesture at
  // any point steals the camera and the dive never fires.
  // The whole network is a zoom-out away ('f' / the fit button).
  const openFly = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    arrived.current = false
    const c0 = net.corridors[0]
    const trunk = c0?.lines.find((l) => l.trunk)
    const s0 = trunk?.stations[0]
    if (!c0 || !trunk || !s0) {
      fitTo(net.bounds.x0, net.bounds.y0, net.bounds.x1, net.bounds.y1, false)
      arrive()
    } else {
      const v = viewRect()
      // a readable neighborhood: ~one screenful at k≈0.9. On phones the
      // key and dock already carry the service title, so the nameboard is
      // freed too — station glyphs need the pixels more.
      const mobile = v.w <= 720
      const wSpan = mobile ? Math.max(320, (v.w - v.right) / 0.9) : Math.max(360, (v.w - v.right) / 0.95)
      const nbLeft = s0.x - P * 1.9 - 30 - trunk.service.length * 5.4
      // desktop keeps the system headboard in the opening frame — the
      // imprint is the product's name on first paint, worth the zoom-out
      const hbLeft = s0.x - P * 1.9 - 44 - trunk.service.length * 6.4 - 262
      // on a portrait screen a flat run of trunk leaves dead air above and
      // below — anchor on the first interchange so the opening composes
      // vertically: trunk, a branch arc and the works all inside the frame
      const anchor = mobile ? (trunk.stations.find((s) => s.tier === 'interchange') ?? s0) : s0
      const x0 = mobile ? anchor.x - wSpan / 2 : Math.min(s0.x - P * 2.2, nbLeft - 16, hbLeft - 24)
      const x1 = mobile ? anchor.x + wSpan / 2 : Math.min(corridorBounds[0]!.geo.x1 + 30, s0.x + wSpan)
      // vertical extent of everything inside that x-window
      let y0 = c0.trunkY - U * 1.5 // the headboard hangs above the trunk
      let y1 = c0.trunkY + U * 0.8
      for (const l of c0.lines) {
        for (const s of l.stations)
          if (s.x >= x0 - U && s.x <= x1 + U) { y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y) }
        for (const sg of l.segs)
          for (const p of sg.pts)
            if (p.x >= x0 - U && p.x <= x1 + U) { y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y) }
      }
      for (const w of c0.works) if (w.x >= x0 && w.x <= x1) { y0 = Math.min(y0, w.y); y1 = Math.max(y1, w.y) }
      // on phones, lift the composition — the detail sheet will open into
      // the space it leaves, and the map never reads as bottom-half filler
      if (mobile) y0 -= U * 0.5
      const d0 = { x0, y0: y0 - U * 0.4, x1, y1: y1 + U * 0.5 }
      if (reduced) {
        fitTo(d0.x0, d0.y0, d0.x1, d0.y1, false)
        arrive()
      } else {
        const g = corridorBounds[0]!.geo
        fitTo(g.x0 - 60, g.y0 - U * 0.6, g.x1 + 60, g.y1 + U * 0.9, false)
        // hold the system-wide beat while the track lays in — long enough
        // to read the network's shape, then dive on the same flight curve
        // the rest of the app uses
        openFly.current = setTimeout(() => {
          openFly.current = null
          fitTo(d0.x0, d0.y0, d0.x1, d0.y1, true, { ms: 900, inout: true, done: arrive })
        }, 1650)
      }
    }
    setFresh(!reduced)
    const t = setTimeout(() => setFresh(false), 2600)
    return () => {
      clearTimeout(t)
      if (openFly.current) { clearTimeout(openFly.current); openFly.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    let panIdle: ReturnType<typeof setTimeout> | undefined
    const onWheel = (ev: Event) => {
      const e = ev as WheelEvent
      e.preventDefault()
      // a gesture always wins over a camera flight and suspends ride-follow
      if (flight.current != null) { cancelAnimationFrame(flight.current); flight.current = null }
      if (openFly.current) { clearTimeout(openFly.current); openFly.current = null }
      arrive()
      gestureRef.current?.()
      svg.dataset.pan = '1'
      clearTimeout(panIdle)
      panIdle = setTimeout(() => delete svg.dataset.pan, 160)
      // measure the untransformed wrap — the svg element itself is CSS-
      // translated by the camera, so its rect already contains the offset
      const r = (svg.parentElement ?? svg).getBoundingClientRect()
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.006 : 0.0022))
      zoomAt(e.clientX - r.left, e.clientY - r.top, f)
    }
    // the listener lives on the wrap, not the svg — the svg element is CSS-
    // translated by the camera, so its border box slides out from under the
    // pointer and gestures would fall through
    const wrap = svg.parentElement ?? svg
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => wrap.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    // a gesture always wins over a camera flight — nothing fights the hand
    if (flight.current != null) { cancelAnimationFrame(flight.current); flight.current = null }
    if (openFly.current) { clearTimeout(openFly.current); openFly.current = null }
    arrive()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }]
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), k: cam.current.k }
      drag.current = null
      onUserGesture?.()
    } else {
      drag.current = { px: e.clientX, py: e.clientY, cx: cam.current.x, cy: cam.current.y, moved: false }
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }]
      const nd = Math.hypot(a.x - b.x, a.y - b.y)
      onUserGesture?.()
      if (flight.current != null) { cancelAnimationFrame(flight.current); flight.current = null }
      svgRef.current!.dataset.pan = '1'
      const r = (svgRef.current!.parentElement ?? svgRef.current!).getBoundingClientRect()
      const mx = (a.x + b.x) / 2 - r.left
      const my = (a.y + b.y) / 2 - r.top
      const f = nd / pinch.current.d
      const k = Math.min(K_MAX, Math.max(K_MIN, pinch.current.k * f))
      const { wx, wy } = toWorld(mx, my)
      cam.current = { k, x: mx - wx * k, y: my - wy * k }
      apply()
      return
    }
    const dg = drag.current
    if (dg) {
      const dx = e.clientX - dg.px
      const dy = e.clientY - dg.py
      if (!dg.moved && Math.hypot(dx, dy) > 4) {
        dg.moved = true
        onUserPan?.()
        onUserGesture?.()
      }
      if (dg.moved) {
        if (!dg.panning) {
          dg.panning = true
          svgRef.current!.dataset.pan = '1'
        }
        cam.current.x = dg.cx + dx
        cam.current.y = dg.cy + dy
        cancelAnimationFrame(raf.current)
        raf.current = requestAnimationFrame(apply)
      }
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    const dg = drag.current
    drag.current = null
    if (!pointers.current.size && svgRef.current) delete svgRef.current.dataset.pan
    if (dg && !dg.moved) {
      // pick the nearest station or works badge to the tap point — at zoomed-
      // out scales hit circles overlap, so closeness, not DOM order, decides
      const r = (svgRef.current!.parentElement ?? svgRef.current!).getBoundingClientRect()
      const { k } = cam.current
      const { wx, wy } = toWorld(e.clientX - r.left, e.clientY - r.top)
      let sid: string | null = null
      let wid: string | null = null
      let best = 16 // screen px pick radius
      for (const s of stationIndex.values()) {
        const dd = Math.hypot((s.x - wx) * k, (s.y - wy) * k)
        if (dd < best) { best = dd; sid = s.id; wid = null }
      }
      for (const w of worksIndex.values()) {
        const dd = Math.hypot((w.x - wx) * k, (w.y - wy) * k)
        if (dd < best + 4) { best = dd; sid = null; wid = w.id }
      }
      if (sid) onPick(sel === sid ? null : sid)
      else if (wid) {
        const w = worksIndex.get(wid)
        if (w) onPickWorks(w)
      } else onPick(null)
    }
  }

  const onOver = (e: React.PointerEvent) => {
    if (pointers.current.size) return // mid-drag/pinch: skip hover churn
    const t = e.target as Element
    const sid = t.getAttribute?.('data-sid')
    if (!sid) {
      setHover(null)
      return
    }
    const s = stationIndex.get(sid)
    if (!s) return
    const { px, py } = toScreen(s.x, s.y)
    setHover({ s, px, py })
  }

  // per-corridor extents — `geo` is drawn geometry only (camera fits to it),
  // `full` adds the service nameboard so zones hang behind their signage too
  const corridorBounds = useMemo(() => {
    return net.corridors.map((c) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      const eat = (p: { x: number; y: number }) => {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
      }
      for (const l of c.lines) {
        for (const sg of l.segs) sg.pts.forEach(eat)
        l.stations.forEach(eat)
      }
      for (const w of c.works) eat(w)
      for (const lb of c.labels) eat(lb)
      if (!isFinite(x0)) {
        const z = { x0: 0, y0: c.y0, x1: 400, y1: c.y0 + c.height }
        return { geo: z, full: z }
      }
      const geo = { x0, y0, x1, y1 }
      const trunk = c.lines.find((l) => l.trunk)
      const s0 = trunk?.stations[0]
      const fx0 = trunk && s0 ? Math.min(x0, s0.x - P * 1.9 - 40 - trunk.service.length * 6.4) : x0
      return { geo, full: { x0: fx0, y0, x1, y1 } }
    })
  }, [net])

  // selvedge anchors — world-space y of each session's band center
  const selvAnchors = useMemo(() => corridorBounds.map((b) => (b.geo.y0 + b.geo.y1) / 2), [corridorBounds])

  // indexes
  const { stationIndex, worksIndex, lineColors } = useMemo(() => {
    const si = new Map<string, Station>()
    const wi = new Map<string, Works>()
    const lc = new Map<string, string>()
    for (const c of net.corridors) {
      for (const l of c.lines) {
        // key by station id, not line id — line ids are session-local
        // ('t-0' in every corridor) and collide across services
        for (const s of l.stations) {
          si.set(s.id, s)
          lc.set(s.id, l.color)
        }
      }
      for (const w of c.works) wi.set(w.id, w)
    }
    return { stationIndex: si, worksIndex: wi, lineColors: lc }
  }, [net])

  const selStation = sel ? stationIndex.get(sel) : undefined
  const dim = (ci: number): number | undefined => (solo === null || solo === ci ? undefined : 0.13)
  const fade = { transition: 'opacity .25s' } as const

  return (
    <div
      className="mapwrap"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerOver={onOver}
      onPointerLeave={() => setHover(null)}
    >
      <svg
        ref={svgRef}
        className={`plano${riding ? ' riding' : ''}${fresh ? ' fresh' : ''}`}
        role="application"
        aria-label="metro map of agent sessions — drag to pan, scroll to zoom, click a station"
      >
        <defs>
          <linearGradient id="beamGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#ffedb8" stopOpacity="0.8" />
            <stop offset="0.55" stopColor="#ffe9a6" stopOpacity="0.28" />
            <stop offset="1" stopColor="#ffe9a6" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="poolGrad">
            <stop offset="0" stopColor="#fff3c8" stopOpacity="0.5" />
            <stop offset="1" stopColor="#fff3c8" stopOpacity="0" />
          </radialGradient>
        </defs>
        <g ref={worldRef} className="world">
          {/* zone bands behind each corridor — hug the drawn geometry */}
          {net.corridors.map((_c, i) => {
            const fb = corridorBounds[i]!.full
            const gb = corridorBounds[i]!.geo
            return (
              <rect
                key={`z${i}`}
                className="zone"
                data-ci={i}
                style={{ ...fade, opacity: dim(i) }}
                x={fb.x0 - 26}
                y={gb.y0 - 22}
                width={fb.x1 - fb.x0 + 52}
                height={gb.y1 - gb.y0 + 44}
                rx={26}
              />
            )
          })}
          {/* tracks */}
          {net.corridors.map((c, ci) =>
            c.lines.map((l, li) => (
              <g key={l.id} data-ci={ci} style={{ ...fade, opacity: dim(ci) }}>
                {l.segs.map((sg, j) =>
                  sg.kind === 'track' ? (
                    /* the strand — a dark under-shadow lifts the colored
                       thread off the cloth, and at reading zoom a pale
                       twist runs inside it like wrapped fibers */
                    <g key={j}>
                      {!sg.inferred && <path className="tshadow" d={smooth(sg.pts)} />}
                      <path
                        className={sg.inferred ? 'track inferred' : 'track'}
                        style={{ ['--d' as string]: `${ci * 160 + li * 90}ms` }}
                        pathLength={1}
                        d={smooth(sg.pts)}
                        stroke={l.color}
                      />
                      {!sg.inferred && <path className="twist" d={smooth(sg.pts)} />}
                    </g>
                  ) : sg.kind === 'link' ? (
                    <g key={j}>
                      <path className="link" d={smooth(sg.pts)} stroke={l.color} />
                      {sg.pts.length >= 2 && (
                        <g className="overpass" pointerEvents="none">
                          {/* the returning thread lifts a loop over the
                              strand it rejoins — weave shadowed beneath */}
                          {(() => {
                            const b = sg.pts.at(-1)!
                            const a = sg.pts[0]!
                            return (
                              <>
                                <path className="op-shadow" d={`M${b.x - 9} ${b.y + 1.8} Q${b.x} ${b.y + 6.5} ${b.x + 9} ${b.y + 1.8}`} />
                                <path
                                  className="op-hump"
                                  d={`M${b.x - 14} ${b.y} Q${b.x - 9} ${b.y - 13} ${b.x} ${b.y - 13} Q${b.x + 9} ${b.y - 13} ${b.x + 14} ${b.y}`}
                                  stroke={l.color}
                                />
                                <circle className="op-dot" cx={b.x - 14} cy={b.y} r={1.7} />
                                <circle className="op-dot" cx={b.x + 14} cy={b.y} r={1.7} />
                                <circle className="op-eye" cx={a.x} cy={a.y} r={4.4} stroke={l.color} />
                              </>
                            )
                          })()}
                        </g>
                      )}
                      {sg.far && (
                        <text className="ftag" x={sg.pts.at(-1)!.x + 8} y={sg.pts.at(-1)!.y + 3} fill={l.color}>
                          ↩ {serviceName(net, l.mergeStation?.lineId)}
                        </text>
                      )}
                    </g>
                  ) : null,
                )}
              </g>
            )),
          )}
          {/* tethers — dashed threads tying a spawned session's weave to
              the knot that launched it */}
          {(tethers ?? []).map((t) => {
            const a = stationIndex.get(t.fromStationId)
            const b = stationIndex.get(t.toStationId)
            if (!a || !b) return null
            const dy = (b.y - a.y) / 2
            const path = `M${a.x} ${a.y} C${a.x} ${a.y + dy},${b.x} ${b.y - dy},${b.x} ${b.y}`
            return (
              <g key={t.id} className="tetherg">
                <path className="tether" d={path} />
                <circle className="tether-dot" cx={a.x} cy={a.y} r={2.4} />
                <circle className="tether-dot" cx={b.x} cy={b.y} r={2.4} />
                <text className="tether-lb" x={a.x + 10} y={a.y + dy * 0.55}>
                  {t.label}
                </text>
              </g>
            )
          })}
          {/* frayed ends — collapsed side-work trails off the strand */}
          {net.corridors.map((c, ci) =>
            c.works.map((w) => {
              const a = stationIndex.get(w.at.stationId)
              if (!a) return null
              const dir = a.x > w.x ? 1 : -1
              const bx = w.x + dir * 8
              const fc = lineColors.get(w.at.stationId) ?? '#8b99ad'
              return (
                <g key={w.id} className={sel === w.id ? 'works sel' : 'works'} data-ci={ci} style={{ ...fade, opacity: dim(ci) }}>
                  <path className="fray" d={`M${a.x} ${a.y} Q${(a.x + bx) / 2} ${w.y} ${bx} ${w.y - 4}`} stroke={fc} data-wid={w.id} />
                  <path className="fray" d={`M${a.x} ${a.y} Q${(a.x + bx) / 2} ${w.y} ${bx + dir * 3} ${w.y}`} stroke={fc} data-wid={w.id} />
                  <path className="fray" d={`M${a.x} ${a.y} Q${(a.x + bx) / 2} ${w.y} ${bx} ${w.y + 4}`} stroke={fc} data-wid={w.id} />
                  <rect
                    x={w.x - 9}
                    y={w.y - 9}
                    width={18}
                    height={18}
                    rx={4}
                    className="wbox"
                    data-wid={w.id}
                  />
                  <text x={w.x} y={w.y + 3.6} className="wtag" data-wid={w.id}>
                    {w.count > 9 ? '9+' : w.count}
                  </text>
                </g>
              )
            }),
          )}
          {/* knots */}
          {net.corridors.map((c, ci) =>
            c.lines.map((l, li) => (
              <g key={`st-${l.id}`} data-ci={ci} style={{ ...fade, opacity: dim(ci), ['--d' as string]: `${ci * 160 + li * 90 + 500}ms` }}>
                {l.stations.map((s) => (
                  <g key={s.id} className={`st st-${s.tier[0]}${fout?.has(s.id) ? ' fout' : ''}`} data-sid={s.id}>
                    {stationGlyph(s, l.color, sel === s.id)}
                    {/* fat invisible hit target — radius scales with --k so it
                        stays ~12px on screen when the plano is zoomed out */}
                    <circle className="hit" cx={s.x} cy={s.y} r={11} fill="transparent" data-sid={s.id} />
                  </g>
                ))}
              </g>
            )),
          )}
          {/* selection — a tied marker hanging off the knot */}
          {selStation && (
            <g className="halo">
              <circle className="halo-ring" cx={selStation.x} cy={selStation.y} r={13} />
              <circle className="halo-dot" cx={selStation.x} cy={selStation.y} r={13} />
              <g transform={`translate(${selStation.x} ${selStation.y - 13})`}>
                <g className="pin">
                  <line x1={0} y1={-2} x2={0} y2={-12} stroke="#e6dcc0" strokeWidth={1.4} />
                  <path
                    d="M-4.6 -22 a4.6 4.6 0 1 1 9.2 0 c0 3.6 -4.6 7.4 -4.6 7.4 s-4.6 -3.8 -4.6 -7.4"
                    fill={lineColors.get(selStation.id) ?? '#e6dcc0'}
                    stroke="#141419"
                    strokeWidth={1}
                  />
                  <circle cy={-22} r={1.7} fill="#141419" />
                </g>
              </g>
            </g>
          )}
          {/* twist flash at junctions the shuttle crosses */}
          <g ref={switchRef} className="ptswitch">
            <path className="swtri" d="M0 -5 L9 0 L0 5 Z" />
          </g>
          {/* the replay token — a boat shuttle: pointed ends, a hollow
              waist, and the bobbin window carries the strand's own ink */}
          <g ref={trainRef} className="shuttle" style={{ display: 'none' }}>
            <path className="strail" d="M-28 0 L-14 0" stroke="#dfa84d" strokeWidth={2.4} strokeLinecap="round" opacity={0.5} />
            <path className="strail" d="M-44 0 L-34 0" stroke="#dfa84d" strokeWidth={1.6} strokeLinecap="round" opacity={0.25} />
            <ellipse className="sglow" cx={0} cy={0} rx={22} ry={11} fill="rgba(223,168,77,0.26)" />
            <path
              className="sbody"
              d="M-18 0 C-14 -6 -7 -8 0 -8 C7 -8 14 -6 18 0 C14 6 7 8 0 8 C-7 8 -14 6 -18 0 Z"
            />
            <ellipse className="swin" cx={-1} cy={0} rx={6.6} ry={3} />
            <path className="sslot" d="M-9 -3.4 L-9 3.4 M7 -3.4 L7 3.4" />
            <circle className="stip" cx={13.5} cy={0} r={1.7} />
          </g>
          {/* the shuttle's read — the turn it's on, riding unrotated */}
          <g ref={slabelRef} className="squote" style={{ display: 'none' }}>
            <text>{(rideLabel ?? '').slice(0, 46)}</text>
          </g>
          {/* ghost shuttle — drifts the weft when nobody is looking */}
          <g ref={ghostRef} className="shuttle ghost" style={{ display: 'none' }}>
            <path
              className="sbody"
              d="M-18 0 C-14 -6 -7 -8 0 -8 C7 -8 14 -6 18 0 C14 6 7 8 0 8 C-7 8 -14 6 -18 0 Z"
            />
            <ellipse className="swin" cx={-1} cy={0} rx={6.6} ry={3} />
          </g>
          {/* labels — at reading zoom a knot earns a second line:
              the step title above, its actor and wall-clock below (or
              above, on whichever side the label hangs off the thread) */}
          {net.corridors.map((c, ci) =>
            c.labels.map((lb: Label, i) => {
              const st = stationIndex.get(lb.stationId)
              const sub = st ? `${st.step.actor} · ${clockOf(st.step.ts)}` : null
              return (
                <text
                  key={`l${i}`}
                  data-ci={ci}
                  style={{ ...fade, opacity: dim(ci) }}
                  className={`lb lb${lb.lod}${fout?.has(lb.stationId) ? ' fout' : ''}`}
                  textAnchor="middle"
                >
                  {/* sub-line hangs on the label's free side; absolute y so
                      a hidden sub never shifts the title's baseline */}
                  {sub && <tspan className="lbsub" x={lb.x} y={lb.y + (lb.side < 0 ? -12 : 12)}>{sub}</tspan>}
                  <tspan x={lb.x} y={lb.y}>
                    {lb.text}
                  </tspan>
                </text>
              )
            }),
          )}
          {/* the woven signature patch — stitched into the cloth itself
              instead of floating chrome */}
          {(() => {
            const c0 = net.corridors[0]
            const trunk = c0?.lines.find((l) => l.trunk)
            const s0 = trunk?.stations[0]
            if (!trunk || !s0) return null
            const bx = s0.x - P * 1.9 - 44 - trunk.service.length * 6.4 - 262
            const by = c0!.trunkY - U * 1.05
            return (
              <g className="headboard" data-ci={0} style={{ ...fade, opacity: dim(0) }} transform={`translate(${bx} ${by})`}>
                <line className="hb-hang" x1={30} y1={-30} x2={30} y2={0} />
                <line className="hb-hang" x1={222} y1={-30} x2={222} y2={0} />
                <rect className="hb-patch" width={252} height={78} rx={8} />
                <rect className="hb-stitch" x={5} y={5} width={242} height={68} rx={5} />
                <text className="hb-mark" x={16} y={40}>~</text>
                <text className="hb-name" x={38} y={40}>trenza</text>
                <text className="hb-sub" x={18} y={64}>agent sessions, woven · local only</text>
              </g>
            )
          })()}
          {/* selvedge name tags at each weave's left edge */}
          {net.corridors.map((c, i) => {
            const trunk = c.lines.find((l) => l.trunk)
            const s0 = trunk?.stations[0]
            if (!trunk || !s0) return null
            const bx = s0.x - P * 1.9
            const tw = Math.max(64, trunk.service.length * 6.6 + 40)
            return (
              <g key={`nb${i}`} className="nameboard" data-ci={i} style={{ ...fade, opacity: dim(i) }} transform={`translate(${bx} ${c.trunkY})`}>
                <rect className="nb-tag" x={-tw - 22} y={-10} width={tw} height={20} rx={4} />
                <rect className="nb-stitch" x={-tw - 18} y={-6.5} width={tw - 8} height={13} rx={2.5} />
                <rect x={-20} y={-10} width={20} height={20} rx={4} fill={trunk.color} />
                <text className="nb-code" x={-10} y={3.6} textAnchor="middle">
                  S{i + 1}
                </text>
                <text className="nb-name" x={-28} y={3.4} textAnchor="end">
                  {trunk.service}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
      {/* the selvedge — each session's tab stays sewn to the cloth's
          left edge as the weave pans; click to fly to its strand */}
      <div ref={selvRef} className="selv" aria-hidden={false}>
        {net.corridors.map((c, i) => {
          const trunk = c.lines.find((l) => l.trunk)
          const b = corridorBounds[i]
          if (!trunk || !b) return null
          return (
            <button
              key={c.session.id}
              className="selv-tab"
              style={{ opacity: solo === null || solo === i ? 1 : 0.25 }}
              title={`${c.session.title} — fly to strand ${i + 1}`}
              onClick={() =>
                fitTo(b.geo.x0 - 60, b.geo.y0 - 60, b.geo.x1 + 60, b.geo.y1 + 60, true)
              }
            >
              <i className="sv-notch" style={{ background: trunk.color }} />
              <i className="sv-code" style={{ background: trunk.color }}>S{i + 1}</i>
              <span className="sv-name">{trunk.service}</span>
            </button>
          )
        })}
      </div>
      {hover && !drag.current?.moved && (
        <div ref={tipRef} className="tip" style={{ left: hover.px + 14, top: hover.py - 34 }}>
          <b>{hover.s.name}</b>
          <span>
            {hover.s.step.actor} · knot {hover.s.ord + 1}
          </span>
        </div>
      )}
    </div>
  )
})

function serviceName(net: Network, lineId: string | undefined): string {
  for (const c of net.corridors) for (const l of c.lines) if (l.id === lineId) return l.trunk ? 'main' : l.service
  return 'main'
}

function clockOf(ts: number | null): string {
  if (ts == null) return '—'
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default MapView
