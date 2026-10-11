// Engine test: parsers + weave + redaction on synthetic fixtures and,
// when present, the real hackathon export (dev fixture, never committed).
// Run: node test/engine.mjs [path-to-export-dir]
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
execSync('node scripts/make-fixtures.mjs', { cwd: root, stdio: 'inherit' })

const { ingest } = await import('../src/lib/parse/ingest.ts')
const { buildTape } = await import('../src/lib/weave.ts')
const { redactText, countSecrets } = await import('../src/lib/redact.ts')

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name) } }

const collect = (dir, base = dir) => {
  const out = []
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (!p.endsWith('.db')) out.push({ path: relative(base, p), text: readFileSync(p, 'utf8') })
    }
  }
  walk(dir)
  return out
}

console.log('— fixtures —')
const fx = collect(join(root, 'fixtures'))
const weave = ingest(fx)
ok(weave.sessions.length === 4, `4 sessions parsed (got ${weave.sessions.length})`)
const byAgent = Object.fromEntries(weave.sessions.map((s) => [s.agent, s]))
ok(!!byAgent.devin && !!byAgent.codex && !!byAgent.cursor && !!byAgent.atif, 'all four agents present')

const devin = byAgent.devin
ok(devin.threads.filter((t) => t.kind === 'branch').length >= 1, `devin has a branch lane (${devin.threads.filter((t) => t.kind === 'branch').length})`)
ok(devin.threads.find((t) => t.kind === 'branch')?.label === 'sidekick', 'branch labeled sidekick')
const spine = devin.threads.find((t) => t.kind === 'spine')
ok(spine && spine.steps.some((s) => s.actor === 'user'), 'spine has user steps')
ok(devin.title === 'fern CLI: add --json output', `manifest title applied (${devin.title})`)

const dtape = buildTape(devin)
ok(dtape.rows.length > 10, `devin tape rows (${dtape.rows.length})`)
ok(dtape.lanes.filter((l) => l.lane === 1).length >= 1, 'sidekick on lane 1')
ok(dtape.tangles.length >= 1, `summarizer collapsed to tangle (${dtape.tangles.length})`)
const sidekick = dtape.lanes.find((l) => l.label === 'sidekick')
ok(sidekick && sidekick.forkGi != null, 'sidekick fork anchored')

const codex = byAgent.codex
const ctape = buildTape(codex)
ok(ctape.rows.some((r) => r.step.calls?.some((c) => c.name === 'exec')), 'codex tool calls parsed')
ok(ctape.rows.some((r) => r.step.kind === 'reasoning'), 'codex reasoning step present')
ok(weave.stats.redactions >= 1, `fixture secret counted (${weave.stats.redactions})`)
const leak = codex.threads[0].steps.flatMap((s) => s.calls ?? []).map((c) => c.result ?? '').join('\n')
ok(countSecrets(leak) >= 1, 'secret visible in raw parse')
ok(!redactText(leak).text.includes('FAKEKEY'), 'redactor patches it')
ok(byAgent.cursor.timed === false, 'cursor marked untimed')
ok(byAgent.cursor.threads[0].steps.some((s) => s.calls?.length), 'cursor tool calls parsed')
ok(byAgent.atif.threads.filter((t) => t.kind === 'branch').length === 1, 'atif subagent trajectory woven')

// — real export, if provided —
const realDir = process.argv[2] ?? process.env.LAB_EXPORT
if (realDir && existsSync(realDir)) {
  console.log('— real export —')
  const t0 = performance.now()
  const rw = ingest(collect(realDir))
  const ms = performance.now() - t0
  console.log(`  ingested in ${ms.toFixed(0)}ms`)
  ok(rw.sessions.length === 11, `11 sessions (${rw.sessions.length})`)
  const rn = rw.sessions.find((s) => s.id.includes('righteous-nest'))
  ok(!!rn, 'righteous-nest present')
  const tape = buildTape(rn)
  const t1 = performance.now()
  const tape2 = buildTape(rn)
  void tape2
  console.log(`  righteous-nest: ${tape.rows.length} rows, ${tape.lanes.length} lanes, ${tape.tangles.length} tangles, weave ${(performance.now() - t1).toFixed(0)}ms`)
  ok(tape.rows.length > 800, 'rows flattened')
  ok(tape.lanes.filter((l) => l.kind === 'branch').length >= 5, `branch lanes (${tape.lanes.filter((l) => l.kind === 'branch').length})`)
  ok(tape.lanes.some((l) => l.label === 'sidekick'), 'sidekick lane exists')
  const stepsTotal = rn.threads.reduce((n, t) => n + t.steps.length, 0)
  const markSteps = tape.tangles.reduce((n, m) => n + m.count, 0)
  // Conservation: every raw node is accounted for — on a thread, in a mark,
  // merged into a tool-call result ('tool' role), or an empty stub dropped.
  let nodes = 0, toolNodes = 0
  for (const line of readFileSync(join(realDir, 'devin/righteous-nest/nodes.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue
    nodes++
    const m = JSON.parse(line).message
    if (m.role === 'tool') toolNodes++
  }
  console.log(`  conservation: ${stepsTotal} steps + ${markSteps} mark steps + ${toolNodes} merged tool nodes ≈ ${nodes} nodes`)
  ok(stepsTotal > 800, `thread steps total (${stepsTotal})`)
  ok(stepsTotal + markSteps + toolNodes > nodes - 100, `nothing lost: ${stepsTotal}+${markSteps}+${toolNodes} of ${nodes}`)
  // Displayed text never shows secrets: inject one into a real step and check.
  const victim = rn.threads[0].steps.find((s) => s.body) ?? rn.threads[0].steps[0]
  victim.body = (victim.body ?? '') + '\nkey: sk-ant-' + 'X'.repeat(40)
  ok(countSecrets(victim.body) >= 1, 'injected secret detected')
  ok(!redactText(victim.body).text.includes('sk-ant'), 'injected secret redacted in display')
  ok(ms < 3000, `ingest fast enough (${ms.toFixed(0)}ms < 3000)`)
} else {
  console.log('— no real export dir (pass one as argv[2]) —')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
