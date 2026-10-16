// film-footage-r2.mjs — capture the live trenza build as footage for the
// round-2 launch film. Square 1080x1080 viewport at deviceScaleFactor 2.
// Run: node test/film-footage-r2.mjs [url]   (default live site)
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { renameSync } from 'node:fs'

const out = process.env.OUT || 'video/assets/footage/r2'
mkdirSync(out, { recursive: true })
const url = process.argv[2] ?? 'https://traza-sand.vercel.app'
const b = await chromium.launch()

async function take(name, drive, { guide = false } = {}) {
  const ctx = await b.newContext({
    viewport: { width: 1080, height: 1080 },
    deviceScaleFactor: 2,
    recordVideo: { dir: out, size: { width: 1080, height: 1080 } },
  })
  const p = await ctx.newPage()
  if (!guide)
    await p.addInitScript(() => localStorage.setItem('traza.guide', '1'))
  await p.goto(url, { waitUntil: 'networkidle' })
  await p.waitForSelector('.dock', { timeout: 20000 })
  await drive(p)
  const v = p.video()
  await ctx.close()
  renameSync(await v.path(), `${out}/${name}.webm`)
  console.log('shot', name)
}

// A: cold boot — the weave draws itself on the cloth, chrome lands,
// the hanging-tag guide settles. Keep the tag: it is the first-run voice.
await take('a-load', async (p) => {
  await p.waitForTimeout(9000)
}, { guide: true })

// B: the geography — all three strands + the gold tether, then the
// session stabs fly the camera between sessions.
await take('b-fit', async (p) => {
  await p.waitForTimeout(4600) // opening dive lands, chrome in
  // slow drift so the cloth feels alive
  await p.mouse.move(540, 500)
  await p.mouse.down()
  for (let i = 0; i < 26; i++) {
    await p.mouse.move(540 + i * 2.4, 500 - i * 0.9, { steps: 1 })
    await p.waitForTimeout(34)
  }
  await p.mouse.up()
  await p.waitForTimeout(900)
  // hop the sessions via their selvedge stabs in the header
  const stabs = p.locator('header .stab')
  await stabs.nth(1).click()
  await p.waitForTimeout(1600)
  await stabs.nth(2).click()
  await p.waitForTimeout(1600)
  await stabs.nth(0).click()
  await p.waitForTimeout(1400)
})

// C: the question — open "time on the loom", take the longest span,
// land on its knot, inspector answers.
await take('c-falls', async (p) => {
  await p.waitForTimeout(4600)
  await p.click('header button:has-text("falls")')
  await p.waitForTimeout(1500) // sheet settles, bars readable
  const longest = await p.$('.fcp')
  if (longest) {
    const bb = await longest.boundingBox()
    await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 6 })
    await p.waitForTimeout(500) // let the flag read
    await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2)
  }
  await p.waitForTimeout(2100) // camera flies to the knot, inspector opens
  await p.click('.fallsheet button.x').catch(() => {})
  await p.waitForTimeout(2600) // hold on the inspector's answer
})

// D: the hand-off — inspector already open on the knot, click the
// "sidekick unthreads here" tether link, camera follows the gold thread.
await take('d-tether', async (p) => {
  await p.waitForTimeout(4600)
  await p.click('header button:has-text("falls")')
  await p.waitForTimeout(1400)
  const longest = await p.$('.fcp')
  if (longest) {
    const bb = await longest.boundingBox()
    await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2)
  }
  await p.waitForTimeout(2000)
  await p.click('.fallsheet button.x').catch(() => {})
  await p.waitForTimeout(700)
  const link = await p.$('.inspector a, .inspector button:has-text("unthreads")')
  if (link) {
    const lb = await link.boundingBox()
    await p.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2, { steps: 5 })
    await p.waitForTimeout(600)
    await link.click()
  }
  await p.waitForTimeout(3200) // camera follows the gold thread
})

// E: run the shuttle — study pace, lamplight down, inspector walks
// knot to knot, the loomline reed fills amber.
await take('e-study', async (p) => {
  await p.waitForTimeout(4600)
  await p.click('.dock .play')
  await p.waitForTimeout(14000) // ~10 knots at study pace
})

// F: end plate — the landed weave held calm, nothing moving.
await take('z-end', async (p) => {
  await p.waitForTimeout(4600)
  await p.waitForTimeout(4000)
})

await b.close()
console.log('done')
