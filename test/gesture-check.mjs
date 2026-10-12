// gesture-check.mjs — proves the three new interactions on the built preview.
import { chromium } from 'playwright'
const url = process.argv[2] ?? 'http://localhost:4174'
const b = await chromium.launch()
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.log('  ✗', m) } }

// --- mobile viewport: sheet open, map still pans, fling closes the sheet
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } })
const p = await ctx.newPage()
await p.goto(url, { waitUntil: 'networkidle' })
await p.waitForTimeout(2600)
const camTx = () => p.evaluate(() => document.querySelector('.plano')?.style.transform ?? '')

const pt = await p.evaluate(() => {
  const st = [...document.querySelectorAll('[data-sid]')].find((e) => {
    const r = e.getBoundingClientRect()
    return r.left > 60 && r.left < 330 && r.top > 260 && r.top < 560
  })
  if (!st) return null
  const r = st.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})
ok(!!pt, 'found a tappable station')
if (pt) {
  await p.mouse.click(pt.x, pt.y)
  await p.waitForTimeout(450)
  ok(!!(await p.$('.inspector')), 'sheet opens on tap')

  // pan the map while the sheet is open — drag starts on visible map
  const before = await camTx()
  await p.mouse.move(195, 200)
  await p.mouse.down()
  for (let i = 1; i <= 8; i++) await p.mouse.move(195 + i * 14, 200)
  await p.mouse.up()
  await p.waitForTimeout(250)
  ok((await camTx()) !== before, 'map pans while the sheet is open')

  // fling the grab rail down fast → sheet closes
  const rail = await p.$('.inspector .grab')
  ok(!!rail, 'grab rail present')
  const rr = await rail.boundingBox()
  const ry = rr.y + rr.height / 2
  await p.mouse.move(rr.x + rr.width / 2, ry)
  await p.mouse.down()
  for (let i = 1; i <= 5; i++) await p.mouse.move(rr.x + rr.width / 2, ry + i * 50)
  await p.mouse.up()
  await p.waitForTimeout(500)
  const live = await p.$('.inspector:not(.closing)')
  ok(!live, 'downward fling throws the sheet away')
}
await p.close()

// --- desktop: the opening dive is gesture-cancellable
const p2 = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await p2.goto(url, { waitUntil: 'networkidle' })
await p2.waitForTimeout(400) // inside the 780ms pre-dive window
const k0 = await p2.evaluate(() => document.querySelector('.plano').style.transform)
await p2.mouse.move(720, 450)
await p2.mouse.down()
await p2.mouse.move(780, 450, { steps: 4 })
await p2.mouse.up()
const k1 = await p2.evaluate(() => document.querySelector('.plano').style.transform)
await p2.waitForTimeout(1400) // past the dive deadline
const k2 = await p2.evaluate(() => document.querySelector('.plano').style.transform)
ok(k0 !== k1, 'user drag panned during the opening window')
ok(k1 === k2, 'no late dive after a user gesture')
await p2.close()
await b.close()
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
