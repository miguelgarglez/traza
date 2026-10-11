// M1 layout test: metro.ts turns every fixture + the real export into an
// octilinear network. Run: node test/metro.mjs [path-to-export-dir]
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
execSync('node scripts/make-fixtures.mjs', { cwd: root, stdio: 'inherit' })

const { ingest } = await import('../src/lib/parse/ingest.ts')
const { buildNetwork, rideRoute, P, U } = await import('../src/lib/metro.ts')

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

const octi = (dx, dy) => dx === 0 || dy === 0 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.01

function checkWeave(weave, tag) {
  const t0 = performance.now()
  const net = buildNetwork(weave)
  const ms = performance.now() - t0
  ok(net.corridors.length === weave.sessions.length, `${tag}: ${net.corridors.length} corridors`)

  let allStations = 0
  let allSteps = 0
  let badOcti = 0
  const seen = new Set()
  let dupPos = 0
  let rodeEvery = 0

  for (const c of net.corridors) {
    const route = rideRoute(c)
    const routeIds = new Set(route.map((r) => r.station.id))
    for (const l of c.lines) {
      allStations += l.stations.length
      for (const s of l.stations) {
        const k = `${Math.round(s.x)},${Math.round(s.y)}`
        if (seen.has(k)) dupPos++
        seen.add(k)
        if (!routeIds.has(s.id)) rodeEvery++
      }
      for (const sg of l.segs) {
        if (sg.kind === 'link') continue // transfer links are free-form connectors
        for (let i = 1; i < sg.pts.length; i++) {
          const dx = sg.pts[i].x - sg.pts[i - 1].x
          const dy = sg.pts[i].y - sg.pts[i - 1].y
          if (!octi(dx, dy)) badOcti++
        }
        // no track ever doubles back left
        for (let i = 1; i < sg.pts.length; i++) {
          if (sg.pts[i].x < sg.pts[i - 1].x - 0.01) badOcti++
        }
      }
    }
    for (const s of c.session.threads) allSteps += s.steps.length
    ok(route.length >= c.lines.reduce((n, l) => n + l.stations.length, 0), `${tag}: ride covers stations (${route.length})`)
  }
  ok(dupPos === 0, `${tag}: no two stations share a point (${dupPos})`)
  ok(badOcti === 0, `${tag}: every track point octilinear + forward-only (${badOcti})`)
  ok(rodeEvery === 0, `${tag}: every station reachable on a line (${rodeEvery})`)
  ok(Number.isFinite(net.bounds.x1) && net.bounds.x1 > net.bounds.x0, `${tag}: bounds sane (${Math.round(net.bounds.x1)}px)`)
  ok(ms < 400, `${tag}: layout fast enough (${ms.toFixed(0)}ms)`)
  return net
}

console.log('— fixtures —')
checkWeave(ingest(collect(join(root, 'fixtures'))), 'fx')

const dir = process.argv[2]
if (dir && existsSync(dir)) {
  console.log('— real export —')
  const net = checkWeave(ingest(collect(dir)), 'real')
  console.log(`  i stations=${net.stats.stations} lines=${net.stats.lines} works=${net.stats.works}`)
  const big = net.corridors.reduce((a, b) => (a.lines.reduce((n, l) => n + l.stations.length, 0) > b.lines.reduce((n, l) => n + l.stations.length, 0) ? a : b))
  const branches = big.lines.filter((l) => !l.trunk)
  ok(branches.length >= 3, `real: big corridor has ${branches.length} branch lines`)
  ok(big.works.length >= 1, `real: works spurs present (${big.works.length})`)
  const joins = branches.filter((b) => b.mergeStation)
  ok(joins.length >= 1, `real: some branches rejoin (${joins.length})`)
} else {
  console.log('— no real export dir (pass one as argv[2]) —')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
