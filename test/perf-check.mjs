// perf-check.mjs — load the real 11-session export (2070 stations) into the
// production preview via the ?test hook, then measure pan fps, ride motion,
// and reduced-motion behavior. Run: node test/perf-check.mjs [export-dir]
import { chromium } from 'playwright'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.BASE_URL || 'http://localhost:4174'
const dir = process.argv[2] || join(process.env.HOME, 'Developer/_lab/runs/20261011-123731-l1/hackathon-export')

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name) } }

const collect = (d, base = d) => {
  const out = []
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) out.push(...collect(p, base))
    else out.push({ path: p.slice(base.length + 1), text: readFileSync(p, 'utf8') })
  }
  return out
}

if (!existsSync(dir)) {
  console.log(`export dir not found: ${dir}`)
  process.exit(1)
}
const allFiles = collect(dir)
// the criterion is a 1200-step session: load only the biggest one for the
// fps pass, then the full 11-session export for the load/rides pass
const bySession = new Map()
for (const f of allFiles) {
  const key = f.path.split('/').slice(0, 2).join('/')
  bySession.set(key, [...(bySession.get(key) ?? []), f])
}
const biggest = [...bySession.values()].sort((a, b) => b.reduce((n, f) => n + f.text.length, 0) - a.reduce((n, f) => n + f.text.length, 0))[0]
const fpsFiles = [...allFiles.filter((f) => !f.path.includes('/')), ...biggest]
const files = allFiles
console.log(`export: ${files.length} files, biggest session ${biggest.length} files`)

// headed: headless Chromium throttles rAF to ~25fps regardless of content,
// so fps numbers are only honest with a real compositor
const browser = await chromium.launch({ headless: false })

// --- 0. environment ceiling: rAF on a blank page in this browser ------------
const ctx0 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const blank = await ctx0.newPage()
await blank.goto('about:blank')
const ceiling = await blank.evaluate(
  () =>
    new Promise((res) => {
      let n = 0
      const t = performance.now()
      const loop = () => {
        n++
        if (performance.now() - t < 1200) requestAnimationFrame(loop)
        else res((n * 1000) / (performance.now() - t))
      }
      requestAnimationFrame(loop)
    }),
)
await ctx0.close()
console.log(`  i environment rAF ceiling ≈ ${ceiling.toFixed(0)}fps`)

// --- 1. big-network load + pan fps ----------------------------------------
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

await page.goto(`${BASE}/?test`)
await page.waitForFunction(() => typeof window.__trazaLoad === 'function', null, { timeout: 8000 })
const t0 = Date.now()
await page.evaluate((fs) => window.__trazaLoad(fs, false), fpsFiles)
await page.waitForSelector('.st', { timeout: 15000 })
await page.waitForSelector('.dock .play', { timeout: 15000 })
const stations = await page.$$eval('.st', (e) => e.length)
ok(stations > 1000, `real export renders ${stations} stations in ${Date.now() - t0}ms`)

// pan: hold the mouse and sweep while counting rAF frames
await page.mouse.move(720, 450)
await page.mouse.down()
const fpsPromise = page.evaluate(
  () =>
    new Promise((res) => {
      let n = 0
      const t = performance.now()
      const loop = () => {
        n++
        if (performance.now() - t < 2000) requestAnimationFrame(loop)
        else res((n * 1000) / (performance.now() - t))
      }
      requestAnimationFrame(loop)
    }),
)
for (let i = 0; i < 60; i++) await page.mouse.move(720 + Math.sin(i / 5) * 520, 450 + Math.cos(i / 5) * 260)
const fps = await fpsPromise
await page.mouse.up()
console.log(`  i pan fps ≈ ${fps.toFixed(0)} (ceiling ${ceiling.toFixed(0)})`)
ok(fps >= Math.min(55, ceiling * 0.9), `1200-step network pans at display rate (${fps.toFixed(0)} of ~${ceiling.toFixed(0)})`)

// --- 2. ride on the full 11-session network --------------------------------
await page.evaluate((fs) => window.__trazaLoad(fs, false), files)
await page.waitForSelector('.dock .play', { timeout: 15000 })
const stopText = () => page.$eval('.dock .ridesub', (e) => e.textContent).catch(() => '')
await page.click('.dock .play')
await page.waitForSelector('.plano.riding', { timeout: 4000 })
await page.waitForTimeout(2500)
const s1 = await stopText()
await page.waitForTimeout(2500)
const s2 = await stopText()
await page.click('.dock .play') // pause
ok(s1 !== s2, `ride advances on real network (${s1} → ${s2})`)
ok(errors.length === 0, `zero console errors on real export (${errors.length})`)

// --- 3. reduced motion -----------------------------------------------------
const rp = await (await browser.newContext({ reducedMotion: 'reduce' })).newPage()
await rp.goto(BASE)
await rp.waitForSelector('.st', { timeout: 10000 })
await rp.waitForTimeout(300)
const fresh = await rp.$eval('svg.plano', (e) => e.classList.contains('fresh'))
ok(!fresh, 'reduced-motion skips the track-laying animation')

await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
