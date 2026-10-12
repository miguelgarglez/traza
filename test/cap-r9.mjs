// cap-r9.mjs — the r9 review evidence package.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const out = process.env.OUT
mkdirSync(out, { recursive: true })
const url = 'http://localhost:4174'
const b = await chromium.launch()

// ---------- desktop ----------
const c1 = await b.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: out, size: { width: 1440, height: 900 } } })
const p = await c1.newPage()
await p.goto(url, { waitUntil: 'networkidle' })
await p.waitForTimeout(400)
await p.screenshot({ path: `${out}/r9-wide.png` })      // beat 1: the system frame
await p.waitForTimeout(1900)
await p.screenshot({ path: `${out}/r9-open.png` })      // landed on the neighborhood
await p.waitForTimeout(900)
await p.screenshot({ path: `${out}/r9-guide.png` })     // guide step 1 sign
// pan → step 2 (interchange sign)
await p.mouse.move(700, 500); await p.mouse.down()
await p.mouse.move(760, 500, { steps: 5 }); await p.mouse.up()
await p.waitForTimeout(900)
await p.screenshot({ path: `${out}/r9-guide2.png` })
// select a station → inspector (also advances guide to 3)
const sel = await p.evaluate(() => {
  const st = [...document.querySelectorAll('[data-sid]')].find((e) => {
    const r = e.getBoundingClientRect()
    return r.left > 500 && r.left < 1000 && r.top > 300 && r.top < 560
  })
  if (!st) return null
  const r = st.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})
if (sel) {
  await p.mouse.click(sel.x, sel.y)
  await p.waitForTimeout(600)
  await p.screenshot({ path: `${out}/r9-sel.png` })
  // close → mid-exit frame
  await p.click('.inspector .x')
  await p.waitForTimeout(110)
  await p.screenshot({ path: `${out}/r9-closing.png` })
  await p.waitForTimeout(300)
}
// finder
await p.keyboard.press('/')
await p.waitForTimeout(400)
await p.type('.finder input', 'poster')
await p.waitForTimeout(300)
await p.screenshot({ path: `${out}/r9-finder.png` })
await p.keyboard.press('Escape')
await p.waitForTimeout(300)
// ride → night, follow suspend, terminus approach
await p.click('.dock .play')
await p.waitForTimeout(2400)
await p.screenshot({ path: `${out}/r9-night.png` })
// suspend follow with a gesture → resume pill
await p.mouse.move(700, 400); await p.mouse.down()
await p.mouse.move(780, 400, { steps: 5 }); await p.mouse.up()
await p.waitForTimeout(500)
await p.screenshot({ path: `${out}/r9-follow.png` })
await p.waitForTimeout(2600)
await p.screenshot({ path: `${out}/r9-night-b.png` })
await p.close()
await c1.close() // flushes r9 video

// ---------- mobile ----------
const c2 = await b.newContext({ viewport: { width: 390, height: 844 } })
const m = await c2.newPage()
await m.goto(url, { waitUntil: 'networkidle' })
await m.waitForTimeout(500)
await m.screenshot({ path: `${out}/r9-mobile-wide.png` })
await m.waitForTimeout(1900)
await m.screenshot({ path: `${out}/r9-mobile.png` })
await m.waitForTimeout(900)
await m.screenshot({ path: `${out}/r9-mobile-guide.png` })
// sheet compact → expanded
const msel = await m.evaluate(() => {
  const st = [...document.querySelectorAll('[data-sid]')].find((e) => {
    const r = e.getBoundingClientRect()
    return r.left > 60 && r.left < 330 && r.top > 240 && r.top < 520
  })
  if (!st) return null
  const r = st.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})
if (msel) {
  await m.mouse.click(msel.x, msel.y)
  await m.waitForTimeout(600)
  await m.screenshot({ path: `${out}/r9-mobile-sel.png` })
  await m.click('.inspector .grab')
  await m.waitForTimeout(500)
  await m.screenshot({ path: `${out}/r9-mobile-full.png` })
}
// night ride on mobile
await m.click('.dock .play')
await m.waitForTimeout(2800)
await m.screenshot({ path: `${out}/r9-mobile-ride.png` })
await m.close()
await c2.close()

// ---------- ride stills ----------
const c3 = await b.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: out, size: { width: 1440, height: 900 } } })
const r = await c3.newPage()
await r.goto(url, { waitUntil: 'networkidle' })
await r.evaluate(() => localStorage.setItem('traza.guide', '1'))
await r.waitForTimeout(2400)
await r.click('.dock .play')
await r.waitForTimeout(1000)
await r.screenshot({ path: `${out}/r9-frame-1.png` })
await r.waitForTimeout(3000)
await r.screenshot({ path: `${out}/r9-frame-4.png` })
await r.waitForTimeout(3000)
await r.screenshot({ path: `${out}/r9-frame-7.png` })
await r.close()
await c3.close()
await b.close()
console.log('done')
