import type { Session, Step, ToolCall } from '../model.ts'

// Codex rollout-*.jsonl. Two dialects:
//   modern: {timestamp, ordinal, type, payload:{type: message|item_completed|
//           custom_tool_call|custom_tool_call_output|reasoning|token_count|…}}
//   older:  {timestamp, type:'response_item', payload:{type: message|reasoning|
//           function_call|function_call_output|local_shell_call|…}}
// Both land in the same normalized stream.

interface Line { timestamp?: string; type?: string; payload?: Record<string, unknown> }

function text(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v))
    return v
      .map((p) => {
        if (typeof p === 'string') return p
        const o = p as Record<string, unknown>
        return typeof o?.text === 'string' ? o.text : ''
      })
      .filter(Boolean)
      .join('\n')
  return String(v)
}

function firstLine(s: string, n = 90): string {
  const l = s.replace(/\s+/g, ' ').trim()
  return l.length > n ? l.slice(0, n - 1) + '…' : l
}

export function parseCodexRollout(path: string, text_: string): Session {
  const lines: Line[] = []
  for (const l of text_.split('\n')) {
    const t = l.trim()
    if (!t) continue
    try {
      lines.push(JSON.parse(t) as Line)
    } catch {
      /* skip */
    }
  }

  const steps: Step[] = []
  const callIndex = new Map<string, { step: Step; call: ToolCall }>()
  let sessionId = path.split('/').pop() ?? 'codex'
  let cwd: string | undefined
  let model: string | undefined
  let seq = 0
  const ts = (l: Line) => (l.timestamp ? Date.parse(l.timestamp) : null)

  const pushCall = (id: string, name: string, args: string | undefined, t: number | null) => {
    const call: ToolCall = { id, name, args }
    const step: Step = { id: `c${seq++}`, ts: t, actor: 'agent', kind: 'call', title: name, calls: [call] }
    steps.push(step)
    callIndex.set(id, { step, call })
  }
  const fillResult = (callId: string, body: string) => {
    const hit = callIndex.get(callId)
    if (hit) hit.call.result = body
    else steps.push({ id: `c${seq++}`, ts: null, actor: 'tool', kind: 'result', title: firstLine(body) || 'result', body })
  }
  const pushMessage = (role: string, body: string, t: number | null) => {
    const actor: Step['actor'] = role === 'user' ? 'user' : role === 'assistant' ? 'agent' : 'system'
    steps.push({
      id: `c${seq++}`, ts: t, actor,
      kind: 'message',
      title: firstLine(body) || role, body,
    })
  }

  for (const l of lines) {
    const t = ts(l)
    // Unwrap envelopes. response_item rows carry the item in payload (or
    // payload.payload for the doubly-nested variant); event_msg wraps a
    // {type: user_message|agent_message, message} payload.
    let p = (l.payload ?? {}) as Record<string, unknown>
    let type = (l.type ?? p.type) as string | undefined
    let guard = 0
    while (type === 'response_item' && guard++ < 3) {
      if (p.payload && typeof p.payload === 'object') p = p.payload as Record<string, unknown>
      type = (p.type ?? type) as string
      if (type === 'response_item' && !(p.payload && typeof p.payload === 'object')) break
    }
    if (type === 'event_msg') type = p.type as string
    switch (type) {
      case 'session_meta': {
        sessionId = String(p.session_id ?? p.id ?? sessionId)
        cwd = typeof p.cwd === 'string' ? p.cwd : cwd
        model = typeof p.model === 'string' ? p.model : model
        break
      }
      case 'user_message':
      case 'agent_message': {
        const role = type === 'user_message' ? 'user' : 'assistant'
        pushMessage(role, text(p.message ?? p.content), t)
        break
      }
      case 'message': {
        const role = String(p.role ?? 'assistant')
        pushMessage(role === 'developer' ? 'system' : role, text(p.content ?? p.message), t)
        break
      }
      case 'item_completed': {
        const item = (p.item ?? {}) as Record<string, unknown>
        const it = String(item.type ?? '')
        const body = text(item.content ?? item.message)
        if (/user/i.test(it)) pushMessage('user', body, t)
        else if (/assistant|agent/i.test(it)) pushMessage('assistant', body, t)
        else if (/reason/i.test(it)) {
          steps.push({ id: `c${seq++}`, ts: t, actor: 'agent', kind: 'reasoning', title: firstLine(body) || 'reasoning', thinking: body })
        }
        break
      }
      case 'custom_tool_call':
      case 'function_call':
      case 'local_shell_call': {
        const action = p.action as Record<string, unknown> | undefined
        const name = String(p.name ?? action?.type ?? (type === 'local_shell_call' ? 'shell' : 'tool'))
        const args =
          typeof p.input === 'string' ? p.input
          : typeof p.arguments === 'string' ? p.arguments
          : p.arguments != null ? JSON.stringify(p.arguments, null, 2)
          : undefined
        pushCall(String(p.call_id ?? p.id ?? `c${seq}`), name, args, t)
        break
      }
      case 'custom_tool_call_output':
      case 'function_call_output': {
        fillResult(String(p.call_id ?? p.id ?? ''), text(p.output ?? p.content))
        break
      }
      case 'reasoning': {
        const summary = Array.isArray(p.summary)
          ? p.summary.map((s) => text((s as Record<string, unknown>)?.text ?? s)).filter(Boolean).join('\n')
          : text(p.summary)
        steps.push({
          id: `c${seq++}`, ts: t, actor: 'agent', kind: 'reasoning',
          title: firstLine(summary) || 'sealed reasoning',
          thinking: summary || undefined,
          body: summary ? undefined : 'Reasoning content is encrypted in this rollout.',
        })
        break
      }
      case 'token_count':
      case 'token_usage_record': {
        const info = (p.info ?? p) as Record<string, unknown>
        const u = (info.last_token_usage ?? info.total_token_usage) as Record<string, number> | undefined
        if (u) {
          const last = [...steps].reverse().find((s) => s.actor === 'agent')
          if (last) last.tokens = { input: u.input_tokens, output: u.output_tokens }
        }
        break
      }
      case 'task_complete': {
        const msg = text(p.last_agent_message)
        if (msg) steps.push({ id: `c${seq++}`, ts: t, actor: 'agent', kind: 'message', title: firstLine(msg), body: msg })
        break
      }
      // task_started, turn_context, world_state: structure, not story.
    }
  }

  const times = steps.map((s) => s.ts).filter((x): x is number => x != null)
  return {
    id: `codex-${sessionId}`,
    agent: 'codex',
    title: cwd ? `codex · ${cwd.split('/').pop()}` : `codex · ${sessionId.slice(0, 8)}`,
    cwd, model,
    start: times.length ? Math.min(...times) : null,
    end: times.length ? Math.max(...times) : null,
    timed: times.length > 0,
    threads: [{ id: 't-0', label: 'main', kind: 'spine', hiddenSteps: 0, steps }],
    files: [path],
  }
}
