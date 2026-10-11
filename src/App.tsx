import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ingest, type DroppedFile } from './lib/parse/ingest.ts'
import { buildNetwork, type Network, type Station, type Works } from './lib/metro.ts'
import { buildRide, legPoint, type Ride } from './lib/ride.ts'
import type { Weave } from './lib/model.ts'
import { filesFromDrop, filesFromInput, loadDemo } from './lib/files.ts'
import MapView, { type MapHandle } from './MapView.tsx'
import Inspector from './Inspector.tsx'

type Status = 'boot' | 'ready' | 'empty' | 'lineclosed'

export default function App() {
  const [weave, setWeave] = useState<Weave | null>(null)
  const [files, setFiles] = useState<DroppedFile[]>([])
  const [status, setStatus] = useState<Status>('boot')
  const [busy, setBusy] = useState<string | null>('surveying the export…')
  const [sel, setSel] = useState<string | null>(null)
  const [keyOpen, setKeyOpen] = useState(true)
  const [srcOpen, setSrcOpen] = useState(false)
  const [hint, setHint] = useState(false)
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
  const reduced = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, [])

  const ride: Ride | null = useMemo(
    () => (net && net.corridors.length ? buildRide(net, Math.min(svcIdx, net.corridors.length - 1)) : null),
    [net, svcIdx],
  )

  // reset ride when the network or service changes
  useEffect(() => {
    rideRef.current = { leg: 0, dist: 0, dwell: 0 }
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
      const leg = ride.legs[rp.leg]
      if (!leg) {
        setPlaying(false)
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
      if (rp.dist >= leg.len) {
        // arrived at leg.stop
        rp.leg += 1
        rp.dist = 0
        rp.dwell = 150
        const arrived = leg.stop
        setSel(arrived.kind === 'station' ? arrived.id : null)
        setRideUi({
          stop: rp.leg + 1,
          total: ride.stops.length,
          name: arrived.name,
          next: ride.legs[rp.leg]?.stop.name ?? 'terminus',
        })
        map.current?.setTrain(arrived.x, arrived.y, 0, true, lineColorOf(net, arrived.lineId))
        map.current?.keepInView(arrived.x, arrived.y)
        try {
          navigator.vibrate?.(6)
        } catch {
          /* not supported */
        }
        if (rp.leg >= ride.legs.length) {
          setPlaying(false)
          return
        }
      } else {
        const p = legPoint(leg, rp.dist)
        map.current?.setTrain(p.x, p.y, p.angle, true, lineColorOf(net, leg.stop.lineId))
        map.current?.keepInView(p.x, p.y)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, ride, speed, reduced, net])

  const rideTo = useCallback(
    (stopIdx: number) => {
      if (!ride || !ride.stops.length) return
      const k = Math.max(0, Math.min(ride.stops.length - 1, stopIdx))
      rideRef.current = { leg: Math.min(k, ride.legs.length - 1), dist: 0, dwell: 0 }
      const stop = ride.stops[k]!
      setSel(stop.kind === 'station' ? stop.id : null)
      setRideUi({ stop: k + 1, total: ride.stops.length, name: stop.name, next: ride.stops[k + 1]?.name ?? 'terminus' })
      map.current?.setTrain(stop.x, stop.y, 0, true, lineColorOf(net, stop.lineId))
      map.current?.flyTo(stop.x, stop.y, 700, 420)
    },
    [ride, net],
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

  useEffect(() => {
    try {
      setHint(!localStorage.getItem('traza-seen'))
    } catch {
      setHint(true)
    }
  }, [])
  const seen = () => {
    setHint(false)
    try {
      localStorage.setItem('traza-seen', '1')
    } catch {
      /* private mode */
    }
  }

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
      seen()
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
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return
      const k = e.key
      if (k === 'ArrowLeft') (e.preventDefault(), stepAlong(-1))
      else if (k === 'ArrowRight') (e.preventDefault(), stepAlong(1))
      else if (k === 'ArrowDown') (e.preventDefault(), switchLine(1))
      else if (k === 'ArrowUp') (e.preventDefault(), switchLine(-1))
      else if (k === 'Escape') setSel(null)
      else if (k === 'f' || k === '0') map.current?.fit()
      else if (k === '+' || k === '=') map.current?.zoomBy(1.5)
      else if (k === '-') map.current?.zoomBy(1 / 1.5)
      else if (k === 'o') filePick.current?.click()
      else if (k === ' ') {
        e.preventDefault()
        if (ride?.legs.length) setPlaying((p) => !p)
      } else if (k === '[' && ride) rideTo((rideUi?.stop ?? 1) - 1)
      else if (k === ']' && ride) rideTo((rideUi?.stop ?? 0) + 1)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [stepAlong, switchLine, ride, rideUi, rideTo])

  const stats = weave?.stats
  const demoLoaded = files.some((f) => f.path.startsWith('demo/'))

  return (
    <main
      className={net ? 'stage hasnet' : 'stage'}
      onPointerDown={hint ? seen : undefined}
      onWheel={hint ? seen : undefined}
    >
      {net && (
        <MapView
          ref={map}
          net={net}
          sel={sel}
          onPick={(id) => (setSel(id), id && seen())}
          onPickWorks={(w: Works) => setSel(w.id)}
        />
      )}

      {/* title block — cartographer's imprint, top right */}
      <header className="titleblock">
        <h1>traza</h1>
        <p>the metro map of your agent sessions</p>
        <span className="localpill">local only · nothing leaves this machine</span>
      </header>

      {/* key — service legend, bottom left */}
      {net && (
        <section className={keyOpen ? 'key' : 'key shut'} aria-label="service key">
          <button className="keyhead" onClick={() => setKeyOpen(!keyOpen)}>
            <b>key</b>
            <span>{net.stats.stations} stops · {net.stats.lines} lines{net.stats.works ? ` · ${net.stats.works} works` : ''}</span>
            <i>{keyOpen ? '▾' : '▴'}</i>
          </button>
          {keyOpen && (
            <div className="keybody">
              {net.corridors.map((c, i) => {
                const trunk = c.lines.find((l) => l.trunk)
                const branchN = c.lines.length - 1
                return (
                  <button
                    key={c.session.id}
                    className="svc"
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
        <section className="dock" aria-label="ride controls">
          <div className="svcpick">
            <button aria-label="previous service" onClick={() => setSvcIdx((i) => (i - 1 + net.corridors.length) % net.corridors.length)}>‹</button>
            <i className="svcchip" style={{ background: net.corridors[ride.corridorIdx]?.lines.find((l) => l.trunk)?.color }}>
              S{ride.corridorIdx + 1}
            </i>
            <button aria-label="next service" onClick={() => setSvcIdx((i) => (i + 1) % net.corridors.length)}>›</button>
          </div>
          <button className="skip" aria-label="previous stop" onClick={() => rideTo(rideUi.stop - 2)} disabled={rideUi.stop <= 1}>|◀</button>
          <button
            className={playing ? 'play on' : 'play'}
            onClick={() => {
              if (!playing && rideRef.current.leg >= ride.legs.length) rideTo(0)
              setPlaying(!playing)
            }}
            aria-label={playing ? 'pause the ride' : 'ride the line'}
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <button className="skip" aria-label="next stop" onClick={() => rideTo(rideUi.stop)} disabled={rideUi.stop >= rideUi.total}>▶|</button>
          <div className="rideinfo">
            <b>{rideUi.name}</b>
            <div className="rideprog" aria-hidden>
              <i style={{ width: `${(rideUi.stop / rideUi.total) * 100}%` }} />
            </div>
            <span>
              stop {rideUi.stop} of {rideUi.total} · next {rideUi.next}
            </span>
          </div>
          <div className="speeds">
            {[1, 2, 4].map((s) => (
              <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>
                {s}×
              </button>
            ))}
          </div>
        </section>
      )}

      {net && <Inspector net={net} sel={sel} onClose={() => setSel(null)} onJump={jump} onPrevNext={stepAlong} />}

      {hint && net && (
        <div className="hint" role="note">
          <b>first ride</b> drag to pan · scroll to zoom · click a station · ←→ ride the line
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
