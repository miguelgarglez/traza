import { useMemo, useRef, useState } from 'react'
import type { Corridor, Line, Network, Station } from './lib/metro.ts'
import type { Step } from './lib/model.ts'
import { redactText } from './lib/redact.ts'

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

/** mobile sheet rail — drag it up to expand, down to tuck, tap to toggle */
function Grab({ full, setFull }: { full: boolean; setFull: (f: boolean) => void }) {
  const moved = useRef(false)
  return (
    <button
      className="grab"
      aria-label={full ? 'shrink details — or drag down' : 'expand details — or drag up'}
      onPointerDown={(e) => {
        const sheet = e.currentTarget.parentElement as HTMLElement
        const startY = e.clientY
        const startH = sheet.getBoundingClientRect().height
        moved.current = false
        e.currentTarget.setPointerCapture(e.pointerId)
        const move = (ev: PointerEvent) => {
          const dy = ev.clientY - startY
          if (Math.abs(dy) > 4) moved.current = true
          sheet.style.maxHeight = `${Math.max(130, Math.min(innerHeight * 0.62, startH - dy))}px`
        }
        const up = () => {
          e.currentTarget.releasePointerCapture(e.pointerId)
          removeEventListener('pointermove', move)
          sheet.style.maxHeight = ''
          if (moved.current) setFull(sheet.getBoundingClientRect().height > innerHeight * 0.42)
        }
        addEventListener('pointermove', move)
        addEventListener('pointerup', up, { once: true })
      }}
      onClick={() => {
        if (!moved.current) setFull(!full)
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
  if (!hit) return null

  if (hit.kind === 'works') {
    const w = hit.w
    return (
      <aside className={`inspector${full ? ' full' : ''}`} aria-label="closed works detail">
        <Grab full={full} setFull={setFull} />
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

  const { s, line, corridor } = hit
  const st = s.step
  const forks = branchesAt(corridor, s)
  const merges = mergesAt(corridor, s)
  const svc = line.trunk ? `S${net.corridors.indexOf(corridor) + 1}` : line.service

  return (
    <aside className={`inspector${full ? ' full' : ''}`} aria-label="station detail">
      <Grab full={full} setFull={setFull} />
      <header>
        <span className="stopdot" style={{ borderColor: line.color }} />
        <div>
          <h2><Red text={s.name} /></h2>
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
      {st.body && (
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
