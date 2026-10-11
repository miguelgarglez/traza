import type { Session, Step, Thread, ToolCall } from '../model.ts'

// Devin nodes.jsonl: one JSON object per line:
// {node_id, parent_node_id, chain, created_at, message{role,content,tool_calls,
//  thinking,tool_call_id,metadata}, metadata}
//
// The real structure is a forest of turn trees: each turn writes several roots
// (system context, the user message, the agent's work tree). Subagent sessions
// are their own big trees (chain 'sidekick' or 'subagent@N', handoff prompts).
// The main thread is every non-subagent tree merged in time order; branches are
// subagent trees and sizable peeled subtrees; tiny trees collapse into tangles.

interface DevinMsg {
  role?: string
  content?: unknown
  tool_calls?: { id?: string; name?: string; arguments?: unknown; kind?: string }[]
  thinking?: { thinking?: string } | string
  tool_call_id?: string
  metadata?: { metrics?: { input_tokens?: number; output_tokens?: number } }
}
interface DevinNode {
  node_id: number
  parent_node_id: number | null
  chain?: string
  created_at?: string | null
  message?: DevinMsg
}
export interface DevinSessionMeta {
  id?: string
  title?: string
  model?: string
  working_directory?: string
  main_chain_id?: number
  subagents?: string[]
  created_at?: string
  last_activity_at?: string
}

export interface DevinMark {
  anchorNode: number | null
  label: string
  count: number
  steps: Step[]
}

const TANGLE_MAX = 4

function text(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v))
    return v
      .map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  return String(v)
}

function firstLine(s: string, n = 90): string {
  const l = s.replace(/\s+/g, ' ').trim()
  return l.length > n ? l.slice(0, n - 1) + '…' : l
}

function nodeToSteps(n: DevinNode, callIndex: Map<string, ToolCall>): Step[] {
  const m = n.message ?? {}
  const ts = n.created_at ? Date.parse(n.created_at) : null
  const id = `n${n.node_id}`
  const thinking = typeof m.thinking === 'string' ? m.thinking : m.thinking?.thinking

  if (m.role === 'tool') {
    const body = text(m.content)
    if (m.tool_call_id && callIndex.has(m.tool_call_id)) {
      callIndex.get(m.tool_call_id)!.result = body
      return []
    }
    return [{ id, ts, actor: 'tool', kind: 'result', title: firstLine(body) || 'result', body }]
  }
  if (m.role === 'assistant') {
    const calls: ToolCall[] | undefined = m.tool_calls?.map((c, j) => {
      const tc: ToolCall = {
        id: c.id ?? `${id}.${j}`,
        name: c.name ?? 'tool',
        args: typeof c.arguments === 'string' ? c.arguments : c.arguments ? JSON.stringify(c.arguments, null, 2) : undefined,
      }
      callIndex.set(tc.id, tc)
      return tc
    })
    const body = text(m.content)
    const metrics = m.metadata?.metrics
    return [
      {
        id, ts,
        actor: 'agent',
        kind: calls?.length ? 'call' : 'message',
        title: body.trim() ? firstLine(body) : calls?.length ? calls.map((c) => c.name).join(', ') : 'step',
        body: body || undefined,
        thinking: thinking?.trim() ? thinking : undefined,
        calls,
        tokens: metrics ? { input: metrics.input_tokens, output: metrics.output_tokens } : undefined,
      },
    ]
  }
  const body = text(m.content)
  const actor: Step['actor'] = m.role === 'user' ? 'user' : m.role === 'tool' ? 'tool' : 'system'
  return [{ id, ts, actor, kind: 'message', title: firstLine(body) || m.role || 'note', body }]
}

function treeLabel(root: DevinNode, subagents: string[]): string {
  const chain = root.chain ?? ''
  if (chain.startsWith('subagent@')) return 'subagent'
  if (chain && chain !== 'main' && !chain.startsWith('branch@')) return chain
  const msg = text(root.message?.content)
  if (/summariz/i.test(msg)) return 'summarizer'
  const prof = msg.match(/You are (?:a|an|the) ([A-Za-z][\w-]{1,30}?)(?: subagent| agent)/i)
  if (prof) return prof[1]!.trim().toLowerCase()
  if (/handoff|your first handoff/i.test(msg)) return 'worker'
  for (const s of subagents) if (chain.includes(s)) return s
  return 'branch'
}

function isSubagentRoot(root: DevinNode, subagents: string[]): boolean {
  const chain = root.chain ?? ''
  if (chain.startsWith('subagent@') || subagents.includes(chain)) return true
  const msg = text(root.message?.content)
  return /You are (?:a|an|the) \w[\w-]* subagent/i.test(msg)
}

export interface DevinParsed {
  session: Session
  marks: DevinMark[] // detached tangles, anchored by nearest earlier main node
}

export function parseDevinNodes(path: string, text_: string, meta?: DevinSessionMeta): DevinParsed {
  const nodes: DevinNode[] = []
  for (const line of text_.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      nodes.push(JSON.parse(t) as DevinNode)
    } catch {
      /* skip bad line */
    }
  }
  const byId = new Map(nodes.map((n) => [n.node_id, n]))
  const children = new Map<number, DevinNode[]>()
  const roots: DevinNode[] = []
  for (const n of nodes) {
    const p = n.parent_node_id
    if (p == null || !byId.has(p)) roots.push(n)
    else {
      const arr = children.get(p) ?? []
      arr.push(n)
      children.set(p, arr)
    }
  }
  const ts = (n: DevinNode) => (n.created_at ? Date.parse(n.created_at) : NaN)
  const order = (a: DevinNode, b: DevinNode) => {
    const ta = ts(a), tb = ts(b)
    if (!isNaN(ta) && !isNaN(tb) && ta !== tb) return ta - tb
    return a.node_id - b.node_id
  }
  for (const arr of children.values()) arr.sort(order)
  roots.sort(order)

  const size = new Map<number, number>()
  // Iterative post-order — devin forests can be thousands of nodes deep.
  const subtreeSize = (root: DevinNode): number => {
    const cached = size.get(root.node_id)
    if (cached != null) return cached
    const stack: { n: DevinNode; done: boolean }[] = [{ n: root, done: false }]
    while (stack.length) {
      const top = stack.pop()!
      const kids = children.get(top.n.node_id) ?? []
      if (top.done) {
        let s = 1
        for (const c of kids) s += size.get(c.node_id) ?? 0
        size.set(top.n.node_id, s)
        continue
      }
      const memo = size.get(top.n.node_id)
      if (memo != null) continue
      stack.push({ n: top.n, done: true })
      for (const c of kids) if (!size.has(c.node_id)) stack.push({ n: c, done: false })
    }
    return size.get(root.node_id) ?? 1
  }

  const subagents = meta?.subagents ?? []
  const threads: Thread[] = []
  let tid = 0

  // The thread's own spine: path root→head (latest leaf). Only off-path
  // children are branches — the continuation stays in the thread.
  const headOf = (root: DevinNode): DevinNode => {
    let best = root
    const stack = [root]
    while (stack.length) {
      const n = stack.pop()!
      const kids = children.get(n.node_id) ?? []
      if (!kids.length) {
        const t = ts(n) || 0
        const tb = ts(best) || 0
        if (t > tb || (t === tb && n.node_id > best.node_id)) best = n
        continue
      }
      for (const c of kids) stack.push(c)
    }
    return best
  }
  const pathToHead = (root: DevinNode): Set<number> => {
    const head = headOf(root)
    const set = new Set<number>()
    let cur: DevinNode | undefined = head
    while (cur) {
      set.add(cur.node_id)
      cur = cur.parent_node_id != null ? byId.get(cur.parent_node_id) : undefined
    }
    return set
  }

  // Walk a tree's own spine into steps; off-path subtrees become child lanes
  // when sizable, tangle marks when small.
  const buildThread = (
    root: DevinNode,
    parent: Thread | undefined,
    kind: Thread['kind'],
    label: string,
  ): Thread => {
    const thread: Thread = {
      id: `t-${tid++}`,
      label,
      kind,
      parent: parent?.id,
      forkStep: root.parent_node_id != null && byId.has(root.parent_node_id) ? `n${root.parent_node_id}` : undefined,
      hiddenSteps: 0,
      steps: [],
    }
    threads.push(thread)

    const onPath = pathToHead(root)
    const peeled: DevinNode[] = []
    const callIndex = new Map<string, ToolCall>()
    const threadMarks: DevinMark[] = []
    const collect = (root: DevinNode, into: Step[], ci: Map<string, ToolCall>) => {
      const stack = [root]
      while (stack.length) {
        const n = stack.pop()!
        for (const s of nodeToSteps(n, ci)) into.push(s)
        for (const c of children.get(n.node_id) ?? []) stack.push(c)
      }
    }
    // The spine is a linear chain — walk it without recursion.
    let cur: DevinNode | undefined = root
    while (cur) {
      thread.steps.push(...nodeToSteps(cur, callIndex))
      let next: DevinNode | undefined
      for (const c of children.get(cur.node_id) ?? []) {
        if (onPath.has(c.node_id)) {
          next = c
        } else {
          const lbl = treeLabel(c, subagents)
          if (subtreeSize(c) > TANGLE_MAX && lbl !== 'summarizer') {
            peeled.push(c)
          } else {
            const steps: Step[] = []
            collect(c, steps, callIndex)
            threadMarks.push({ anchorNode: cur.node_id, label: lbl, count: steps.length, steps })
          }
        }
      }
      cur = next
    }
    ;(thread as { marks?: DevinMark[] }).marks = threadMarks

    for (const c of peeled) {
      buildThread(c, thread, 'branch', treeLabel(c, subagents))
    }
    return thread
  }

  const main: Thread = { id: `t-${tid++}`, label: 'main', kind: 'spine', hiddenSteps: 0, steps: [] }
  threads.push(main)
  const mainMarks: DevinMark[] = []
  ;(main as { marks?: DevinMark[] }).marks = mainMarks

  // Sort roots chronologically by their subtree's earliest timestamp.
  const rootMinTs = (r: DevinNode): number => {
    let m = ts(r) || Infinity
    const stack = [r]
    while (stack.length) {
      const n = stack.pop()!
      for (const c of children.get(n.node_id) ?? []) {
        const t = ts(c)
        if (!isNaN(t) && t < m) m = t
        stack.push(c)
      }
    }
    return m
  }
  const sortedRoots = [...roots].sort((a, b) => rootMinTs(a) - rootMinTs(b) || a.node_id - b.node_id)

  for (const r of sortedRoots) {
    const lbl = treeLabel(r, subagents)
    const sub = isSubagentRoot(r, subagents)
    if (sub && subtreeSize(r) > TANGLE_MAX) {
      buildThread(r, undefined, 'branch', lbl === 'branch' ? 'subagent' : lbl)
    } else if (lbl === 'summarizer' || sub) {
      // Summarizers and subagent stubs (handoff scaffolding) are tangles.
      const steps: Step[] = []
      const ci = new Map<string, ToolCall>()
      const stack = [r]
      while (stack.length) {
        const n = stack.pop()!
        for (const s of nodeToSteps(n, ci)) steps.push(s)
        for (const c of children.get(n.node_id) ?? []) stack.push(c)
      }
      mainMarks.push({ anchorNode: null, label: lbl, count: steps.length, steps })
    } else {
      // Spine segment: fold this tree's steps into the main thread and keep
      // any peeled subtrees it spawned as branches of main.
      const segIdx = threads.length
      const seg = buildThread(r, undefined, 'tangle', 'seg')
      threads.splice(segIdx, 1)
      main.steps.push(...seg.steps)
      for (const t of threads) if (t.parent === seg.id) t.parent = main.id
      mainMarks.push(...(((seg as { marks?: DevinMark[] }).marks) ?? []))
    }
  }

  main.steps.sort((a, b) => {
    const ta = a.ts, tb = b.ts
    if (ta != null && tb != null && ta !== tb) return ta - tb
    return parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10)
  })

  const all = nodes.map(ts).filter((t) => !isNaN(t))
  const session: Session = {
    id: `devin-${meta?.id ?? path.split('/').slice(-2, -1)[0] ?? path}`,
    agent: 'devin',
    title: meta?.title ?? path.split('/').slice(-2, -1)[0] ?? 'devin session',
    cwd: meta?.working_directory,
    model: meta?.model,
    start: meta?.created_at ? Date.parse(meta.created_at) : all.length ? Math.min(...all) : null,
    end: meta?.last_activity_at ? Date.parse(meta.last_activity_at) : all.length ? Math.max(...all) : null,
    timed: all.length > 0,
    threads,
    files: [path],
  }
  return { session, marks: mainMarks }
}
