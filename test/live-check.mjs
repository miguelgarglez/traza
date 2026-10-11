// live-check.mjs — drive the production preview: core loop + 5s ride video + cross-engine smoke.
// Run: node test/live-check.mjs [url]   (default http://localhost:4174)
import { chromium, firefox, webkit } from 'playwright'
import { mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const url = process.argv[2] ?? 'http://localhost:4174'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'test/out')
mkdirSync(out, { recursive: true })

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

// ---------- chromium: full core loop + ride video ----------
const videoDir = join(out, 'video')
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForSelector('.dock .play', { timeout: 10000 })
ok(true, 'demo plano loaded with transport dock')

// station click → inspector (dispatch on the station element so data-sid is the target)
await page.evaluate(() => {
  const s = document.querySelector('.st')
  const r = s.getBoundingClientRect()
  for (const t of ['pointerdown', 'pointerup'])
    s.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 1, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
})
await page.waitForSelector('.inspector h2', { timeout: 3000 })
ok(true, 'station click opens inspector')

// ride for 5 seconds while recording
await page.keyboard.press('Escape')
await page.click('.dock .play')
await page.waitForTimeout(1200)
ok(await page.$eval('svg.plano', (e) => e.classList.contains('riding')), 'night service engaged while riding')
await page.waitForTimeout(4000)
await page.click('.dock .play') // pause
ok(!(await page.$eval('svg.plano', (e) => e.classList.contains('riding'))), 'day returns on pause')

// finder
await page.keyboard.press('/')
await page.waitForSelector('.finder input')
await page.fill('.finder input', 'edit')
const hit = await page.waitForSelector('.finder li')
await hit.click()
await page.waitForTimeout(900)
ok(await page.$eval('.inspector', (e) => !!e), 'finder fly-to selects a station')

await page.screenshot({ path: join(out, 'verify-desktop.png') })
await page.setViewportSize({ width: 375, height: 700 })
await page.waitForTimeout(400)
await page.screenshot({ path: join(out, 'verify-mobile.png') })
ok(true, 'screenshots captured 1440/375')

await ctx.close() // flushes the video
await browser.close()

const video = execFileSync('ls', ['-t', videoDir]).toString().trim().split('\n')[0]
if (video) {
  const vid = join(videoDir, video)
  // extract 3 stills, 1.5s apart, assert they differ
  for (const [i, t] of [
    ['a', '1.0'],
    ['b', '2.5'],
    ['c', '4.0'],
  ]) {
    execFileSync('ffmpeg', ['-y', '-ss', t, '-i', vid, '-frames:v', '1', join(out, `still-${i}.png`)], { stdio: 'pipe' })
  }
  const { createHash } = await import('node:crypto')
  const { readFileSync } = await import('node:fs')
  const h = (f) => createHash('md5').update(readFileSync(join(out, `still-${f}.png`))).digest('hex')
  const [ha, hb, hc] = [h('a'), h('b'), h('c')]
  ok(ha !== hb && hb !== hc, 'ride animation actually moves (recorded stills differ)')
} else {
  ok(false, 'ride video recorded')
}
ok(errors.length === 0, `zero console errors (${errors.length})`)
if (errors.length) console.log(errors.slice(0, 5))

// ---------- firefox + webkit: load, ride, screenshot ----------
for (const [name, engine] of [['firefox', firefox], ['webkit', webkit]]) {
  try {
    const b = await engine.launch()
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
    const errs = []
    p.on('pageerror', (e) => errs.push(String(e)))
    await p.goto(url, { waitUntil: 'networkidle' })
    await p.waitForSelector('.dock .play', { timeout: 10000 })
    await p.click('.dock .play')
    await p.waitForTimeout(2500)
    const riding = await p.$eval('svg.plano', (e) => e.classList.contains('riding'))
    const trainVisible = await p.$eval('.train', (e) => e.style.display !== 'none')
    await p.screenshot({ path: join(out, `verify-${name}.png`) })
    await p.click('.dock .play')
    await b.close()
    ok(riding && trainVisible, `${name}: night ride runs, train token visible`)
    ok(errs.length === 0, `${name}: zero page errors`)
  } catch (e) {
    ok(false, `${name}: ${String(e).slice(0, 120)}`)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
