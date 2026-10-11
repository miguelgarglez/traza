import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { Label, Network, Station, Works } from './lib/metro.ts'
import { P, U } from './lib/metro.ts'

export interface MapHandle {
  fit: () => void
  flyTo: (x: number, y: number, w?: number, h?: number) => void
  zoomBy: (f: number) => void
}

interface Props {
  net: Network
  sel: string | null
  onPick: (id: string | null) => void
  onPickWorks: (w: Works) => void
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

const MapView = forwardRef<MapHandle, Props>(function MapView({ net, sel, onPick, onPickWorks }, ref) {
  const svgRef = useRef<SVGSVGElement>(null)
  const worldRef = useRef<SVGGElement>(null)
  const cam = useRef({ x: 0, y: 0, k: 0.1 })
  const raf = useRef(0)
  const flight = useRef<number | null>(null)
  const [hover, setHover] = useState<{ s: Station; px: number; py: number } | null>(null)
  const drag = useRef<{ px: number; py: number; cx: number; cy: number; moved: boolean } | null>(null)
  const pinch = useRef<{ d: number; k: number } | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const reduced = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, [])

  const apply = () => {
    const g = worldRef.current
    const svg = svgRef.current
    if (!g || !svg) return
    const { x, y, k } = cam.current
    g.setAttribute('transform', `translate(${x} ${y}) scale(${k})`)
    svg.dataset.z = k < 0.18 ? 'far' : k < 0.7 ? 'mid' : 'near'
    setHover((h) => (h ? { ...h, ...toScreen(h.s.x, h.s.y) } : h))
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
  }))

  const zoomAt = (px: number, py: number, f: number) => {
    const c = cam.current
    const k = Math.min(K_MAX, Math.max(K_MIN, c.k * f))
    const { wx, wy } = toWorld(px, py)
    cam.current = { k, x: px - wx * k, y: py - wy * k }
    apply()
  }

  // initial fit once the net changes
  useEffect(() => {
    fitTo(net.bounds.x0, net.bounds.y0, net.bounds.x1, net.bounds.y1, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = svg.getBoundingClientRect()
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.006 : 0.0022))
      zoomAt(e.clientX - r.left, e.clientY - r.top, f)
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
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
      const r = svgRef.current!.getBoundingClientRect()
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
      if (!dg.moved && Math.hypot(dx, dy) > 4) dg.moved = true
      if (dg.moved) {
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

  return (
    <div className="mapwrap">
      <svg
        ref={svgRef}
        className="plano"
        role="application"
        aria-label="metro map of agent sessions — drag to pan, scroll to zoom, click a station"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerOver={onOver}
        onPointerLeave={() => setHover(null)}
      >
        <g ref={worldRef}>
          {/* zone bands behind each corridor */}
          {net.corridors.map((c, i) => (
            <rect
              key={`z${i}`}
              className="zone"
              x={net.bounds.x0 + 10}
              y={c.y0 - U * 0.45}
              width={net.bounds.x1 - net.bounds.x0 - 20}
              height={c.height - U * 0.35}
              rx={26}
            />
          ))}
          {/* tracks */}
          {net.corridors.map((c) =>
            c.lines.map((l) => (
              <g key={l.id}>
                {l.segs.map((sg, j) =>
                  sg.kind === 'track' ? (
                    <path
                      key={j}
                      className={sg.inferred ? 'track inferred' : 'track'}
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
          {net.corridors.map((c) =>
            c.works.map((w) => {
              const a = stationIndex.get(w.at.stationId)
              if (!a) return null
              return (
                <g key={w.id} className={sel === w.id ? 'works sel' : 'works'}>
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
          {net.corridors.map((c) =>
            c.lines.map((l) => (
              <g key={`st-${l.id}`}>
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
          {/* selection halo */}
          {selStation && (
            <g className="halo">
              <circle className="halo-ring" cx={selStation.x} cy={selStation.y} r={13} />
              <circle className="halo-dot" cx={selStation.x} cy={selStation.y} r={13} />
            </g>
          )}
          {/* labels */}
          {net.corridors.map((c) =>
            c.labels.map((lb: Label, i) => (
              <text
                key={`l${i}`}
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
              <g key={`nb${i}`} className="nameboard" transform={`translate(${bx} ${c.trunkY})`}>
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
        <div className="tip" style={{ left: hover.px + 14, top: hover.py - 34 }}>
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
