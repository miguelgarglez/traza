// Generates public/demo/ — a bundled sample export so traza opens on a real
// plano, not an empty screen. Deterministic: same bytes every run.
// Run: node scripts/gen-demo.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(fileURLToPath(import.meta.url), '..', '..', 'public', 'demo')
const T0 = Date.parse('2026-10-09T16:20:00Z')
let t = T0
const tick = (s = 1) => new Date((t += s * 1000)).toISOString()

// ---- devin session: "lantern press" --------------------------------------
// ~120 nodes. A site redesign session: explore, user redirects mid-flight,
// two subagent branches, a failed check, small peels that become works.
const nodes = []
const nid = () => nodes.length
let callSeq = 0
const msg = (role, content, extra = {}) => ({
  message_id: `m-${nid()}`,
  role,
  content,
  metadata: { num_tokens: null, is_user_input: null, request_id: null, metrics: null, finish_reason: null },
  ...extra,
})
const node = (parent, chain, message, secs = 1) =>
  nodes.push({ node_id: nid(), parent_node_id: parent, chain, created_at: tick(secs), message, metadata: null }) - 1
const sys = (parent, chain, content, secs = 1) => node(parent, chain, msg('system', content), secs)
const user = (parent, chain, content, secs = 4) => node(parent, chain, msg('user', content), secs)
const tool = (parent, chain, content, callId, secs = 2) =>
  node(parent, chain, { ...msg('tool', content), tool_call_id: callId }, secs)
// agent() returns {n, calls} so tool() replies can reference call ids
function agent(parent, chain, content, { calls = [], thinking, secs = 2 } = {}) {
  const tcs = calls.map((c) => ({
    id: `toolu_${(callSeq++).toString(36).padStart(2, '0')}lantern`,
    name: c.name,
    arguments: c.args,
    index: 0,
    kind: 'function',
  }))
  const n = node(parent, chain, {
    ...msg('assistant', content, {
      tool_calls: tcs.length ? tcs : undefined,
      thinking: thinking ? { thinking } : undefined,
    }),
  }, secs)
  // inject token metrics like a real export
  const m = nodes[n].message
  m.metadata.metrics = { input_tokens: 12000 + n * 137, output_tokens: 40 + (n % 9) * 30 }
  return { n, calls: tcs }
}
const answer = (parent, chain, call, content, secs = 2) => tool(parent, chain, content, call.id, secs)

// -- turn 1: explore + build ---------------------------------------------
sys(null, 'branch@0', '<system_info>workspace: ~/work/lantern — a generative print shop that turns git history into letterpress posters.</system_info>', 0)
sys(null, 'branch@3', 'You are Devin, an interactive command line agent.')
const u1 = user(null, 'branch@3', 'the /posters page renders as a wall of unstyled divs. make it a proper print grid — editorial, generous margins, paper texture. keep the poster detail route working.')
sys(null, 'branch@6', 'You are Devin, an interactive command line agent.')
let a = agent(3, 'branch@6', "Reading the posters route and the stylesheet first.", {
  calls: [{ name: 'exec', args: { command: 'ls app/posters && sed -n 1,80p app/posters/page.tsx' } }],
  thinking: 'User wants an editorial print grid. Need to see the current markup and what data each poster card has.',
})
let last = a.n
last = answer(last, 'branch@6', a.calls[0], 'app/posters/page.tsx  poster-card.tsx\n\nexport default function Posters() {\n  return <main>{posters.map(p => <div key={p.id}>{p.title}</div>)}</main>\n}')
a = agent(last, 'branch@6', 'The cards carry title + edition + a thumbnail path. Sketching the grid in CSS first.', {
  calls: [{ name: 'write', args: { file_path: '/Users/miguel/work/lantern/app/posters/posters.module.css', content: '/* editorial print grid */' } }],
})
last = a.n
last = answer(last, 'branch@6', a.calls[0], 'File created successfully at: /Users/miguel/work/lantern/app/posters/posters.module.css')
a = agent(last, 'branch@6', 'Now the markup — a named grid area per poster, captions set in small caps like edition plates.', {
  calls: [{ name: 'edit', args: { file_path: '/Users/miguel/work/lantern/app/posters/page.tsx', old_string: '<div key={p.id}>{p.title}</div>', new_string: '<figure className={s.plate} key={p.id}>…</figure>' } }],
  thinking: 'Each poster becomes a figure/plate. Captions bottom-left, edition number like a plate mark.',
})
last = a.n
last = answer(last, 'branch@6', a.calls[0], 'The file app/posters/page.tsx has been edited.')

// sidekick branch: a reviewer spawned mid-work
const kick = sys(null, 'sidekick', 'You are the Reviewer subagent of Devin, an AI software engineer.', 1)
user(kick, 'sidekick', 'Check the new posters grid for a11y traps: figure/figcaption pairing, alt text on plate images, focus order. Read-only, report findings only.')
let b = agent(1 + kick, 'sidekick', 'Reading the plate markup and the card component.', {
  calls: [{ name: 'exec', args: { command: 'sed -n 1,120p app/posters/page.tsx app/posters/poster-card.tsx' } }],
  thinking: 'Look for figure without figcaption, missing alt, keyboard traps.',
})
let blast = b.n
blast = answer(blast, 'sidekick', b.calls[0], '<figure className={s.plate}>\n  <img src={p.thumb}/>\n  <figcaption>{p.title} — ed. {p.edition}</figcaption>\n</figure>')
b = agent(blast, 'sidekick', 'Two findings: img has no alt, and the whole figure is a link so the caption reads twice to screen readers.', { secs: 3 })
blast = b.n
b = agent(blast, 'sidekick', 'Recommend: alt={`${p.title} poster`}, aria-hidden on the caption inside the link. No blockers otherwise.', {})

// a tiny peeled chain: one-shot summarizer (becomes a works spur)
const sumz = sys(null, 'branch@30', 'You are a Summarizer that summarizes conversation history.', 1)
node(sumz, 'branch@30', msg('assistant', 'Condensed 8 turns into working notes.'), 2)

// -- turn 2: user redirects ------------------------------------------------
const u2 = user(null, 'branch@34', 'actually — can the grid keep the detail route as a side panel instead of a full page? click a plate, it opens at the right edge.')
sys(null, 'branch@36', 'You are Devin, an interactive command line agent.')
a = agent(last, 'branch@36', 'Good call — a margin-panel fits the print metaphor better than a page turn. Rewiring the route to a parallel panel.', {
  calls: [{ name: 'exec', args: { command: 'find app/posters -name "*.tsx" | head' } }],
  thinking: 'Intercepting routes or a query param? Panel at the right edge — keep it simple: ?plate=id renders <PlatePanel/> alongside the grid.',
})
last = a.n
last = answer(last, 'branch@36', a.calls[0], 'app/posters/page.tsx\napp/posters/[id]/page.tsx\napp/posters/poster-card.tsx')
a = agent(last, 'branch@36', 'Switching to search-param routing: ?plate= keeps the grid mounted, detail slides in from the right margin.', {
  calls: [{ name: 'edit', args: { file_path: '/Users/miguel/work/lantern/app/posters/page.tsx', old_string: 'export default function Posters()', new_string: 'export default function Posters({ searchParams })' } }],
})
last = a.n
last = answer(last, 'branch@36', a.calls[0], 'The file app/posters/page.tsx has been edited.')
a = agent(last, 'branch@36', 'Panel needs a print-flavored entrance — paper sliding under a press. 240ms ease-out, translateX from the margin.', {
  calls: [{ name: 'write', args: { file_path: '/Users/miguel/work/lantern/app/posters/plate-panel.tsx', content: '// plate detail side panel' } }],
})
last = a.n
last = answer(last, 'branch@36', a.calls[0], 'File created successfully at: /Users/miguel/work/lantern/app/posters/plate-panel.tsx')

// subagent branch: verify the build while main continues
const ver = sys(null, 'subagent@1', 'You are a Verifier subagent of Devin, an AI software engineer.', 1)
user(ver, 'subagent@1', 'Build the project and report any type or compile errors in app/posters. Do not fix anything.')
b = agent(1 + ver, 'subagent@1', 'Running the production build.', {
  calls: [{ name: 'exec', args: { command: 'npm run build 2>&1 | tail -30' } }],
})
blast = b.n
blast = answer(blast, 'subagent@1', b.calls[0], 'Failed to compile.\n\n./app/posters/page.tsx:41:23\nType error: Property \'plate\' does not exist on type \'SearchParams\'.')
b = agent(blast, 'subagent@1', 'One type error: searchParams is a Promise in this Next version — needs await. Nothing else.', { secs: 3 })
blast = b.n

// a two-node peel: dead handoff (becomes a works spur)
const dead = node(20, 'branch@52', msg('assistant', ''), 1)
node(dead, 'branch@52', msg('system', '<dead_handoff> archived context window'), 1)

// main: fix the type error the verifier found
a = agent(last, 'branch@36', 'The verifier caught it — searchParams is async in this version. Awaiting it.', {
  calls: [{ name: 'edit', args: { file_path: '/Users/miguel/work/lantern/app/posters/page.tsx', old_string: 'const plate = searchParams.plate', new_string: 'const { plate } = await searchParams' } }],
})
last = a.n
last = answer(last, 'branch@36', a.calls[0], 'The file app/posters/page.tsx has been edited.')
a = agent(last, 'branch@36', 'Rebuilding to confirm.', {
  calls: [{ name: 'exec', args: { command: 'npm run build 2>&1 | tail -12' } }],
})
last = a.n
last = answer(last, 'branch@36', a.calls[0], '✓ Compiled successfully in 3.2s\n✓ Generating static pages (8/8)')
a = agent(last, 'branch@36', 'Build is green. Now the paper texture — a generated noise plate, not a stock image, so the repo stays self-contained.', {
  calls: [{ name: 'write', args: { file_path: '/Users/miguel/work/lantern/app/posters/paper.tsx', content: '// SVG turbulence paper grain' } }],
  thinking: 'feTurbulence at low opacity over cream — real letterpress tooth without shipping a bitmap.',
})
last = a.n
last = answer(last, 'branch@36', a.calls[0], 'File created successfully at: /Users/miguel/work/lantern/app/posters/paper.tsx')

// second sidekick: visual pass
const vis = sys(null, 'subagent@2', 'You are a Visual-pass subagent of Devin, an AI software engineer.', 1)
user(vis, 'subagent@2', 'Screenshot /posters at 1440px and at 390px. Check the grid doesn\'t collapse and the plate panel doesn\'t overflow.')
b = agent(1 + vis, 'subagent@2', 'Booting the dev server and shooting both widths.', {
  calls: [{ name: 'exec', args: { command: 'npm run dev & sleep 3 && shoot 1440 && shoot 390' } }],
})
blast = b.n
blast = answer(blast, 'subagent@2', b.calls[0], 'wrote shots/1440.png shots/390.png')
b = agent(blast, 'subagent@2', 'At 390 the grid is one column — right — but the plate panel covers the full width; it should sheet from the bottom on small screens.', { secs: 2 })
blast = b.n
b = agent(blast, 'subagent@2', 'Fix applied locally in my sandbox only: media query → bottom sheet under 640px. Looks right in the reshoot.', {})

// main: apply the mobile fix + finish
a = agent(last, 'branch@36', 'Applying the reviewer\'s alt fix and the mobile bottom-sheet while I\'m in the file.', {
  calls: [{ name: 'edit', args: { file_path: '/Users/miguel/work/lantern/app/posters/page.tsx', old_string: '<img src={p.thumb}/>', new_string: '<img src={p.thumb} alt={`${p.title} poster`}/>' } }],
})
last = a.n
last = answer(last, 'branch@36', a.calls[0], 'The file app/posters/page.tsx has been edited.')
a = agent(last, 'branch@36', 'And the sheet-on-mobile panel rule.', {
  calls: [{ name: 'edit', args: { file_path: '/Users/miguel/work/lantern/app/posters/posters.module.css', old_string: '.panel { position: fixed; right: 0 }', new_string: '@media (max-width: 640px) { .panel { inset: auto 0 0 0 } }' } }],
})
last = a.n
last = answer(last, 'branch@36', a.calls[0], 'The file app/posters/posters.module.css has been edited.')
a = agent(last, 'branch@36', 'Final check across the touched files, then commit.', {
  calls: [{ name: 'exec', args: { command: 'npm run build 2>&1 | tail -6 && git add -A && git status --short' } }],
})
last = a.n
last = answer(last, 'branch@36', a.calls[0], '✓ Compiled successfully\n M app/posters/page.tsx\n A app/posters/plate-panel.tsx\n A app/posters/paper.tsx\n M app/posters/posters.module.css')
a = agent(last, 'branch@36', 'All green. Committing as one change: the grid, the margin panel, the grain.', {
  calls: [{ name: 'exec', args: { command: 'git commit -m "posters: editorial print grid + plate panel"' } }],
})
last = a.n
last = answer(last, 'branch@36', a.calls[0], '[main 8f31c2e] posters: editorial print grid + plate panel\n 4 files changed, 212 insertions(+), 18 deletions(-)')
node(last, 'branch@36', msg('assistant', 'Done — /posters is now a print-style grid with plate captions, the detail view opens as a right-margin panel (bottom sheet under 640px), alt text is in, and the paper grain is generated SVG so nothing binary ships. Committed as 8f31c2e.'), 3)

// pad the trunk with a realistic tail: a few thinking/idle beats
// (keeps the terminus from being a single lonely stop)

// ---- codex session (small, second service) --------------------------------
const codex = []
const cx = (o) => codex.push(JSON.stringify(o))
const ct = (s) => new Date(T0 + 3600e3 + s * 1e3).toISOString()
cx({ timestamp: ct(0), ordinal: 0, type: 'session_meta', payload: { session_id: 'palette-c3', id: 'palette-c3', cwd: '/Users/miguel/work/palette', originator: 'codex_exec' } })
cx({ timestamp: ct(0), ordinal: 0, type: 'task_started', payload: { turn_id: 'turn-1' } })
cx({ timestamp: ct(2), ordinal: 1, type: 'item_completed', payload: { item: { type: 'UserMessage', content: [{ type: 'text', text: 'rename the --dry flag to --check everywhere, keep the old one as a hidden alias' }] } } })
cx({ timestamp: ct(5), ordinal: 2, type: 'reasoning', payload: { summary: [{ type: 'summary_text', text: 'Find every place --dry is parsed or mentioned, then add a hidden alias.' }] } })
cx({ timestamp: ct(7), ordinal: 3, type: 'custom_tool_call', payload: { name: 'exec', arguments: JSON.stringify({ command: 'rg -n "dry" src bin docs' }), call_id: 'c1' } })
cx({ timestamp: ct(9), ordinal: 4, type: 'custom_tool_call_output', payload: { call_id: 'c1', output: 'src/args.ts:12  bin/palette:4  docs/cli.md:9' } })
cx({ timestamp: ct(12), ordinal: 5, type: 'custom_tool_call', payload: { name: 'exec', arguments: JSON.stringify({ command: 'sed -i "" s/--dry/--check/g src/args.ts bin/palette docs/cli.md' }), call_id: 'c2' } })
cx({ timestamp: ct(14), ordinal: 6, type: 'custom_tool_call_output', payload: { call_id: 'c2', output: '' } })
cx({ timestamp: ct(16), ordinal: 7, type: 'custom_tool_call', payload: { name: 'exec', arguments: JSON.stringify({ command: 'node bin/palette --dry && node bin/palette --check' }), call_id: 'c3' } })
cx({ timestamp: ct(19), ordinal: 8, type: 'custom_tool_call_output', payload: { call_id: 'c3', output: 'check only\ncheck only' } })
cx({ timestamp: ct(21), ordinal: 9, type: 'item_completed', payload: { item: { type: 'AgentMessage', content: [{ type: 'text', text: 'Done — --check is the documented flag now; --dry still works silently for muscle memory.' }] } } })

// ---- cursor session (small, third service) --------------------------------
const cursor = []
const cu = (o) => cursor.push(JSON.stringify(o))
cu({ role: 'user', text: 'why does the vignette shader band on dark gradients?' })
cu({ role: 'assistant', text: 'Almost certainly 8-bit quantization — the gradient lives in 256 steps. Add ordered dithering in the fragment stage; it costs one texture lookup.' })
cu({ role: 'user', text: 'show me' })
cu({ role: 'assistant', text: 'See the edit in shaders/vignette.frag — a 4x4 Bayer matrix thresholds the fragment before write-out.' })

// ---- write everything -----------------------------------------------------
const w = (rel, lines) => {
  const p = join(out, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, lines)
  console.log('wrote', rel, lines.length ?? `${lines.split('\n').length} lines`)
}

const sessionMeta = {
  id: 'lantern-press',
  title: 'posters: editorial print grid + plate panel',
  model: 'swe-2-high',
  working_directory: '/Users/miguel/work/lantern',
  main_chain_id: 6,
  subagents: ['sidekick', 'subagent@1', 'subagent@2'],
  created_at: new Date(T0).toISOString(),
  last_activity_at: new Date(t).toISOString(),
}
w('devin/lantern-press/nodes.jsonl', nodes.map((n) => JSON.stringify(n)).join('\n') + '\n')
w('devin/lantern-press/session.json', JSON.stringify(sessionMeta, null, 2))
w('codex/rollout-2026-10-09T17-20-00-palette.jsonl', codex.join('\n') + '\n')
w('cursor/chat-sable/messages.jsonl', cursor.join('\n') + '\n')
w('cursor/chat-sable/meta.json', JSON.stringify({ title: 'vignette banding', cwd: '/Users/miguel/work/shaderbox' }, null, 2))
w('manifest.json', JSON.stringify({
  sessions: [
    { id: 'lantern-press', agent: 'devin', title: sessionMeta.title, cwd: sessionMeta.working_directory },
    { id: 'palette', agent: 'codex', title: 'palette: --dry → --check rename' },
    { id: 'chat-sable', agent: 'cursor', title: 'vignette banding fix' },
  ],
}, null, 2))
console.log('demo:', nodes.length, 'devin nodes,', codex.length, 'codex rows,', cursor.length, 'cursor rows')
