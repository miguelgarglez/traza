// trenza normalized model — every agent dialect converges here.

export type AgentKind = 'devin' | 'codex' | 'cursor' | 'atif' | 'unknown'
export type Actor = 'user' | 'agent' | 'system' | 'tool'
export type StepKind = 'message' | 'reasoning' | 'call' | 'result' | 'meta'

export interface ToolCall {
  id: string
  name: string
  args?: string
  result?: string
  ok?: boolean
}

export interface Step {
  id: string
  ts: number | null
  actor: Actor
  kind: StepKind
  title: string
  body?: string
  thinking?: string
  calls?: ToolCall[]
  tokens?: { input?: number; output?: number; costUsd?: number }
}

export type ThreadKind = 'spine' | 'branch' | 'tangle'

export interface Thread {
  id: string
  label: string
  kind: ThreadKind
  agent?: string
  parent?: string
  forkStep?: string
  mergeStep?: string
  hiddenSteps: number
  steps: Step[]
}

export interface Session {
  id: string
  agent: AgentKind
  title: string
  cwd?: string
  model?: string
  start: number | null
  end: number | null
  timed: boolean
  threads: Thread[]
  files: string[]
}

export interface SourceFile {
  path: string
  format: string
  ok: boolean
  note?: string
}

export interface WeaveStats {
  sessions: number
  steps: number
  calls: number
  tokIn: number
  tokOut: number
  costUsd?: number
  redactions: number
  branches: number
}

export interface Weave {
  sessions: Session[]
  files: SourceFile[]
  stats: WeaveStats
}

// One row of the flattened tape: a step on a lane.
export interface Row {
  gi: number
  sessionId: string
  threadId: string
  lane: number
  step: Step
}

// A collapsed offshoot: marker shown on the tape instead of steps.
export interface TangleMark {
  gi: number
  sessionId: string
  threadId: string
  lane: number
  count: number
  label: string
  steps: Step[]
}

export interface Tape {
  sessionId: string
  rows: Row[]
  tangles: TangleMark[]
  lanes: {
    threadId: string
    lane: number
    label: string
    kind: ThreadKind
    agent?: string
    firstGi: number
    lastGi: number
    forkGi?: number
    mergeGi?: number
    /** true when the anchor was inferred from chronology, not explicit provenance */
    forkInferred?: boolean
    mergeInferred?: boolean
  }[]
}
