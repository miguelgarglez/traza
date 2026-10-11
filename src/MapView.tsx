import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { Label, Network, Station, Works } from './lib/metro.ts'
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
  /** the idle ghost service — a dim train drifting the trunk */
  setGhost: (x: number, y: number, angle: number, visible: boolean, color?: string) => void
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
  /** fired once per gesture when the user drags the plano (first-run guide) */
  onUserPan?: () => void
}

const K_MIN = 0.02
const K_MAX = 8

const d = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')

function stationGlyph(s: Station, color: string, sel: boolean) {
  if (s.tier === 'terminus')
    return (
      <g key={s.id}>
        <circle cx={s.x} cy={s.y} r={6} fill="#fff" stroke={color} strokeWidth={3.6} />
        {sel && <circle cx={s.x} cy={s.y} r={3} fill={color} />}
      </g>
    )
  if (s.tier === 'interchange')
    return (
      <g key={s.id}>
        <circle cx={s.x} cy={s.y} r={7} fill="#fff" stroke="#1C2733" strokeWidth={2.4} />
        <circle cx={s.x} cy={s.y} r={2.8} fill={color} />
      </g>
    )
  if (s.tier === 'major') return <circle key={s.id} cx={s.x} cy={s.y} r={4.4} fill="#fff" stroke={color} strokeWidth={2.6} />
  return <circle key={s.id} cx={s.x} cy={s.y} r={2.3} fill={color} />
}

const MapView = forwardRef<MapHandle, Props>(function MapView({ net, sel, onPick, onPickWorks, riding, solo, onUserPan }, ref) {
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
  const drag = useRef<{ px: number; py: number; cx: number; cy: number; moved: boolean; panning?: boolean } | null>(null)
  const pinch = useRef<{ d: number; k: number } | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const reduced = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, [])

  const apply = () => {
    const g = worldRef.current
    const svg = svgRef.current
    if (!g || !svg) return
    const { x, y, k } = cam.current
    // translation on the svg element → pure compositing during pans;
    // scale stays on the world group so vectors re-raster crisp only on zoom
    svg.style.transform = `translate(${x}px, ${y}px)`
    g.setAttribute('transform', `scale(${k})`)
    svg.dataset.z = k < 0.18 ? 'far' : k < 0.7 ? 'mid' : 'near'
    // reposition the tip imperatively — a setState here would re-render
    // the whole network every camera frame
    const h = hoverRef.current
    if (h && tipRef.current) {
      const { px, py } = toScreen(h.s.x, h.s.y)
      tipRef.current.style.left = `${px + 14}px`
      tipRef.current.style.top = `${py - 34}px`
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

  const fitTo = (x0: number, y0: number, x1: number, y1: number, animate = false) => {
    const svg = svgRef.current
    if (!svg) return
    const r = svg.getBoundingClientRect()
    const w = Math.max(1, x1 - x0)
    const h = Math.max(1, y1 - y0)
    const k = Math.min(r.width / w, r.height / h, K_MAX) * 0.92
    const tx = r.width / 2 - ((x0 + x1) / 2) * k
    const ty = r.height / 2 - ((y0 + y1) / 2) * k
    const target = { x: tx, y: ty, k: Math.max(K_MIN, k) }
    if (!animate || reduced) {
      cam.current = target
      apply()
      return
    }
    if (flight.current != null) cancelAnimationFrame(flight.current)
    const from = { ...cam.current }
    const t0 = performance.now()
    const dur = 620
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur)
      const e = 1 - Math.pow(1 - p, 3)
      cam.current = {
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        k: from.k * Math.pow(target.k / from.k, e),
      }
      apply()
      if (p < 1) flight.current = requestAnimationFrame(step)
      else flight.current = null
    }
    flight.current = requestAnimationFrame(step)
  }

  useImperativeHandle(ref, () => ({
    fit: () => fitTo(net.bounds.x0, net.bounds.y0, net.bounds.x1, net.bounds.y1, false),
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
      const r = svg.getBoundingClientRect()
      const { px, py } = toScreen(wx, wy)
      const mx = r.width * 0.18
      const my = r.height * 0.2
      // an open inspector reserves the right edge — the followed station
      // should stay visible beside it, not slide underneath
      const rightPad = sel ? Math.min(340, r.width * 0.3) : 0
      let tx = 0
      let ty = 0
      if (px < mx) tx = mx - px
      else if (px > r.width - mx - rightPad) tx = r.width - mx - rightPad - px
      if (py < my) ty = my - py
      else if (py > r.height - my) ty = r.height - my - py
      if (tx || ty) {
        cam.current.x += tx * 0.12 // eased follow — never snaps
        cam.current.y += ty * 0.12
        apply()
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
    setGhost: (wx, wy, angle, visible, color) => {
      const g = ghostRef.current
      if (!g) return
      g.setAttribute('transform', `translate(${wx} ${wy}) rotate(${angle})`)
      g.style.display = visible ? '' : 'none'
      if (color) g.style.setProperty('--train', color)
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
  // Open on the first service — the whole network is a zoom-out away ('f').
  useEffect(() => {
    const b = corridorBounds[0] ?? net.bounds
    fitTo(b.x0 - 30, b.y0 - U * 0.7, b.x1 + 30, b.y1 + U * 0.7, false)
    setFresh(!reduced)
    const t = setTimeout(() => setFresh(false), 2600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    let panIdle: ReturnType<typeof setTimeout> | undefined
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      svg.dataset.pan = '1'
      clearTimeout(panIdle)
      panIdle = setTimeout(() => delete svg.dataset.pan, 160)
      // measure the untransformed wrap — the svg element itself is CSS-
      // translated by the camera, so its rect already contains the offset
      const r = (svg.parentElement ?? svg).getBoundingClientRect()
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.006 : 0.0022))
      zoomAt(e.clientX - r.left, e.clientY - r.top, f)
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    // a gesture always wins over a camera flight — nothing fights the hand
    if (flight.current != null) { cancelAnimationFrame(flight.current); flight.current = null }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }]
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), k: cam.current.k }
      drag.current = null
    } else {
      drag.current = { px: e.clientX, py: e.clientY, cx: cam.current.x, cy: cam.current.y, moved: false }
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }]
      const nd = Math.hypot(a.x - b.x, a.y - b.y)
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
      const t = e.target as Element
      const sid = t.getAttribute?.('data-sid')
      const wid = t.getAttribute?.('data-wid')
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

  // per-corridor extents — zones hug their service, not the whole map
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
      const trunk = c.lines.find((l) => l.trunk)
      const s0 = trunk?.stations[0]
      if (trunk && s0) x0 = Math.min(x0, s0.x - P * 1.9 - 40 - trunk.service.length * 6.4)
      if (!isFinite(x0)) return { x0: 0, y0: c.y0, x1: 400, y1: c.y0 + c.height }
      return { x0, y0, x1, y1 }
    })
  }, [net])

  // indexes
  const { stationIndex, worksIndex } = useMemo(() => {
    const si = new Map<string, Station>()
    const wi = new Map<string, Works>()
    for (const c of net.corridors) {
      for (const l of c.lines) for (const s of l.stations) si.set(s.id, s)
      for (const w of c.works) wi.set(w.id, w)
    }
    return { stationIndex: si, worksIndex: wi }
  }, [net])

  const selStation = sel ? stationIndex.get(sel) : undefined
  const dim = (ci: number): number | undefined => (solo === null || solo === ci ? undefined : 0.13)
  const fade = { transition: 'opacity .25s' } as const

  return (
    <div className="mapwrap">
      <svg
        ref={svgRef}
        className={`plano${riding ? ' riding' : ''}${fresh ? ' fresh' : ''}`}
        role="application"
        aria-label="metro map of agent sessions — drag to pan, scroll to zoom, click a station"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerOver={onOver}
        onPointerLeave={() => setHover(null)}
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
          {/* zone bands behind each corridor */}
          {net.corridors.map((c, i) => (
            <rect
              key={`z${i}`}
              className="zone"
              data-ci={i}
              style={{ ...fade, opacity: dim(i) }}
              x={corridorBounds[i]!.x0 - 26}
              y={c.y0 - U * 0.45}
              width={corridorBounds[i]!.x1 - corridorBounds[i]!.x0 + 52}
              height={c.height - U * 0.35}
              rx={26}
            />
          ))}
          {/* tracks */}
          {net.corridors.map((c, ci) =>
            c.lines.map((l, li) => (
              <g key={l.id} data-ci={ci} style={{ ...fade, opacity: dim(ci) }}>
                {l.segs.map((sg, j) =>
                  sg.kind === 'track' ? (
                    <path
                      key={j}
                      className={sg.inferred ? 'track inferred' : 'track'}
                      style={{ ['--d' as string]: `${ci * 160 + li * 90}ms` }}
                      pathLength={1}
                      d={d(sg.pts)}
                      stroke={l.color}
                    />
                  ) : sg.kind === 'link' ? (
                    <g key={j}>
                      <path className="link" d={d(sg.pts)} stroke={l.color} />
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
          {/* works spurs */}
          {net.corridors.map((c, ci) =>
            c.works.map((w) => {
              const a = stationIndex.get(w.at.stationId)
              if (!a) return null
              return (
                <g key={w.id} className={sel === w.id ? 'works sel' : 'works'} data-ci={ci} style={{ ...fade, opacity: dim(ci) }}>
                  <path
                    className="stub"
                    d={`M${a.x} ${a.y} L${w.x + (a.x > w.x ? 8 : -8)} ${w.y}`}
                    data-wid={w.id}
                  />
                  <rect
                    x={w.x - 9}
                    y={w.y - 9}
                    width={18}
                    height={18}
                    rx={4}
                    className="wbox"
                    data-wid={w.id}
                  />
                  <text x={w.x} y={w.y + 3.6} className="wnum" data-wid={w.id}>
                    {w.count > 9 ? '9+' : w.count}
                  </text>
                </g>
              )
            }),
          )}
          {/* stations */}
          {net.corridors.map((c, ci) =>
            c.lines.map((l, li) => (
              <g key={`st-${l.id}`} data-ci={ci} style={{ ...fade, opacity: dim(ci), ['--d' as string]: `${ci * 160 + li * 90 + 500}ms` }}>
                {l.stations.map((s) => (
                  <g key={s.id} className={`st st-${s.tier[0]}`} data-sid={s.id}>
                    {stationGlyph(s, l.color, sel === s.id)}
                    {/* fat invisible hit target */}
                    <circle cx={s.x} cy={s.y} r={11} fill="transparent" data-sid={s.id} />
                  </g>
                ))}
              </g>
            )),
          )}
          {/* selection halo + you-are-here pin */}
          {selStation && (
            <g className="halo">
              <circle className="halo-ring" cx={selStation.x} cy={selStation.y} r={13} />
              <circle className="halo-dot" cx={selStation.x} cy={selStation.y} r={13} />
              <g transform={`translate(${selStation.x} ${selStation.y - 13})`}>
                <g className="pin">
                  <path d="M0 0 C-5 -7 -7 -10 -7 -13 A7 7 0 1 1 7 -13 C7 -10 5 -7 0 0Z" fill="#E2001A" />
                  <circle cy={-13} r={2.6} fill="#fff" />
                </g>
              </g>
            </g>
          )}
          {/* points-throw flash at junctions the train crosses */}
          <g ref={switchRef} className="ptswitch">
            <path className="swtri" d="M0 -5 L9 0 L0 5 Z" />
          </g>
          {/* the ride token — a little metro car riding the track */}
          <g ref={trainRef} className="train" style={{ display: 'none' }}>
            <path className="beam" d="M14 -4 L64 -16 L64 16 L14 4 Z" />
            <circle className="pool" cx={34} cy={0} r={13} />
            <rect className="car" x={-15} y={-7} width={30} height={14} rx={7} />
            <rect className="win" x={-8} y={-3.4} width={7} height={6.8} rx={2} />
            <rect className="win" x={1} y={-3.4} width={7} height={6.8} rx={2} />
            <circle className="head" cx={15} cy={0} r={2.6} />
          </g>
          {/* ghost service — drifts the trunk when nobody is looking */}
          <g ref={ghostRef} className="train ghost" style={{ display: 'none' }}>
            <rect className="car" x={-15} y={-7} width={30} height={14} rx={7} />
            <rect className="win" x={-8} y={-3.4} width={7} height={6.8} rx={2} />
            <rect className="win" x={1} y={-3.4} width={7} height={6.8} rx={2} />
          </g>
          {/* labels */}
          {net.corridors.map((c, ci) =>
            c.labels.map((lb: Label, i) => (
              <text
                key={`l${i}`}
                data-ci={ci}
                style={{ ...fade, opacity: dim(ci) }}
                className={`lb lb${lb.lod}`}
                x={lb.x}
                y={lb.y}
                textAnchor={lb.side < 0 ? 'start' : 'end'}
                transform={`rotate(-35 ${lb.x} ${lb.y})`}
              >
                {lb.text}
              </text>
            )),
          )}
          {/* service nameboards at each trunk's left terminus */}
          {net.corridors.map((c, i) => {
            const trunk = c.lines.find((l) => l.trunk)
            const s0 = trunk?.stations[0]
            if (!trunk || !s0) return null
            const bx = s0.x - P * 1.9
            return (
              <g key={`nb${i}`} className="nameboard" data-ci={i} style={{ ...fade, opacity: dim(i) }} transform={`translate(${bx} ${c.trunkY})`}>
                <rect x={-22} y={-11} width={22} height={22} rx={5} fill={trunk.color} />
                <text className="nb-code" x={-11} y={4} textAnchor="middle">
                  S{i + 1}
                </text>
                <text className="nb-name" x={-30} y={4.5} textAnchor="end">
                  {trunk.service}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
      {hover && !drag.current?.moved && (
        <div ref={tipRef} className="tip" style={{ left: hover.px + 14, top: hover.py - 34 }}>
          <b>{hover.s.name}</b>
          <span>
            {hover.s.step.actor} · stop {hover.s.ord + 1}
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

export default MapView
