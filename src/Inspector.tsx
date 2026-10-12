import { useEffect, useMemo, useRef, useState } from 'react'
import type { Corridor, Line, Network, Station } from './lib/metro.ts'
import type { Step } from './lib/model.ts'
import { redactText } from './lib/redact.ts'
import { haptic } from './lib/haptics.ts'

interface Props {
  net: Network
  sel: string | null // station id or works id
  onClose: () => void
  onJump: (stationId: string) => void
  onPrevNext: (dir: 1 | -1) => void
}

const KIND_ICON: Record<string, string> = {
  message: '✉',
  reasoning: '◔',
  call: '⌘',
  result: '↵',
  meta: '·',
}

function fmt(ts: number | null) {
  if (ts == null) return 'untimed'
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function Red({ text, mono }: { text: string; mono?: boolean }) {
  const { text: out, hits } = useMemo(() => redactText(text), [text])
  return (
    <>
      {hits.length > 0 && <span className="redflag" title={`${hits.length} secret(s) patched at display`}>⟪{hits.length}⟫</span>}
      <span className={mono ? 'mono' : undefined}>{out}</span>
    </>
  )
}

function CallRow({ c }: { c: NonNullable<Step['calls']>[number] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={c.ok === false ? 'call bad' : 'call'}>
      <button className="callhead" onClick={() => setOpen(!open)} disabled={!c.args && !c.result}>
        <i className={c.ok === false ? 'dot err' : 'dot ok'} />
        <code>{c.name}</code>
        {(c.args || c.result) && <span className="chev">{open ? '▾' : '▸'}</span>}
      </button>
      {open && (
        <div className="callbody">
          {c.args && <pre><Red text={c.args} mono /></pre>}
          {c.result && <pre className="res"><Red text={c.result.slice(0, 2400)} mono /></pre>}
        </div>
      )}
    </div>
  )
}

/** mobile sheet rail — drag it up to expand, down to tuck or throw away, tap to toggle */
function Grab({ full, setFull, onSnap, onDismiss }: { full: boolean; setFull: (f: boolean) => void; onSnap?: (f: boolean) => void; onDismiss?: () => void }) {
  const moved = useRef(false)
  // a station tap can retarget its click to the freshly-mounted rail when
  // the sheet opens under the finger — only a press that began on the
  // rail itself (or a keyboard activation, detail === 0) may toggle
  const armed = useRef(false)
  return (
    <button
      className="grab"
      aria-label={full ? 'shrink details — or drag down' : 'expand details — or drag up'}
      onPointerDown={(e) => {
        const rail = e.currentTarget // kept — the synthetic event nulled later
        const sheet = rail.parentElement as HTMLElement
        const startY = e.clientY
        const startH = sheet.getBoundingClientRect().height
        moved.current = false
        armed.current = true
        rail.setPointerCapture(e.pointerId)
        sheet.classList.add('dragging') // the sheet follows the finger — no transition
        const pid = e.pointerId
        // a short trail of the gesture, for release velocity — a fast
        // downward fling throws the sheet away instead of tucking it
        const trail: { t: number; y: number }[] = [{ t: e.timeStamp, y: e.clientY }]
        const move = (ev: PointerEvent) => {
          if (ev.pointerId !== pid) return
          const dy = ev.clientY - startY
          if (Math.abs(dy) > 4) moved.current = true
          trail.push({ t: ev.timeStamp, y: ev.clientY })
          if (trail.length > 6) trail.shift()
          const h = Math.max(80, Math.min(innerHeight * 0.62, startH - dy))
          sheet.style.maxHeight = `${h}px`
          // below the compact detent the sheet telegraphs its throw-away
          sheet.classList.toggle('doomed', h < 118)
        }
        // one cleanup owns the whole gesture — whichever release arrives
        // first removes exactly the listeners this gesture registered
        const done = () => {
          removeEventListener('pointermove', move)
          removeEventListener('pointerup', up)
          removeEventListener('pointercancel', cancel)
        }
        const up = (ev: PointerEvent) => {
          if (ev.pointerId !== pid) return
          done()
          try {
            rail.releasePointerCapture(pid)
          } catch {
            /* already released */
          }
          // measure the release first, then let the detent transition animate
          const released = sheet.getBoundingClientRect().height
          sheet.style.maxHeight = ''
          sheet.classList.remove('dragging')
          sheet.classList.remove('doomed')
          if (moved.current) {
            const a = trail[0]!
            const b = trail[trail.length - 1]!
            const vy = b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0
            if (vy > 0.55 || released <= 118) {
              // flung down or held under the kill line — the sheet goes away
              onDismiss?.()
            } else {
              const next = released > innerHeight * 0.42
              setFull(next)
              if (next !== full) onSnap?.(next)
            }
          }
          // the gesture's click dispatches synchronously after pointerup —
          // keep moved/armed through it so a drag never toggles, then
          // release; if no click ever arrives, nothing stays armed
          setTimeout(() => {
            moved.current = false
            armed.current = false
          }, 0)
        }
        const cancel = (ev: PointerEvent) => {
          if (ev.pointerId !== pid) return
          done()
          try {
            rail.releasePointerCapture(pid)
          } catch {
            /* already released */
          }
          sheet.style.maxHeight = ''
          sheet.classList.remove('dragging')
          sheet.classList.remove('doomed')
          armed.current = false
          setTimeout(() => (moved.current = false), 0)
        }
        addEventListener('pointermove', move)
        addEventListener('pointerup', up)
        addEventListener('pointercancel', cancel)
      }}
      onClick={(e) => {
        // e.detail === 0 → keyboard/assistive activation, always allowed;
        // a drag's trailing click and retargeted station clicks are not
        const wasArmed = armed.current
        const wasDrag = moved.current
        armed.current = false
        if ((!wasArmed && e.detail !== 0) || wasDrag) return
        setFull(!full)
        onSnap?.(!full)
      }}
    />
  )
}

function find(net: Network, sel: string) {
  for (const c of net.corridors) {
    for (const l of c.lines) {
      const s = l.stations.find((x) => x.id === sel)
      if (s) return { kind: 'station' as const, s, line: l, corridor: c }
    }
    const w = c.works.find((x) => x.id === sel)
    if (w) return { kind: 'works' as const, w, corridor: c }
  }
  return null
}

function branchesAt(corridor: Corridor, s: Station): Line[] {
  return corridor.lines.filter((l) => l.forkStation?.stationId === s.id)
}
function mergesAt(corridor: Corridor, s: Station): Line[] {
  return corridor.lines.filter((l) => l.mergeStation?.stationId === s.id)
}

export default function Inspector({ net, sel, onClose, onJump, onPrevNext }: Props) {
  // mobile: tap the grab rail to swap compact ↔ expanded sheet heights
  const [full, setFull] = useState(false)
  const hit = sel ? find(net, sel) : null
  // a newly-opened sheet always starts compact — a previous session's
  // expanded detent must not leak into the next inspection
  const wasOpen = useRef(false)
  useEffect(() => {
    if (!hit) wasOpen.current = false
    else if (!wasOpen.current) {
      wasOpen.current = true
      setFull(false)
    }
  }, [hit])
  // dismissal exits toward its entry edge — keep the last hit mounted
  // briefly so the sheet leaves rather than vanishing
  const [ghost, setGhost] = useState<typeof hit>(null)
  useEffect(() => {
    if (hit) {
      setGhost(hit)
      return
    }
    const t = setTimeout(() => setGhost(null), 240)
    return () => clearTimeout(t)
  }, [hit])
  const shown = hit ?? ghost
  if (!shown) return null
  const cls = `inspector${full ? ' full' : ''}${hit ? '' : ' closing'}`

  if (shown.kind === 'works') {
    const w = shown.w
    return (
      <aside className={`${cls} worksheet`} aria-label="closed works detail">
        <Grab full={full} setFull={setFull} onSnap={() => haptic('nudge')} onDismiss={() => { haptic('nudge'); onClose() }} />
        <header>
          <span className="wbox-lg">{w.count > 9 ? '9+' : w.count}</span>
          <div>
            <h2><Red text={w.label} /></h2>
            <p className="sub">closed works — {w.count} step{w.count === 1 ? '' : 's'} folded off the line</p>
          </div>
          <button className="x" onClick={onClose} aria-label="close">✕</button>
        </header>
        <p className="note">Tiny offshoots — summarizer runs, dead handoffs, one-shot checks — are folded into this spur so the map stays readable. Their steps are still here:</p>
        <ol className="wsteps">
          {w.steps.slice(0, 12).map((st) => (
            <li key={st.id}><b>{st.kind}</b> <Red text={st.title ?? ''} /></li>
          ))}
          {w.steps.length > 12 && <li className="more">…and {w.steps.length - 12} more</li>}
        </ol>
      </aside>
    )
  }

  const { s, line, corridor } = shown
  const st = s.step
  const forks = branchesAt(corridor, s)
  const merges = mergesAt(corridor, s)
  const svc = line.trunk ? `S${net.corridors.indexOf(corridor) + 1}` : line.service

  return (
    <aside className={cls} aria-label="station detail">
      <Grab full={full} setFull={setFull} onSnap={() => haptic('nudge')} onDismiss={() => { haptic('nudge'); onClose() }} />
      <header>
        <span className="stopdot" style={{ borderColor: line.color }} />
        <div>
          {/* the sheet earns the full title — the 26-char map label is only for the plano */}
          <h2><Red text={st.title?.trim().replace(/^<[^>]+>\s*/, '') || s.name} /></h2>
          <p className="sub">
            stop {s.ord + 1} of {line.stations.length} · {svc}{line.trunk ? '' : ' branch'} · {fmt(st.ts)}
          </p>
        </div>
        <button className="x" onClick={onClose} aria-label="close">✕</button>
      </header>

      <div className="chips">
        <span className={`chip a-${st.actor}`}>{st.actor}</span>
        <span className="chip">{KIND_ICON[st.kind] ?? ''} {st.kind}</span>
        <span className="chip">{s.tier}</span>
        {st.tokens?.input != null && (
          <span className="chip num">{fmtTok(st.tokens.input)}{st.tokens.output ? `→${fmtTok(st.tokens.output)}` : ''} tok</span>
        )}
      </div>

      {(forks.length > 0 || merges.length > 0) && (
        <div className="xfer">
          {forks.map((l) => (
            <button key={l.id} className="xferrow" onClick={() => onJump(l.stations[0]!.id)}>
              <i style={{ background: l.color }} />
              <span><b>{l.service}</b> departs from here{l.forkStation?.inferred ? ' ≈' : ''}</span>
              <em>→</em>
            </button>
          ))}
          {merges.map((l) => (
            <button key={l.id} className="xferrow" onClick={() => onJump(l.stations[l.stations.length - 1]!.id)}>
              <i style={{ background: l.color }} />
              <span><b>{l.service}</b> returns here{l.mergeStation?.inferred ? ' ≈' : ''}</span>
              <em>←</em>
            </button>
          ))}
          {merges.some((l) => l.mergeStation?.inferred) && (
            <p className="inf">≈ inferred rejoin — the export didn’t record this merge; traza derived it from node order.</p>
          )}
        </div>
      )}

      {st.thinking && (
        <details className="think">
          <summary>thinking</summary>
          <p><Red text={st.thinking} /></p>
        </details>
      )}
      {/* a body that just repeats the title is noise — tool evidence earns the space instead */}
      {st.body && st.body.trim() !== (st.title?.trim().replace(/^<[^>]+>\s*/, '') ?? '') && (
        <div className="body"><p><Red text={st.body.slice(0, 4000)} />{st.body.length > 4000 && ' …'}</p></div>
      )}
      {st.calls?.map((c) => <CallRow key={c.id} c={c} />)}

      <footer>
        <button onClick={() => onPrevNext(-1)} disabled={s.ord === 0}>← prev stop</button>
        <button onClick={() => onPrevNext(1)} disabled={s.ord === line.stations.length - 1}>next stop →</button>
      </footer>
    </aside>
  )
}

function fmtTok(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
