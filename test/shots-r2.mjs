// shots-r2.mjs — docs screenshots of the live trenza build
import { chromium } from 'playwright'
const out = 'docs'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const p = await ctx.newPage()
await p.goto('https://traza-sand.vercel.app', { waitUntil: 'networkidle' })
await p.waitForSelector('.dock', { timeout: 20000 })
await p.waitForTimeout(5000) // landed + guide tag
await p.screenshot({ timeout: 90000, animations: 'allow', path: out + '/hero.png' })

// falls open
await p.click('header button:has-text("falls")')
await p.waitForTimeout(1400)
await p.screenshot({ timeout: 90000, animations: 'allow', path: out + '/falls.png' })

// click longest bar → knot + inspector, then close the sheet
const longest = await p.$('.fcp')
if (longest) {
  const bb = await longest.boundingBox()
  await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2)
  await p.waitForTimeout(2000)
}
await p.click('button[aria-label="close the waterfall"]').catch(() => {})
await p.waitForSelector('.fallsheet', { state: 'detached', timeout: 10000 }).catch(() => {})
await p.waitForTimeout(800)
await p.screenshot({ timeout: 90000, animations: 'allow', path: out + '/inspector.png' })

// replay: study mode, mid-walk
await p.keyboard.press('Escape').catch(() => {})
await p.waitForSelector('.fallsheet', { state: 'detached', timeout: 5000 }).catch(() => {})
await p.evaluate(() => document.querySelector('.fallsheet')?.remove())
await p.click('.dock .play')
await p.waitForTimeout(7000)
await p.screenshot({ timeout: 90000, animations: 'allow', path: out + '/shuttle.png' })
await p.click('.dock .play')

// mobile
await p.setViewportSize({ width: 375, height: 700 })
await p.waitForTimeout(1200)
await p.screenshot({ timeout: 90000, animations: 'allow', path: out + '/mobile.png' })
await b.close()
console.log('done')
