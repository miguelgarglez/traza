// film-footage.mjs — capture the real product as footage for the launch film.
// Square 1080x1080 viewport at deviceScaleFactor 2 → crisp plates + motion.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const out = process.env.OUT || 'video/assets/footage'
mkdirSync(out, { recursive: true })
const url = process.argv[2] ?? 'http://localhost:4174'
const b = await chromium.launch()

async function take(name, seconds, drive) {
  const ctx = await b.newContext({
    viewport: { width: 1080, height: 1080 },
    deviceScaleFactor: 2,
    recordVideo: { dir: out, size: { width: 1080, height: 1080 } },
  })
  const p = await ctx.newPage()
  await p.addInitScript(() => localStorage.clear())
  await p.goto(url, { waitUntil: 'networkidle' })
  await drive(p)
  await p.waitForTimeout(seconds * 1000)
  const v = p.video()
  await ctx.close()
  const path = await v.path()
  await import('node:fs').then(fs => fs.renameSync(path, `${out}/${name}.webm`))
  console.log('shot', name)
}

// A: cold boot — track-laying + held wide beat + the dive (no gestures)
await take('a-boot', 5.5, async () => {})

// B: reading zoom — labels + dual-rail casing; slow pan across the trunk
await take('b-near', 6, async (p) => {
  await p.waitForTimeout(3600) // let the opening land
  // zoom to near on a labeled stretch
  await p.mouse.move(540, 540)
  for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, -240); await p.waitForTimeout(120) }
  await p.waitForTimeout(700)
  // slow drift pan
  await p.mouse.move(540, 540); await p.mouse.down()
  for (let i = 0; i < 40; i++) { await p.mouse.move(540 + i * 3, 540 - i, { steps: 1 }); await p.waitForTimeout(30) }
  await p.mouse.up()
})

// C: station select → inspector
await take('c-select', 5.5, async (p) => {
  await p.waitForTimeout(3800)
  await p.click('.maptools button[aria-label*="center" i], .maptools button').catch(() => {})
  const st = p.locator('.st').nth(6)
  await st.click()
})

// D: junction + key open
await take('d-key', 5, async (p) => {
  await p.waitForTimeout(3800)
  await p.locator('.keyhead').click()
})

// E: the night ride — play through terminus ALL CHANGE
await take('e-ride', 14, async (p) => {
  await p.waitForTimeout(3800)
  await p.locator('.dock .play').click()
})

await b.close()
console.log('done')
