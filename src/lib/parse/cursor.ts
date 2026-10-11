import type { Session, Step, ToolCall } from '../model.ts'

// Cursor messages.jsonl (decoded by lab-sessions-export from store.db blobs):
// {blob, role: system|user|assistant|tool|protobuf-text, content, id?}
// assistant.content = [{type:reasoning|text|tool-call,…}]
// tool.content      = [{type:tool-result, toolCallId, toolName, result,…}]
// meta.json: {cwd, name?, createdAtMs, updatedAtMs, mode?}

interface CursorMsg {
  role?: string
  content?: unknown
  id?: string
}
export interface CursorMeta {
  cwd?: string
  name?: string
  createdAtMs?: number
  updatedAtMs?: number
  mode?: string
  model?: string
}

function text(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v))
    return v
      .map((p) => {
        if (typeof p === 'string') return p
        const o = p as Record<string, unknown>
        if (typeof o?.text === 'string') return o.text
        if (o?.type === 'text' && typeof o?.text === 'string') return o.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  return String(v)
}

function firstLine(s: string, n = 90): string {
  const l = s.replace(/\s+/g, ' ').trim()
  return l.length > n ? l.slice(0, n - 1) + '…' : l
}

export function parseCursorMessages(path: string, text_: string, meta?: CursorMeta): Session {
  const msgs: CursorMsg[] = []
  for (const l of text_.split('\n')) {
    const t = l.trim()
    if (!t) continue
    try {
      msgs.push(JSON.parse(t) as CursorMsg)
    } catch {
      /* skip */
    }
  }

  const steps: Step[] = []
  const callIndex = new Map<string, ToolCall>()
  let seq = 0
  let fragments = 0

  for (const m of msgs) {
    const id = `m${seq++}`
    if (m.role === 'protobuf-text') {
      fragments++
      const runs = Array.isArray(m.content) ? (m.content as string[]) : [String(m.content ?? '')]
      steps.push({ id, ts: null, actor: 'system', kind: 'meta', title: `log fragment · ${runs.length} run${runs.length === 1 ? '' : 's'}`, body: runs.join('\n') })
      continue
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      // Split the parts: reasoning, text, tool-call.
      const parts = m.content as Record<string, unknown>[]
      const reasoning = parts.filter((p) => p.type === 'reasoning').map((p) => text(p.text)).filter(Boolean).join('\n')
      const say = parts.filter((p) => p.type === 'text').map((p) => text(p.text)).filter(Boolean).join('\n')
      const calls: ToolCall[] = []
      for (const p of parts) {
        if (p.type !== 'tool-call') continue
        const cid = String(p.toolCallId ?? `${id}.${calls.length}`)
        const call: ToolCall = {
          id: cid,
          name: String(p.toolName ?? 'tool'),
          args: p.input != null ? (typeof p.input === 'string' ? p.input : JSON.stringify(p.input, null, 2)) : undefined,
        }
        calls.push(call)
        callIndex.set(cid, call)
      }
      if (reasoning.trim()) {
        steps.push({ id: `${id}r`, ts: null, actor: 'agent', kind: 'reasoning', title: firstLine(reasoning), thinking: reasoning })
      }
      steps.push({
        id, ts: null, actor: 'agent',
        kind: calls.length ? 'call' : 'message',
        title: say.trim() ? firstLine(say) : calls.length ? calls.map((c) => c.name).join(', ') : 'step',
        body: say || undefined,
        calls: calls.length ? calls : undefined,
      })
      continue
    }
    if (m.role === 'tool') {
      const parts = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : []
      const tr = parts.find((p) => p.type === 'tool-result')
      const body = tr
        ? text(tr.result ?? tr.experimental_content)
        : text(m.content)
      const cid = String(tr?.toolCallId ?? m.id ?? '')
      const hit = cid && callIndex.get(cid)
      if (hit) {
        hit.result = body
        continue
      }
      steps.push({ id, ts: null, actor: 'tool', kind: 'result', title: firstLine(body) || 'result', body })
      continue
    }
    const body = text(m.content)
    const actor: Step['actor'] = m.role === 'user' ? 'user' : m.role === 'tool' ? 'tool' : 'system'
    steps.push({ id, ts: null, actor, kind: 'message', title: firstLine(body) || m.role || 'note', body })
  }

  return {
    id: `cursor-${path.split('/').slice(-2, -1)[0] ?? path}`,
    agent: 'cursor',
    title: meta?.name ?? `cursor · ${(meta?.cwd ?? path).split('/').filter(Boolean).pop()}`,
    cwd: meta?.cwd,
    model: meta?.model,
    start: meta?.createdAtMs ?? null,
    end: meta?.updatedAtMs ?? null,
    timed: false, // no per-step timestamps in the decoded export
    threads: [{ id: 't-0', label: 'main', kind: 'spine', hiddenSteps: 0, steps }],
    files: [path],
  }
}
