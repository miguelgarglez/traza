import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await p.goto('http://localhost:4174', { waitUntil: 'networkidle' })
await p.waitForTimeout(3200)
await p.keyboard.press('+')
await p.waitForTimeout(300)
const info = await p.evaluate(() => {
  const svg = document.querySelector('.plano')
  const casing = document.querySelector('.trkcasing')
  const bed = document.querySelector('.trkbed')
  const path = document.getElementById(casing?.getAttribute('href')?.slice(1) ?? '')
  const cb = casing?.getBBox?.()
  const cs = casing ? getComputedStyle(casing) : null
  return {
    z: svg?.dataset.z,
    casingCount: document.querySelectorAll('.trkcasing').length,
    casingDisplay: cs?.display,
    casingStroke: cs?.stroke,
    casingWidth: cs?.strokeWidth,
    casingHref: casing?.getAttribute('href'),
    pathFound: !!path,
    casingBBox: cb ? { w: cb.width, h: cb.height } : null,
    casingRect: casing?.getBoundingClientRect(),
    trackRect: path?.getBoundingClientRect(),
  }
})
console.log(JSON.stringify(info, null, 1))
await b.close()
