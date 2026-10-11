// Generates the synthetic demo sessions in fixtures/. Nothing here is real
// session data — it is a small invented story ("add a --json flag to a CLI")
// written to exercise every parser dialect.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = (...p) => join(root, 'fixtures', ...p)
const w = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s) }

// ---------- devin/nodes.jsonl + session.json ----------
// Story: turn 1 builds the flag; a reviewer subagent runs in parallel; the
// final turn lands the fix. Trees mimic the real forest shape.
const T0 = Date.parse('2026-10-10T09:14:00Z')
const nodes = []
let nid = 0
const node = (chain, parent, role, content, extra = {}, tsOff = 0) => {
  const n = {
    node_id: nid,
    parent_node_id: parent,
    chain,
    created_at: new Date(T0 + tsOff * 1000).toISOString(),
    message: {
      message_id: `m-${nid}`, role, content,
      ...(extra.tool_calls ? { tool_calls: extra.tool_calls } : {}),
      ...(extra.thinking ? { thinking: { thinking: extra.thinking } } : {}),
      ...(extra.tool_call_id ? { tool_call_id: extra.tool_call_id } : {}),
      metadata: { num_tokens: null, is_user_input: null, request_id: null, metrics: extra.metrics ?? null, finish_reason: null },
    },
    metadata: null,
  }
  nodes.push(n)
  return nid++
}
const call = (name, args, i = 0) => ({ id: `toolu_${Math.random().toString(36).slice(2, 12)}${i}`, name, arguments: args, index: i, kind: 'function' })

// turn 1 context roots
node('branch@0', null, 'system', '<system_info>workspace: ~/work/fern — a tiny CLI that prints fern fronds as ASCII.</system_info>', {}, 0)
node('branch@3', null, 'system', 'You are Devin, an interactive command line agent.', {}, 0)
const u1 = node('branch@3', null, 'user', 'add a --json flag to fern. it should print the frond as JSON {height, chars} instead of ASCII art. keep --height working.', {}, 2)
// work tree
const wRoot = node('branch@10', null, 'system', 'You are Devin, an interactive command line agent.', {}, 3)
const a1 = node('branch@10', wRoot, 'assistant', "I'll look at the CLI entry point first.", {
  thinking: 'The user wants a --json flag. I need to find the arg parser, probably in src/cli.ts or similar.',
  tool_calls: [call('exec', { command: 'ls src && sed -n 1,60p src/cli.ts' })],
  metrics: { input_tokens: 18230, output_tokens: 120 },
}, 4)
node('branch@10', a1, 'tool', "Output from command in shell 3fa1:\nsrc\ncli.ts  fern.ts  render.ts\nimport { parseArgs } from 'node:util'\nimport { fern } from './fern.ts'\n\nconst { values } = parseArgs({ options: { height: { type: 'string' } } })\nconst height = Number(values.height ?? 24)\nconsole.log(fern(height))", { tool_call_id: undefined }, 7)
const a2 = node('branch@10', a1 + 1, 'assistant', 'Parser is in cli.ts. Adding the flag and a json branch.', {
  thinking: 'parseArgs already used; add json: {type:"boolean"} and branch the output.',
  tool_calls: [call('edit', { file_path: '/Users/miguel/work/fern/src/cli.ts', old_string: "options: { height: { type: 'string' } }", new_string: "options: { height: { type: 'string' }, json: { type: 'boolean' } }" })],
  metrics: { input_tokens: 19012, output_tokens: 156 },
}, 9)
node('branch@10', a2, 'tool', 'The file src/cli.ts has been edited.', { tool_call_id: undefined }, 10)
// a reviewer subagent is spawned: the run_subagent call on the work tree
const aSpawn = node('branch@10', a2 + 1, 'assistant', 'While I wire the output, a reviewer checks the diff.', {
  tool_calls: [call('run_subagent', { title: 'review --json flag', task: 'Review the --json flag implementation in src/cli.ts. Read-only. Report correctness issues only.', profile: 'subagent_explore' })],
  metrics: { input_tokens: 19540, output_tokens: 88 },
}, 11)
node('branch@10', aSpawn, 'tool', '{"agent_id":"reviewer-1","status":"running"}', { tool_call_id: undefined }, 11)
const a3 = node('branch@10', aSpawn + 1, 'assistant', 'Now the json output branch.', {
  tool_calls: [call('edit', { file_path: '/Users/miguel/work/fern/src/cli.ts', old_string: 'console.log(fern(height))', new_string: "if (values.json) {\n  console.log(JSON.stringify({ height, chars: fern(height).length }))\n} else {\n  console.log(fern(height))\n}" })],
  metrics: { input_tokens: 20100, output_tokens: 140 },
}, 12)
node('branch@10', a3, 'tool', 'The file src/cli.ts has been edited.', { tool_call_id: undefined }, 13)
const a4 = node('branch@10', a3 + 1, 'assistant', 'Testing both paths.', {
  tool_calls: [call('exec', { command: 'node src/cli.ts --height 6 && node src/cli.ts --height 6 --json' })],
  metrics: { input_tokens: 20980, output_tokens: 60 },
}, 15)
node('branch@10', a4, 'tool', 'Output from command in shell 3fa1:\n   ;\n  ;;;\n ;;;;;\n;;;;;;;\n   ;\n   ;\n{"height":6,"chars":42}', { tool_call_id: undefined }, 17)

// sidekick subagent tree (reviewer): forked logically from aSpawn, stored as its own root
const sRoot = node('sidekick', null, 'system', 'You are the Reviewer subagent of Devin, an AI software engineer.', {}, 11)
const sU = node('sidekick', sRoot, 'user', 'Review the --json flag implementation in src/cli.ts. Read-only. Report correctness issues only.', {}, 11)
const sA1 = node('sidekick', sU, 'assistant', 'Reading the diff and the parser.', {
  thinking: 'Check parseArgs boolean handling and JSON shape.',
  tool_calls: [call('exec', { command: 'git diff && node src/cli.ts --json --height 3' })],
}, 12)
node('sidekick', sA1, 'tool', 'Output: +  json: { type: "boolean" }\n{"height":3,"chars":18}', { tool_call_id: undefined }, 14)
const sA2 = node('sidekick', sA1 + 1, 'assistant', 'One issue: `chars` counts bytes of the art string, not drawn cells — the name is misleading. Rename to `bytes` or document it. Otherwise correct.', {
  metrics: { input_tokens: 8120, output_tokens: 64 },
}, 16)
// summarizer tangle (detached, tiny)
const sumRoot = node('branch@22', null, 'system', 'You are a Summarizer that summarizes conversation history.', {}, 18)
node('branch@22', sumRoot, 'user', 'Summarize the work so far in one line.', {}, 18)
node('branch@22', sumRoot + 1, 'assistant', 'Added a --json flag to the fern CLI; a reviewer flagged the `chars` name.', {}, 19)

// turn 2 (main): user asks about the field name; agent renames
const mRoot = node('main', null, 'system', 'You are Devin, an interactive command line agent.', {}, 40)
const u2 = node('main', mRoot, 'user', 'rename chars to bytes, the reviewer was right', {}, 44)
const a5 = node('main', u2, 'assistant', 'Done — `chars` is now `bytes`, and the README example matches.', {
  tool_calls: [call('exec', { command: 'node src/cli.ts --height 4 --json' })],
  metrics: { input_tokens: 22310, output_tokens: 71 },
}, 46)
node('main', a5, 'tool', 'Output: {"height":4,"bytes":26}', { tool_call_id: undefined }, 47)
node('main', a5 + 1, 'assistant', 'Shipped. `fern --json` prints {"height":N,"bytes":M}; the reviewer check passed.', {}, 48)

// attach tool results to their calls (tool_call_id)
const toolNodes = nodes.filter((n) => n.message.role === 'tool')
const callIds = nodes.flatMap((n) => (n.message.tool_calls ?? []).map((c) => c.id))
toolNodes.forEach((n, i) => { n.message.tool_call_id = callIds[i] })

w(out('devin', 'mellow-fern', 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n') + '\n')
w(out('devin', 'mellow-fern', 'session.json'), JSON.stringify({
  id: 'mellow-fern', title: 'fern CLI: add --json output', model: 'swe-2-high',
  working_directory: '/Users/miguel/work/fern', main_chain_id: nid - 1,
  subagents: ['sidekick'], created_at: new Date(T0).toISOString(),
  last_activity_at: new Date(T0 + 48_000).toISOString(),
}, null, 2))

// ---------- codex rollout ----------
const C0 = Date.parse('2026-10-10T09:30:00Z')
const cl = (type, payload, off) => JSON.stringify({ timestamp: new Date(C0 + off * 1000).toISOString(), ordinal: 0, type, payload })
const codex = [
  cl('session_meta', { session_id: 'c0ffee-fern-1', id: 'c0ffee-fern-1', cwd: '/Users/miguel/work/fern', originator: 'codex_exec', cli_version: '0.155.1', model_provider: 'openai' }, 0),
  cl('task_started', { turn_id: 'turn-1' }, 0),
  cl('message', { role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] }, 0),
  cl('item_completed', { item: { type: 'UserMessage', content: [{ type: 'text', text: 'review the --json flag diff, read-only' }] } }, 1),
  cl('reasoning', { summary: [{ text: 'Small diff; verify flag parsing and output shape.' }] }, 2),
  cl('custom_tool_call', { call_id: 'call_1', name: 'exec', input: 'git diff -- src/cli.ts && node src/cli.ts --height 5 --json' }, 3),
  cl('custom_tool_call_output', { call_id: 'call_1', output: [{ type: 'input_text', text: '+ json: { type: "boolean" }\n{"height":5,"bytes":30}' }] }, 5),
  cl('token_count', { info: { last_token_usage: { input_tokens: 14200, output_tokens: 210 }, total_token_usage: { input_tokens: 14200, output_tokens: 210 } } }, 5),
  cl('custom_tool_call', { call_id: 'call_2', name: 'exec', input: 'node src/cli.ts --json --height 0; echo exit=$?; cat .env' }, 7),
  cl('custom_tool_call_output', { call_id: 'call_2', output: [{ type: 'input_text', text: '{"height":0,"bytes":0}\nexit=0\nOPENAI_API_KEY=sk-test-FAKEKEY0000000000000abcd1234' }] }, 8),
  cl('reasoning', { summary: [], encrypted_content: 'gAAAAA…sealed…' }, 9),
  cl('task_complete', { last_agent_message: 'Diff is correct. --json prints {"height":N,"bytes":M}, edge case height 0 is fine. One nit: no test covers the flag.' }, 11),
]
w(out('codex', 'rollout-2026-10-10T09-30-00-c0ffee.jsonl'), codex.join('\n') + '\n')

// ---------- cursor ----------
const cur = [
  { role: 'system', content: 'You are an AI coding assistant, powered by Grok.' },
  { role: 'user', content: '<user_info>Workspace: /Users/miguel/work/fern</user_info>\n\nadd a --width flag next to --json' },
  { role: 'assistant', content: [
    { type: 'reasoning', text: 'Width should clamp the frond renderer, not the json path.' },
    { type: 'text', text: 'Adding --width alongside --json.' },
    { type: 'tool-call', toolCallId: 'call-w1', toolName: 'Read', input: { path: 'src/cli.ts' } },
  ]},
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-w1', toolName: 'Read', result: 'const { values } = parseArgs({ options: { height: {type:"string"}, json: {type:"boolean"} } })' }] },
  { role: 'assistant', content: [
    { type: 'text', text: 'Width flag added; json stays {height, bytes}.' },
    { type: 'tool-call', toolCallId: 'call-w2', toolName: 'Shell', input: { command: 'node src/cli.ts --width 10 --json' } },
  ]},
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-w2', toolName: 'Shell', result: '{"height":24,"bytes":1180}' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Done — `--width 10` works with and without `--json`. Note: fern ignores widths under 6.' }] },
]
w(out('cursor', 'chat-fern', 'messages.jsonl'), cur.map((m) => JSON.stringify(m)).join('\n') + '\n')
w(out('cursor', 'chat-fern', 'meta.json'), JSON.stringify({ cwd: '/Users/miguel/work/fern', name: 'add --width flag', createdAtMs: C0 + 3_600_000, updatedAtMs: C0 + 3_900_000, mode: 'agent' }, null, 2))

// ---------- ATIF ----------
const atif = {
  schema_version: 'ATIF-v1.7',
  session_id: 'atif-fern-9',
  agent: { name: 'devin', version: '3000.10.31', model_name: 'SWE-2 High' },
  steps: [
    { step_id: 1, timestamp: new Date(C0 + 7_200_000).toISOString(), source: 'system', message: 'You are Devin, an interactive command line agent.' },
    { step_id: 2, timestamp: new Date(C0 + 7_201_000).toISOString(), source: 'user', message: 'update the README: document --json and --width' },
    { step_id: 3, timestamp: new Date(C0 + 7_203_000).toISOString(), source: 'agent', model_name: 'swe-2-high', reasoning_content: 'README lives at repo root; add a flags table.', message: 'Adding a flags section.', tool_calls: [{ tool_call_id: 'exec:0#aa', function_name: 'exec', arguments: { command: 'cat README.md' } }], observation: { results: [{ source_call_id: 'exec:0#aa', content: '# fern\nprint fern fronds\n' }] }, metrics: { prompt_tokens: 9100, completion_tokens: 60 } },
    { step_id: 4, timestamp: new Date(C0 + 7_206_000).toISOString(), source: 'agent', model_name: 'swe-2-high', message: 'Documented both flags with examples.', tool_calls: [{ tool_call_id: 'edit:0#bb', function_name: 'edit', arguments: { file_path: 'README.md', new_string: '## flags\n--height N, --width N, --json' } }], observation: { results: [{ source_call_id: 'edit:0#bb', content: 'README.md edited' }] }, metrics: { prompt_tokens: 9600, completion_tokens: 80 } },
    { step_id: 5, timestamp: new Date(C0 + 7_209_000).toISOString(), source: 'agent', model_name: 'swe-2-high', reasoning_content: 'Done.', message: 'README updated — flags table with --json and --width.', metrics: { prompt_tokens: 9800, completion_tokens: 40 } },
  ],
  final_metrics: { total_prompt_tokens: 28500, total_completion_tokens: 180 },
  subagent_trajectories: [
    {
      schema_version: 'ATIF-v1.7', trajectory_id: 'sub-1',
      agent: { name: 'reviewer', model_name: 'swe-2-medium' },
      steps: [
        { step_id: 1, timestamp: new Date(C0 + 7_204_000).toISOString(), source: 'user', message: 'Check README diff renders correctly' },
        { step_id: 2, timestamp: new Date(C0 + 7_205_000).toISOString(), source: 'agent', message: 'Table is valid markdown.', metrics: { prompt_tokens: 3100, completion_tokens: 20 } },
      ],
    },
  ],
}
w(out('atif-session.json'), JSON.stringify(atif, null, 2))

// ---------- manifest ----------
w(out('manifest.json'), JSON.stringify({
  generated_at: new Date(C0).toISOString(),
  sessions: [
    { agent: 'devin', id: 'mellow-fern', title: 'fern CLI: add --json output', cwd: '/Users/miguel/work/fern', start: new Date(T0).toISOString() },
    { agent: 'codex', id: 'c0ffee-fern-1', title: 'review --json diff', cwd: '/Users/miguel/work/fern', start: new Date(C0).toISOString() },
    { agent: 'cursor', id: 'chat-fern', title: 'add --width flag', cwd: '/Users/miguel/work/fern', start: new Date(C0 + 3_600_000).toISOString() },
  ],
}, null, 2))

console.log('fixtures written')
