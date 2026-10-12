import { chromium } from 'playwright'
const out = process.env.OUT
const url = 'http://localhost:4174'
const b = await chromium.launch()

// desktop opening sequence: wide frame, mid-flight, landed
const p1 = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await p1.goto(url, { waitUntil: 'networkidle' })
await p1.waitForTimeout(350)
await p1.screenshot({ path: `${out}/c-open-wide.png` })
await p1.waitForTimeout(700)
await p1.screenshot({ path: `${out}/c-open-flight.png` })
await p1.waitForTimeout(1200)
await p1.screenshot({ path: `${out}/c-open-landed.png` })
// guide step 1 (sign restyle) — advance time so it appears
await p1.waitForTimeout(1400)
await p1.screenshot({ path: `${out}/c-guide1.png` })
// click a station → inspector (day) — pick a mid-trunk station
await p1.evaluate(() => {
  const el = document.querySelector('[data-sid]')
  el?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }))
})
// easier: use the app click path — tap at a station's screen pos
await p1.evaluate(() => window.scrollTo(0,0))
// click canvas center where a station is
await p1.mouse.click(760, 470)
await p1.waitForTimeout(500)
await p1.screenshot({ path: `${out}/c-sel.png` })
// ride → night
await p1.click('.dock .play')
await p1.waitForTimeout(2600)
await p1.screenshot({ path: `${out}/c-night.png` })
await p1.waitForTimeout(1800)
await p1.screenshot({ path: `${out}/c-night-b.png` })
await p1.close()

// mobile
const p2 = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage()
await p2.goto(url, { waitUntil: 'networkidle' })
await p2.waitForTimeout(2400)
await p2.screenshot({ path: `${out}/c-mobile.png` })
// open a station sheet
await p2.touchscreen.tap(190, 500)
await p2.waitForTimeout(500)
await p2.screenshot({ path: `${out}/c-mobile-sel.png` })
await b.close()
