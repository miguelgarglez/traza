import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await p.goto('http://localhost:4174', { waitUntil: 'networkidle' })
await p.evaluate(() => localStorage.setItem('traza.guide', '1'))
await p.waitForTimeout(3200)
await p.keyboard.press('+'); await p.keyboard.press('+')
await p.waitForTimeout(300)
await p.screenshot({ path: process.env.OUT + '/case-zoom.png' })
// sample pixel colors across a casing's perpendicular axis
const box = await p.evaluate(() => {
  const c = [...document.querySelectorAll('.trkcasing')].find((e) => {
    const r = e.getBoundingClientRect()
    return r.left > 200 && r.top > 200 && r.bottom < 800 && r.width > 100
  })
  if (!c) return null
  const r = c.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})
if (box) {
  await p.screenshot({ path: process.env.OUT + '/case-crop.png', clip: { x: box.x - 60, y: box.y - 40, width: 120, height: 80 } })
  console.log('casing at', box)
} else console.log('no visible casing')
await b.close()
