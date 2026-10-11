import type { Session, Step, Thread, ToolCall } from '../model.ts'

// ATIF (Agent Trajectory Interchange Format), v1.x tolerant.
// Root: {schema_version, session_id, agent{name,version,model_name}, steps[],
//        subagent_trajectories[], final_metrics}

interface AtifStep {
  step_id?: number
  timestamp?: string
  source?: string
  message?: string
  model_name?: string
  reasoning_content?: string
  reasoning?: { content?: string; text?: string } | string
  tool_calls?: { tool_call_id?: string; function_name?: string; name?: string; arguments?: unknown }[]
  observation?: { results?: { source_call_id?: string; content?: string }[] }
  metrics?: { prompt_tokens?: number; completion_tokens?: number; cost_usd?: number }
}

interface AtifDoc {
  schema_version?: string
  session_id?: string
  trajectory_id?: string
  agent?: { name?: string; version?: string; model_name?: string }
  steps?: AtifStep[]
  final_metrics?: { total_prompt_tokens?: number; total_completion_tokens?: number }
  subagent_trajectories?: AtifDoc[]
}

function stepActor(s: AtifStep): Step['actor'] {
  if (s.source === 'user') return 'user'
  if (s.source === 'agent') return 'agent'
  return 'system'
}

function firstLine(s: string, n = 90): string {
  const l = s.replace(/\s+/g, ' ').trim()
  return l.length > n ? l.slice(0, n - 1) + '…' : l
}

function atifSteps(raw: AtifStep[] | undefined, prefix: string): Step[] {
  const out: Step[] = []
  ;(raw ?? []).forEach((s, i) => {
    const id = `${prefix}${s.step_id ?? i + 1}`
    const ts = s.timestamp ? Date.parse(s.timestamp) : null
    const calls: ToolCall[] | undefined = s.tool_calls?.map((c, j) => {
      const result = s.observation?.results?.find(
        (r) => !c.tool_call_id || !r.source_call_id || r.source_call_id === c.tool_call_id,
      )
      const argStr =
        typeof c.arguments === 'string' ? c.arguments : c.arguments ? JSON.stringify(c.arguments, null, 2) : undefined
      return {
        id: c.tool_call_id ?? `${id}.${j}`,
        name: c.function_name ?? c.name ?? 'tool',
        args: argStr,
        result: result?.content,
      }
    })
    const reasoning =
      typeof s.reasoning === 'string'
        ? s.reasoning
        : (s.reasoning?.content ?? s.reasoning?.text ?? s.reasoning_content)
    const metrics = s.metrics
    if (reasoning && reasoning.trim()) {
      out.push({ id: `${id}.think`, ts, actor: 'agent', kind: 'reasoning', title: firstLine(reasoning), thinking: reasoning })
    }
    const kind: Step['kind'] = calls?.length ? 'call' : 'message'
    out.push({
      id, ts,
      actor: stepActor(s),
      kind,
      title: s.message?.trim() ? firstLine(s.message) : calls?.length ? calls.map((c) => c.name).join(', ') : '(no message)',
      body: s.message || undefined,
      calls,
      tokens:
        metrics && (metrics.prompt_tokens || metrics.completion_tokens)
          ? { input: metrics.prompt_tokens, output: metrics.completion_tokens, costUsd: metrics.cost_usd }
          : undefined,
    })
  })
  return out
}

export function parseAtif(path: string, text: string): Session {
  const doc = JSON.parse(text) as AtifDoc
  const mainSteps = atifSteps(doc.steps, 's')
  const threads: Thread[] = [{ id: 't-main', label: 'main', kind: 'spine', hiddenSteps: 0, steps: mainSteps }]

  const subs = doc.subagent_trajectories ?? []
  subs.forEach((sub, i) => {
    const steps = atifSteps(sub.steps, `s${i}-`)
    const name = sub.agent?.name ?? `subagent ${i + 1}`
    // Anchor the branch at the last agent step that carries a tool call.
    const forkIdx = [...mainSteps].reverse().findIndex((s) => s.calls?.length)
    const forkStep = forkIdx >= 0 ? mainSteps[mainSteps.length - 1 - forkIdx]!.id : mainSteps[0]?.id
    threads.push({
      id: `t-sub-${i}`,
      label: name,
      kind: 'branch',
      agent: name,
      parent: 't-main',
      forkStep,
      hiddenSteps: 0,
      steps,
    })
  })

  const times = mainSteps.map((s) => s.ts).filter((t): t is number => t != null)
  const title = `${doc.agent?.name ?? 'atif'} · ${doc.session_id ?? path.split('/').pop() ?? 'session'}`
  return {
    id: `atif-${doc.session_id ?? path}`,
    agent: 'atif',
    title,
    model: doc.agent?.model_name,
    start: times.length ? Math.min(...times) : null,
    end: times.length ? Math.max(...times) : null,
    timed: times.length > 0,
    threads,
    files: [path],
  }
}
