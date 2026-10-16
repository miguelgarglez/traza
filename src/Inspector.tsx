import { useEffect, useMemo, useRef, useState } from 'react'
import type { Corridor, Line, Network, Station } from './lib/metro.ts'
import type { ToolCall } from './lib/model.ts'
import { redactText } from './lib/redact.ts'
import { haptic } from './lib/haptics.ts'
import { argSummary, callFailed, callOutcome, stepTitle, toolKind, type ToolKind } from './lib/title.ts'

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
const TK_STYLE: Record<ToolKind, string> = {
  edit: 'edit', exec: 'exec', read: 'read', web: 'web', mcp: 'mcp', other: 'other',
}

function fmt(ts: number | null) {
  if (ts == null) return 'untimed'
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
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

/** does this text read like a diff? unified hunks or old/new string pairs */
function looksDiffy(t: string): boolean {
  const lines = t.split('\n')
  let plus = 0
  let minus = 0
  for (const l of lines) {
    if (l.startsWith('+') && !l.startsWith('+++')) plus++
    else if (l.startsWith('-') && !l.startsWith('---')) minus++
  }
  return plus + minus >= 3 && /(^|\n)@@[^\n]*@@|^(---|\+\+\+) /m.test(t)
}

/** pull old/new string pairs out of an edit call's args → pseudo-diff */
function editPair(args: string): { oldT: string; newT: string } | null {
  try {
    const o = JSON.parse(args) as Record<string, unknown>
    const oldK = ['old_string', 'old_str', 'old_text', 'before', 'old'].find((k) => typeof o[k] === 'string')
    const newK = ['new_string', 'new_str', 'new_text', 'after', 'new'].find((k) => typeof o[k] === 'string')
    if (oldK && newK) return { oldT: o[oldK] as string, newT: o[newK] as string }
  } catch {
    /* not json */
  }
  return null
}

/** diff-aware block: +/− lines tinted, hunk headers blued */
function DiffBlock({ text, cap = 2400 }: { text: string; cap?: number }) {
  const shown = text.slice(0, cap)
  const lines = shown.split('\n')
  return (
    <pre className="block">
      {lines.map((l, i) => {
        const cls =
          l.startsWith('+') && !l.startsWith('+++') ? 'dl-plus' : l.startsWith('-') && !l.startsWith('---') ? 'dl-minus' : l.startsWith('@@') ? 'dl-hunk' : ''
        return cls ? (
          <span key={i} className={cls}>
            {l}
            {'\n'}
          </span>
        ) : (
          l + '\n'
        )
      })}
      {text.length > cap ? `… ${text.length - cap} more chars` : null}
    </pre>
  )
}

function CallRow({ c, resultStationId, onJump }: { c: ToolCall; resultStationId?: string; onJump?: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const failed = callFailed(c)
  const pair = c.args ? editPair(c.args) : null
  const diffy = (c.args && looksDiffy(c.args)) || (c.result && looksDiffy(c.result))
  const summary = argSummary(c)
  const out = callOutcome(c)
  return (
    <div className={failed ? 'call bad' : 'call'}>
      <button className="callhead" onClick={() => setOpen(!open)} disabled={!c.args && !c.result}>
        <i className={failed ? 'dot err' : 'dot ok'} />
        <code>
          {c.name}
          {summary ? <span style={{ color: 'var(--faint)' }}> {summary}</span> : null}
        </code>
        {out && <span className="chip err" style={{ marginLeft: 4 }}>{out}</span>}
        {(c.args || c.result) && <span className="chev">{open ? '▾' : '▸'}</span>}
      </button>
      {open && (
        <div className="callbody">
          {pair ? (
            <>
              <div className="iseclbl open"><span>edit</span></div>
              <pre className="block">
                {pair.oldT.split('\n').slice(0, 40).map((l, i) => (
                  <span key={`o${i}`} className="dl-minus">-{l}{'\n'}</span>
                ))}
                {pair.newT.split('\n').slice(0, 40).map((l, i) => (
                  <span key={`n${i}`} className="dl-plus">+{l}{'\n'}</span>
                ))}
              </pre>
            </>
          ) : c.args ? (
            diffy ? (
              <DiffBlock text={c.args} />
            ) : (
              <pre className="block"><Red text={c.args} mono /></pre>
            )
          ) : null}
          {c.result ? (
            <>
              <div className="iseclbl open"><span>result</span></div>
              {looksDiffy(c.result) ? (
                <DiffBlock text={c.result} />
              ) : (
                <pre className="block"><Red text={c.result.slice(0, 2400)} mono />{c.result.length > 2400 ? ' …' : null}</pre>
              )}
            </>
          ) : resultStationId && onJump ? (
            <button className="calllink" onClick={() => onJump(resultStationId)}>
              the result lands at the next knot ↗
            </button>
          ) : null}
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
  // memoized — find() returns a fresh object every call and effects below
  // key on it; an unstable hit is an infinite setState loop
  const hit = useMemo(() => (sel ? find(net, sel) : null), [net, sel])
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
  // elapsed since the previous step on this thread
  const prev = line.stations[s.ord - 1]?.step
  const elapsed = st.ts != null && prev?.ts != null ? st.ts - prev.ts : null
  const turn = s.turnIdx != null ? line.turns[s.turnIdx] : undefined
  const kinds = [...new Set((st.calls ?? []).map((c) => toolKind(c.name)))]
  const failed = (st.calls ?? []).some(callFailed)
  // a call step with unanswered calls links to the next station if it carries the result
  const next = line.stations[s.ord + 1]
  const nextIsResult = next?.step.kind === 'result' || next?.step.actor === 'tool'
  const callLink = (c: ToolCall) => (!c.result && nextIsResult ? next!.id : undefined)

  return (
    <aside className={cls} aria-label="station detail">
      <Grab full={full} setFull={setFull} onSnap={() => haptic('nudge')} onDismiss={() => { haptic('nudge'); onClose() }} />
      <header>
        <span className="stopdot" style={{ borderColor: line.color }} />
        <div>
          <h2><Red text={stepTitle(st) || s.name} /></h2>
          <p className="sub">
            {turn ? `turn ${s.turnIdx! + 1} of ${line.turns.length} · ` : ''}
            knot {s.ord + 1} of {line.stations.length} · {svc}{line.trunk ? '' : ' strand'} · {fmt(st.ts)}
            {elapsed != null && elapsed >= 0 ? ` · +${fmtDur(elapsed)}` : ''}
          </p>
        </div>
        <button className="x" onClick={onClose} aria-label="close">✕</button>
      </header>

      <div className="chips">
        <span className={`chip a-${st.actor}`}>{st.actor}</span>
        <span className="chip">{KIND_ICON[st.kind] ?? ''} {st.kind}</span>
        {kinds.map((k) => (
          <span key={k} className={`chip tk-${TK_STYLE[k]}`}>{k}</span>
        ))}
        {failed && <span className="chip err">failed</span>}
        {st.tokens?.input != null && (
          <span className="chip num">{fmtTok(st.tokens.input)}{st.tokens.output ? `→${fmtTok(st.tokens.output)}` : ''} tok</span>
        )}
      </div>

      {(forks.length > 0 || merges.length > 0) && (
        <div className="xfer">
          {forks.map((l) => (
            <button key={l.id} className="xferrow" onClick={() => onJump(l.stations[0]!.id)}>
              <i style={{ background: l.color }} />
              <span><b>{l.service}</b> unthreads here{l.forkStation?.inferred ? ' ≈' : ''}</span>
              <em>→</em>
            </button>
          ))}
          {merges.map((l) => (
            <button key={l.id} className="xferrow" onClick={() => onJump(l.stations[l.stations.length - 1]!.id)}>
              <i style={{ background: l.color }} />
              <span><b>{l.service}</b> rejoins here{l.mergeStation?.inferred ? ' ≈' : ''}</span>
              <em>←</em>
            </button>
          ))}
          {merges.some((l) => l.mergeStation?.inferred) && (
            <p className="inf">≈ inferred rejoin — the export didn’t record this merge; trenza derived it from node order.</p>
          )}
        </div>
      )}

      {st.thinking && (
        <details className="isec">
          <summary className="iseclbl"><span className="chev">▸</span>reasoning</summary>
          <div className="think"><p><Red text={st.thinking} /></p></div>
        </details>
      )}
      {/* a body that just repeats the title is noise — tool evidence earns the space instead */}
      {st.body && st.body.trim() !== (st.title?.trim().replace(/^<[^>]+>\s*/, '') ?? '') && (
        <div className="body"><p><Red text={st.body.slice(0, 4000)} />{st.body.length > 4000 && ' …'}</p></div>
      )}
      {st.calls && st.calls.length > 0 && (
        <div className="iseclbl open"><span>tool calls <b className="cnt">· {st.calls.length}</b></span></div>
      )}
      {st.calls?.map((c) => <CallRow key={c.id} c={c} resultStationId={callLink(c)} onJump={onJump} />)}
      {st.kind === 'result' && s.ord > 0 && (
        <button className="calllink" onClick={() => onJump(line.stations[s.ord - 1]!.id)}>
          ↩ the call that produced this
        </button>
      )}

      <footer>
        <button onClick={() => onPrevNext(-1)} disabled={s.ord === 0}>← prev knot</button>
        <button onClick={() => onPrevNext(1)} disabled={s.ord === line.stations.length - 1}>next knot →</button>
      </footer>
    </aside>
  )
}

function fmtTok(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
