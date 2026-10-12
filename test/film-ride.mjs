import { chromium } from 'playwright'
const out = 'video/assets/footage'
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

// E1: press play, day folds to night, train cruises — LED morphing
await take('e1-depart', 8, async (p) => {
  await p.waitForTimeout(3900)
  await p.keyboard.press('Escape')
  await p.locator('.dock .play').click()
})

// E2: express-seek along the track to the last leg, then the held ALL CHANGE
await take('e2-terminus', 11, async (p) => {
  await p.waitForTimeout(3900)
  await p.keyboard.press('Escape')
  await p.locator('.dock .play').click()
  await p.waitForTimeout(2600)
  // scrub near the end — the train fast-travels the real track to it
  const r = await p.locator('.rideprog').boundingBox()
  await p.mouse.click(r.x + r.width * 0.94, r.y + r.height / 2)
})

await b.close()
console.log('done')
