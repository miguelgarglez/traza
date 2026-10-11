// Render the network to a standalone SVG for eye review, then screenshot it.
// Run: node test/render.mjs [export-dir] [out.png]
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const { ingest } = await import('../src/lib/parse/ingest.ts')
const { buildNetwork } = await import('../src/lib/metro.ts')

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

const dir = process.argv[2] && existsSync(process.argv[2]) ? process.argv[2] : join(root, 'fixtures')
const weave = ingest(collect(dir))
const net = buildNetwork(weave)

const pad = 60
const W = net.bounds.x1 - net.bounds.x0 + pad * 2
const H = net.bounds.y1 - net.bounds.y0 + pad * 2
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${net.bounds.x0 - pad} ${net.bounds.y0 - pad} ${W} ${H}" font-family="Fira Sans Condensed, Fira Sans, sans-serif">
<rect x="${net.bounds.x0 - pad}" y="${net.bounds.y0 - pad}" width="${W}" height="${H}" fill="#EDF0F5"/>
`
for (const c of net.corridors) {
  for (const l of c.lines) {
    for (const sg of l.segs) {
      const d = sg.pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')
      if (sg.kind === 'link') {
        svg += `<path d="${d}" fill="none" stroke="${l.color}" stroke-width="3" stroke-dasharray="3 6" stroke-linecap="round" opacity="0.75"/>`
        if (sg.far) svg += `<text x="${sg.pts.at(-1).x + 8}" y="${sg.pts.at(-1).y + 3}" font-size="9.5" fill="${l.color}" opacity=".8">↩ main</text>`
      }
      else svg += `<path d="${d}" fill="none" stroke="${l.color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`
    }
  }
  for (const l of c.lines) {
    for (const s of l.stations) {
      if (s.tier === 'terminus') svg += `<circle cx="${s.x}" cy="${s.y}" r="5.5" fill="#fff" stroke="${l.color}" stroke-width="3.5"/>`
      else if (s.tier === 'interchange') svg += `<circle cx="${s.x}" cy="${s.y}" r="6.5" fill="#fff" stroke="#1C2733" stroke-width="2.5"/><circle cx="${s.x}" cy="${s.y}" r="2.6" fill="${l.color}"/>`
      else if (s.tier === 'major') svg += `<circle cx="${s.x}" cy="${s.y}" r="4" fill="#fff" stroke="${l.color}" stroke-width="2.6"/>`
      else svg += `<circle cx="${s.x}" cy="${s.y}" r="2.2" fill="${l.color}"/>`
    }
  }
  for (const w of c.works) {
    const a = c.lines.flatMap((l) => l.stations).find((s) => s.id === w.at.stationId)
    if (a) svg += `<path d="M${a.x} ${a.y} l${w.x - a.x > 0 ? 12 : -12} ${Math.min(30, w.y - a.y)}" stroke="#5A6B80" stroke-width="2.5" stroke-dasharray="4 4" fill="none"/><rect x="${w.x - 8}" y="${w.y - 8}" width="16" height="16" rx="3" fill="#fff" stroke="#5A6B80" stroke-width="2"/><text x="${w.x}" y="${w.y + 4}" text-anchor="middle" font-size="10" font-weight="600" fill="#1C2733">${w.count > 9 ? '9+' : w.count}</text>`
  }
  for (const lb of c.labels) {
    if (lb.lod > 1) continue
    const a = c.lines.flatMap((l) => l.stations).find((s) => s.id === lb.stationId)
    if (!a) continue
    svg += `<text x="${lb.x}" y="${lb.y}" font-size="9.5" font-weight="500" fill="#1C2733" text-anchor="${lb.side < 0 ? 'start' : 'end'}" transform="rotate(-35 ${lb.x} ${lb.y})">${esc(lb.text)}</text>`
  }
  const trunk = c.lines.find((l) => l.trunk)
  if (trunk) svg += `<text x="${trunk.stations[0]?.x - 20 ?? 0}" y="${c.trunkY - 16}" font-size="13" font-weight="700" fill="${trunk.color}" text-anchor="end">${esc(trunk.service)}</text>`
}
svg += '</svg>'

// also emit a detail crop around the densest junction cluster
const allPts = net.corridors.flatMap((c) => c.lines.flatMap((l) => l.segs.flatMap((s) => s.pts)))
const branchXs = net.corridors.flatMap((c) => c.lines.filter((l) => !l.trunk).flatMap((l) => l.stations.map((s) => s.x)))
const midX = branchXs.length ? branchXs.sort((a, b) => a - b)[Math.floor(branchXs.length / 2)] : 400
const crop = { x: midX - 420, y: -160, w: 1400, h: 560 }
const cropSvg = svg.replace(
  /viewBox="[^"]+"/,
  `viewBox="${crop.x} ${crop.y} ${crop.w} ${crop.h}"`,
)

mkdirSync(join(root, 'test', 'out'), { recursive: true })
const svgPath = join(root, 'test', 'out', 'plano.svg')
writeFileSync(svgPath, svg)
writeFileSync(join(root, 'test', 'out', 'plano-detail.svg'), cropSvg)
console.log('wrote', svgPath, `(${Math.round(W)}x${Math.round(H)}, ${net.stats.stations} stations, ${net.stats.lines} lines, ${net.stats.works} works)`)

const out = process.argv[3] ?? join(root, 'test', 'out', 'm1-plano.png')
try {
  const { chromium } = await import('playwright')
  const b = await chromium.launch()
  const pg = await b.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1.5 })
  await pg.goto('file://' + svgPath)
  await pg.waitForTimeout(300)
  await pg.screenshot({ path: out, fullPage: false })
  await pg.goto('file://' + join(root, 'test', 'out', 'plano-detail.svg'))
  await pg.waitForTimeout(200)
  await pg.screenshot({ path: join(root, 'test', 'out', 'm1-detail.png') })
  await b.close()
  console.log('shot', out)
} catch (e) {
  console.log('no playwright shot:', e.message)
}
