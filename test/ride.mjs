// ride.mjs — route generation checks for the replay engine.
// Run: node test/ride.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const { ingest } = await import('../src/lib/parse/ingest.ts')
const { buildNetwork } = await import('../src/lib/metro.ts')
const { buildRide, legPoint } = await import('../src/lib/ride.ts')

let pass = 0,
  fail = 0
const ok = (cond, msg) => {
  if (cond) {
    pass++
    console.log('  ✓', msg)
  } else {
    fail++
    console.log('  ✗', msg)
  }
}

// ---- the bundled demo export ----
const DEMO_PATHS = [
  'devin/lantern-press/nodes.jsonl',
  'devin/lantern-press/session.json',
  'codex/rollout-2026-10-09T17-20-00-palette.jsonl',
  'cursor/chat-sable/messages.jsonl',
  'cursor/chat-sable/meta.json',
  'manifest.json',
]
const files = DEMO_PATHS.map((p) => ({ path: `demo/${p}`, text: readFileSync(join(root, 'public/demo', p), 'utf8') }))
const weave = await ingest(files)
const net = buildNetwork(weave)
ok(net.corridors.length >= 3, `demo network has ${net.corridors.length} corridors (>=3)`)

for (let ci = 0; ci < net.corridors.length; ci++) {
  const c = net.corridors[ci]
  const ride = buildRide(net, ci)
  ok(ride !== null, `corridor ${ci} ride builds`)
  if (!ride || !ride.legs.length) {
    console.log(`    corridor ${ci} (${c.session.title}): no rideable route (${ride?.stops.length ?? 0} stops)`)
    continue
  }
  ok(ride.stops.length === ride.legs.length + 1, `corridor ${ci}: stops = legs + 1 (${ride.stops.length} stops)`)
  ok(
    ride.legs.every((l) => l.len > 0 && Number.isFinite(l.len)),
    `corridor ${ci}: leg lengths finite`,
  )
  ok(
    ride.legs.every((l) =>
      l.path.every((seg) => seg.length > 1 && seg.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))),
    ),
    `corridor ${ci}: all paths finite, no empty subpaths`,
  )
  ok(
    ride.legs.every((l) => {
      const last = l.path.at(-1).at(-1)
      return Math.hypot(last.x - l.stop.x, last.y - l.stop.y) < 1
    }),
    `corridor ${ci}: every leg ends at its stop`,
  )
  ok(
    ride.legs.every((l, i) => {
      const first = l.path[0][0]
      const prev = ride.stops[i]
      return Math.hypot(first.x - prev.x, first.y - prev.y) < 1
    }),
    `corridor ${ci}: every leg starts where the last stop left it`,
  )
  const mid = legPoint(ride.legs[0], ride.legs[0].len / 2)
  ok(Number.isFinite(mid.x) && Number.isFinite(mid.y), `corridor ${ci}: legPoint mid finite`)
  const end = legPoint(ride.legs.at(-1), ride.legs.at(-1).len)
  const lastStop = ride.stops.at(-1)
  ok(Math.hypot(end.x - lastStop.x, end.y - lastStop.y) < 1, `corridor ${ci}: legPoint(len) lands on last stop`)
  const lineIds = new Set(ride.stops.map((s) => s.lineId).filter(Boolean))
  if (c.lines.length > 1) ok(lineIds.size > 1, `corridor ${ci}: ride crosses ${lineIds.size} lines`)
  console.log(`    corridor ${ci} (${c.session.title}): ${ride.stops.length} stops, ${ride.legs.length} legs, ${Math.round(ride.total)}px`)
}

// hop legs: works visits and far links produce multi-subpath legs
const demoRide = buildRide(net, 0)
const hops = demoRide.legs.filter((l) => l.path.length > 1).length
console.log(`    multi-subpath legs in corridor 0: ${hops}`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
