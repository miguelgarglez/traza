import type { Step, ToolCall } from './model.ts'
import { redactText } from './redact.ts'

// title.ts — readable names for steps, and turn grouping.
// A station or step is titled with its real first line or its tool call
// ("edit src/x.ts", "npm test → failed"), never with a bare kind word.

export type ToolKind = 'edit' | 'exec' | 'read' | 'web' | 'mcp' | 'other'

const EDIT = /edit|write|str_replace|create_file|apply_patch|fs_write|notebook_edit/i
const EXEC = /exec|shell|bash|terminal|run_command|process|command/i
const READ = /read|grep|glob|find|search_files|list|cat|view|ls\b/i
const WEB = /web|fetch|browser|search|url|curl|http/i

export function toolKind(name: string): ToolKind {
  if (/mcp|mcp__|__mcp/i.test(name)) return 'mcp'
  if (EDIT.test(name)) return 'edit'
  if (EXEC.test(name)) return 'exec'
  if (WEB.test(name)) return 'web'
  if (READ.test(name)) return 'read'
  return 'other'
}

/** Pull one short, human-legible argument out of a tool call's args. */
export function argSummary(call: ToolCall): string {
  const raw = (call.args ?? '').trim()
  if (!raw) return ''
  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* not json — codex execs often pass bare command lines */
  }
  const pick = (o: unknown, depth: number): string => {
    if (!o || typeof o !== 'object' || depth > 3) return ''
    const rec = o as Record<string, unknown>
    // common argument shapes across devin / codex / cursor dialects
    for (const k of ['file_path', 'path', 'filename', 'file', 'target_file', 'notebook_path'])
      if (typeof rec[k] === 'string') return base(rec[k] as string)
    for (const k of ['command', 'cmd', 'shell_command', 'code'])
      if (typeof rec[k] === 'string') return firstLine(rec[k] as string, 46)
    for (const k of ['query', 'pattern', 'url', 'prompt', 'task', 'input'])
      if (typeof rec[k] === 'string') return firstLine(rec[k] as string, 46)
    for (const v of Object.values(rec)) {
      const got = pick(v, depth + 1)
      if (got) return got
    }
    return ''
  }
  if (parsed) return pick(parsed, 0)
  // bare command line — keep the first line, cap it
  return firstLine(raw.replace(/^["'{[]+/, ''), 46)
}

const base = (p: string) => {
  const clean = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const i = clean.lastIndexOf('/')
  // keep the last two segments so "cli.ts" becomes "src/cli.ts" context
  if (i < 0) return clean
  const j = clean.lastIndexOf('/', i - 1)
  return j < 0 ? clean.slice(i + 1) : clean.slice(j + 1)
}

const firstLine = (t: string, n = 60) => {
  const line = t.trim().split('\n').find((l) => l.trim()) ?? ''
  return line.length > n ? line.slice(0, n - 1).trimEnd() + '…' : line
}

/** Did a call land badly? ok flag, then the usual exit-code / error words. */
export function callFailed(c: ToolCall): boolean {
  if (c.ok === false) return true
  const r = c.result ?? ''
  return /exit(?:ed)? (?:with )?(?:code )?[1-9]\d*\b/i.test(r) || /\b(traceback|fatal error|command not found)\b/i.test(r)
}

/** Short outcome tag for a call, e.g. "failed" or "3 failed". */
export function callOutcome(c: ToolCall): string {
  if (c.ok === false) return 'failed'
  const r = c.result ?? ''
  const m = r.match(/exit(?:ed)? (?:with )?(?:code )?([1-9]\d*)/i)
  if (m) return `exit ${m[1]}`
  const f = r.match(/(\d+)\s+fail(?:ed|ures?)?/i)
  if (f && parseInt(f[1]!, 10) > 0) return `${f[1]} failed`
  return ''
}

/** The readable name a step earns on the map and in lists. */
export function stepTitle(step: Step): string {
  if (step.calls?.length) {
    const c = step.calls[0]!
    const arg = argSummary(c)
    const out = callOutcome(c)
    const more = step.calls.length > 1 ? ` +${step.calls.length - 1}` : ''
    const t = `${c.name}${arg ? ` ${arg}` : ''}${more}${out ? ` → ${out}` : ''}`
    return redactText(t).text
  }
  const t = (step.title ?? '').trim().replace(/^<[^>]+>\s*/, '')
  if (t) return firstLine(redactText(t).text, 64)
  const body = (step.thinking ?? step.body ?? '').trim()
  if (body) {
    const label = step.kind === 'reasoning' ? 'thinking' : step.kind === 'result' ? 'result' : step.kind
    return `${label} — ${firstLine(redactText(body).text, 52)}`
  }
  return step.kind
}

/** A turn: a run of consecutive agent work (reasoning + calls + results).
 *  User prompts, system rows and meta stay single. Turns pace the replay. */
export interface Turn {
  id: string
  label: string
  kind: 'user' | 'work' | 'meta'
  stepIds: string[]
  /** tool kinds seen inside the turn */
  tools: ToolKind[]
  failed: boolean
  firstTs: number | null
  lastTs: number | null
  tokIn: number
  tokOut: number
}

export function buildTurns(steps: Step[]): Turn[] {
  const turns: Turn[] = []
  let cur: Turn | null = null
  const flush = () => {
    if (cur) turns.push(cur)
    cur = null
  }
  const ts = (s: Step) => s.ts
  for (const s of steps) {
    const isWork = (s.actor === 'agent' || s.actor === 'tool') && s.kind !== 'meta'
    if (!isWork) {
      flush()
      turns.push({
        id: `T${turns.length}`, label: stepTitle(s),
        kind: s.actor === 'user' ? 'user' : 'meta',
        stepIds: [s.id], tools: [], failed: false,
        firstTs: ts(s), lastTs: ts(s),
        tokIn: s.tokens?.input ?? 0, tokOut: s.tokens?.output ?? 0,
      })
      continue
    }
    if (!cur) {
      cur = {
        id: `T${turns.length}`, label: stepTitle(s), kind: 'work',
        stepIds: [], tools: [], failed: false,
        firstTs: ts(s), lastTs: ts(s), tokIn: 0, tokOut: 0,
      }
    }
    cur.stepIds.push(s.id)
    cur.lastTs = ts(s) ?? cur.lastTs
    cur.tokIn += s.tokens?.input ?? 0
    cur.tokOut += s.tokens?.output ?? 0
    for (const c of s.calls ?? []) {
      cur.tools.push(toolKind(c.name))
      if (callFailed(c)) cur.failed = true
    }
  }
  flush()
  // label each work turn by its most concrete step (first call wins)
  for (const t of turns) {
    if (t.kind !== 'work') continue
    const withCall = t.stepIds
      .map((id) => steps.find((s) => s.id === id))
      .find((s) => s?.calls?.length)
    if (withCall) t.label = stepTitle(withCall)
    const nCalls = t.stepIds.reduce((n, id) => n + (steps.find((s) => s.id === id)?.calls?.length ?? 0), 0)
    if (nCalls > 1) t.label += ` · ${nCalls} calls`
  }
  return turns
}

/** Full-text haystack for a step — title, body, thinking, call args+results. */
export function stepText(s: Step): string {
  return [
    s.title, s.body, s.thinking,
    ...(s.calls ?? []).flatMap((c) => [c.name, c.args ?? '', c.result ?? '']),
  ]
    .filter(Boolean)
    .join('\n')
}
