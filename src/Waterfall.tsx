import { useMemo } from 'react'
import type { Corridor, Station } from './lib/metro.ts'
import type { Session, Step, Thread } from './lib/model.ts'
import { callFailed, stepTitle, toolKind } from './lib/title.ts'

// Waterfall — "time on the loom". Lanes per thread, bars by real elapsed
// duration; the longest spans are flagged and idle gaps are folded so an
// overnight session still reads. Clicking a bar lands on its knot; the
// ride's playhead runs down through every lane in sync.

interface Props {
  corridor: Corridor
  sel: string | null
  /** wall-clock ms of the ride's current stop — the playhead */
  playhead: number | null
  onPick: (stationId: string) => void
  onClose: () => void
}

const LANE_H = 24
const PAD_L = 128
const PAD_T = 26
const PAD_R = 18
const GAP = 30_000 // real ms; longer idles fold into a 26px break
const FOLD = 26

interface Lane {
  thread: Thread
  color: string
  bars: { step: Step; x: number; w: number; dur: number; failed: boolean; inferred: boolean }[]
}

const hhmm = (ts: number, secs = false) => {
  const d = new Date(ts)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return secs ? `${hm}:${String(d.getSeconds()).padStart(2, '0')}` : hm
}
const durStr = (ms: number) => {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

export default function Waterfall({ corridor, sel, playhead, onPick, onClose }: Props) {
  const session: Session = corridor.session

  // step id -> station for jumping to the knot
  const stationByStep = useMemo(() => {
    const m = new Map<string, Station>()
    for (const l of corridor.lines) for (const s of l.stations) m.set(s.step.id, s)
    return m
  }, [corridor])

  const { lanes, w, ticks, t0, t1, folded, secTicks, toX } = useMemo(() => {
    // gather every timed step to build the compressed time axis
    const allTs: number[] = []
    for (const t of session.threads) for (const s of t.steps) if (s.ts != null) allTs.push(s.ts)
    allTs.sort((a, b) => a - b)
    const t0 = allTs[0] ?? session.start ?? 0
    const t1 = allTs.at(-1) ?? session.end ?? t0

    // break points: real gaps > GAP fold into FOLD px
    const bounds = [t0]
    for (let i = 1; i < allTs.length; i++) {
      if (allTs[i]! - allTs[i - 1]! > GAP) {
        bounds.push(allTs[i - 1]! + 1) // end of fold
        bounds.push(allTs[i]! - 1) // resume
      }
    }
    bounds.push(t1)
    // map ts -> x on the compressed axis. Scale adapts: a short session
    // fills the drawer instead of scrolling its lanes off-screen; a long
    // one keeps the full 0.12 px/ms density and scrolls.
    const compMs = bounds.reduce((acc, _b, i) => (i % 2 ? acc + (bounds[i]! - bounds[i - 1]!) : acc), 0)
    const avail = Math.max(560, innerWidth - PAD_L - PAD_R - 40)
    const SCALE = Math.min(0.12, avail / Math.max(1, compMs))
    const marks: { a: number; b: number; x0: number; x1: number }[] = []
    let x = PAD_L
    for (let i = 0; i + 1 < bounds.length; i += 2) {
      const a = bounds[i]!
      const b = bounds[i + 1]!
      const span = Math.max(0, b - a)
      marks.push({ a, b, x0: x, x1: x + span * SCALE })
      x += span * SCALE
      if (i + 2 < bounds.length) x += FOLD
    }
    const ts2x = (ts: number) => {
      for (const m of marks) {
        if (ts <= m.b) return m.x0 + Math.max(0, ts - m.a) * SCALE
      }
      return marks.at(-1)?.x1 ?? PAD_L
    }

    // median step duration fills untimed steps
    const dts = allTs.slice(1).map((t, i) => t - allTs[i]!).filter((d) => d > 0)
    const med = dts.length ? dts.sort((a, b) => a - b)[Math.floor(dts.length / 2)]! : 2000

    const lanes: Lane[] = []
    const colorOf = (tid: string) => corridor.lines.find((l) => l.id === tid)?.color ?? '#d8a851'
    for (const th of session.threads) {
      const timed = th.steps.filter((s) => s.ts != null || th.steps.length)
      if (!th.steps.length) continue
      const bars: Lane['bars'] = []
      for (let i = 0; i < timed.length; i++) {
        const s = timed[i]!
        const ts = s.ts ?? (i && timed[i - 1]!.ts != null ? timed[i - 1]!.ts! + med : t0 + i * med)
        const next = timed[i + 1]
        const nt = next ? (next.ts ?? ts + med) : ts + med
        const dur = Math.max(300, nt - ts)
        const gx = ts2x(ts)
        const gw = Math.max(3, Math.min(ts2x(Math.min(nt, ts + GAP)) - gx, 200))
        bars.push({
          step: s,
          x: gx,
          w: gw,
          dur,
          failed: (s.calls ?? []).some(callFailed),
          inferred: s.ts == null,
        })
      }
      lanes.push({ thread: th, color: colorOf(th.id), bars })
    }

    // ticks: largest nice step that still lands at least every ~110px
    const NICE = [5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000]
    const step = NICE.find((s) => s * SCALE >= 110) ?? 3_600_000
    const ticks: { x: number; ts: number; fold: boolean }[] = []
    for (const m of marks) {
      const first = Math.ceil(m.a / step) * step
      for (let t = first; t <= m.b; t += step) ticks.push({ x: m.x0 + (t - m.a) * SCALE, ts: t, fold: false })
    }
    // fold markers
    for (let i = 0; i + 2 < bounds.length; i += 2) {
      const foldX = marks[Math.floor(i / 2)]!.x1 + FOLD / 2
      ticks.push({ x: foldX, ts: bounds[i + 1]!, fold: true })
    }
    const w = (marks.at(-1)?.x1 ?? PAD_L) + PAD_R
    return { lanes, w, ticks, t0, t1, folded: bounds.length > 2, secTicks: step < 60_000, toX: ts2x }
  }, [session, corridor])

  const px = playhead != null ? toX(playhead) : null

  // longest spans across all lanes get the hot outline
  const longest = useMemo(() => {
    const flat = lanes.flatMap((l) => l.bars).sort((a, b) => b.dur - a.dur)
    return new Set(flat.slice(0, 3).map((b) => b.step.id))
  }, [lanes])

  const h = PAD_T + lanes.length * LANE_H + 12

  return (
    <section className="fallsheet" aria-label="time on the loom">
      <div className="fallhead">
        <b>time on the loom</b>
        <span className="fh-meta">
          {lanes.length} lane{lanes.length === 1 ? '' : 's'} · {hhmm(t0)} – {hhmm(t1)}
          {folded ? ' · idle folds marked' : ''}
        </span>
        <button className="x" aria-label="close the waterfall" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="fallbody">
        <svg className="fall-svg" width={w} height={h} role="img" aria-label="duration waterfall per thread">
          {ticks.map((t, i) =>
            t.fold ? (
              <g key={`f${i}`} className="fgapg">
                <path className="fgap" d={`M${t.x - 4} ${PAD_T - 4} l4 4 -4 4 4 4 -4 4`} strokeWidth={1.4} fill="none" stroke="var(--faint)" />
              </g>
            ) : (
              <g key={`t${i}`}>
                <line className="ftick" x1={t.x} y1={PAD_T - 6} x2={t.x} y2={h - 8} />
                <text className="ftick-lb" x={t.x + 3} y={PAD_T - 9}>
                  {hhmm(t.ts, secTicks)}
                </text>
              </g>
            ),
          )}
          {lanes.map((lane, li) => {
            const y = PAD_T + li * LANE_H
            return (
              <g key={lane.thread.id}>
                <text className="flane-name" x={10} y={y + 13} fill={lane.color}>
                  {lane.thread.label.slice(0, 16)}
                </text>
                <line className="ftick" x1={PAD_L - 8} y1={y + 9} x2={w - PAD_R} y2={y + 9} opacity={0.5} />
                {!lane.bars.length && (
                  <text className="fempty" x={PAD_L + 4} y={y + 13}>
                    — no steps timed —
                  </text>
                )}
                {lane.bars.map((b) => {
                  const st = stationByStep.get(b.step.id)
                  return (
                    <g key={b.step.id}>
                      <rect
                        className={`fbar-rect${sel && st?.id === sel ? ' sel' : ''}`}
                        x={b.x}
                        y={y + 3}
                        width={b.w}
                        height={12}
                        rx={2.5}
                        fill={b.failed ? '#e0603f' : lane.color}
                        opacity={b.inferred ? 0.45 : 0.85}
                        onClick={() => st && onPick(st.id)}
                      >
                        <title>
                          {stepTitle(b.step)} · {durStr(b.dur)}
                          {b.failed ? ' · failed' : ''}
                          {(b.step.calls ?? []).length ? ` · ${toolKind(b.step.calls![0]!.name)}` : ''}
                        </title>
                      </rect>
                      {b.w >= 26 && (
                        <text className="fdur" x={b.x + b.w - 3} y={y + 12} textAnchor="end">
                          {durStr(b.dur)}
                        </text>
                      )}
                      {longest.has(b.step.id) && (
                        <rect className="fcp" x={b.x - 1.5} y={y + 1.5} width={b.w + 3} height={15} rx={3.5} />
                      )}
                    </g>
                  )
                })}
              </g>
            )
          })}
          {px != null && <line className="fplay" x1={px} y1={PAD_T - 6} x2={px} y2={h - 8} />}
        </svg>
      </div>
    </section>
  )
}
