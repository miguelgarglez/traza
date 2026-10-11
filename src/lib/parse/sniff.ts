// Format detection: filename hints first, then content shape.

export type Format =
  | 'atif'
  | 'devin-nodes'
  | 'devin-session'
  | 'codex-rollout'
  | 'cursor-messages'
  | 'cursor-meta'
  | 'manifest'
  | 'sqlite'
  | 'text'
  | 'unknown'

export function sniff(path: string, text: string): Format {
  const base = path.split('/').pop() ?? path
  if (base === 'store.db' || base.endsWith('.db')) return 'sqlite'
  if (base === 'manifest.json') return 'manifest'
  if (base === 'nodes.jsonl') return 'devin-nodes'
  if (base === 'session.json') return 'devin-session'
  if (base === 'messages.jsonl') return 'cursor-messages'
  if (base === 'meta.json') return 'cursor-meta'
  if (base.startsWith('rollout-') && base.endsWith('.jsonl')) return 'codex-rollout'

  const head = text.slice(0, 64_000)
  if (/"schema_version"\s*:\s*"ATIF/.test(head)) return 'atif'

  // JSONL shapes: look at the first few parseable lines.
  let jsonLines = 0
  for (const line of head.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const d = JSON.parse(t) as Record<string, unknown>
      jsonLines++
      if ('node_id' in d && 'message' in d) return 'devin-nodes'
      if (d.type === 'session_meta' || d.type === 'task_started' || d.type === 'turn_context') return 'codex-rollout'
      if (d.role === 'protobuf-text' || (d.role === 'assistant' && 'providerOptions' in d)) return 'cursor-messages'
      const p = d.payload as Record<string, unknown> | undefined
      if (p && (p.type === 'session_meta' || p.type === 'task_started')) return 'codex-rollout'
      if (jsonLines > 6) break
    } catch {
      /* not json */
    }
  }

  // Whole-file JSON.
  try {
    const d = JSON.parse(text) as Record<string, unknown>
    if (d && typeof d === 'object') {
      if (Array.isArray(d.steps) && 'agent' in d) return 'atif'
      if ('main_chain_id' in d || 'subagents' in d) return 'devin-session'
      if ('cwd' in d && 'createdAtMs' in d) return 'cursor-meta'
      if (Array.isArray(d.sessions)) return 'manifest'
    }
  } catch {
    /* not single-json */
  }
  return head.trim() ? 'text' : 'unknown'
}
