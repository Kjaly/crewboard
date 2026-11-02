// Studio scenes for the documentation media: a macOS window or a phone around a raw capture, on a soft
// background in the screen's own palette. Used by scripts/capture-media.mjs; renders through the same browser.
import { readFileSync } from 'node:fs'

const palette = {
  dark: { bg: '#0d0d0f', glow: 'rgb(240 136 79 / .10)', glow2: 'rgb(123 156 240 / .06)', bar: '#1c1c20', line: 'rgb(255 255 255 / .08)', title: '#a7a7ae', shadow: '0 50px 100px -20px rgb(0 0 0 / .65), 0 30px 60px -30px rgb(0 0 0 / .7)' },
  light: { bg: '#e7e6e1', glow: 'rgb(194 65 12 / .07)', glow2: 'rgb(59 99 196 / .05)', bar: '#f1f1ee', line: 'rgb(24 24 27 / .10)', title: '#55555c', shadow: '0 50px 100px -20px rgb(60 50 40 / .28), 0 30px 60px -30px rgb(60 50 40 / .30)' },
}

const dataUrl = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`
const font = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif`

const backdrop = (p) =>
  `background:${p.bg};background-image:radial-gradient(60% 55% at 18% 0%, ${p.glow}, transparent 70%),radial-gradient(50% 50% at 100% 100%, ${p.glow2}, transparent 70%);`

/** The macOS window chrome as HTML. `inner` fills the content area of size w×h (CSS pixels). */
export const windowHtml = ({ scheme, title, w, h, inner, pad = 80, canvas }) => {
  const p = palette[scheme]
  const bar = 40
  const cw = canvas?.w ?? w + pad * 2
  const ch = canvas?.h ?? h + bar + pad * 2
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${cw}px;height:${ch}px;overflow:hidden}
body{${backdrop(p)}display:grid;place-items:center;font-family:${font}}
.win{width:${w}px;border-radius:12px;overflow:hidden;box-shadow:${p.shadow},0 0 0 1px ${p.line};background:${p.bar}}
.bar{height:${bar}px;display:flex;align-items:center;position:relative;padding:0 16px;border-bottom:1px solid ${p.line}}
.dots{display:flex;gap:8px}.dots i{width:12px;height:12px;border-radius:50%;display:block;box-shadow:inset 0 0 0 .5px rgb(0 0 0/.18)}
.t{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:500;color:${p.title};letter-spacing:-.01em}
.t span{opacity:.6;font-weight:400;margin-left:8px}
.c{width:${w}px;height:${h}px;display:block}
</style></head><body><div class="win"><div class="bar"><div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div><div class="t">${title}</div></div>${inner}</div></body></html>`
}

/** Renders a raw desktop capture inside a macOS window. */
export const frameWindow = async (browser, { src, scheme, out, w = 1440, h = 900 }) => {
  const html = windowHtml({ scheme, title: 'Crewboard<span>127.0.0.1:4700</span>', w, h, inner: `<img class="c" src="${dataUrl(src)}">` })
  await render(browser, html, out, 1.5)
}

/** Renders a raw phone capture inside a phone body, below a status bar as on a real phone. */
export const framePhone = async (browser, { src, scheme, out, w = 390, h = 844 }) => {
  const p = palette[scheme]
  const app = scheme === 'dark' ? { bg: '#111113', fg: '#ededef' } : { bg: '#f6f6f4', fg: '#18181b' }
  const pad = 70
  const rim = 12
  const status = 50
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${w + rim * 2 + pad * 2}px;height:${h + status + rim * 2 + pad * 2}px;overflow:hidden}
body{background:transparent;display:grid;place-items:center;font-family:${font}}
.phone{position:relative;padding:${rim}px;border-radius:${56 + rim}px;background:#0a0a0b;box-shadow:${p.shadow},0 0 0 1.5px #2a2a2e,inset 0 0 0 1px #3a3a3f}
.screen{width:${w}px;border-radius:56px;overflow:hidden;background:${app.bg}}
.status{height:${status}px;display:flex;align-items:center;justify-content:space-between;padding:6px 34px 0 44px;color:${app.fg};font-size:16px;font-weight:600;letter-spacing:-.01em}
.status .r{display:flex;gap:6px;align-items:center}
.status .bat{width:25px;height:12px;border-radius:4px;border:1.5px solid currentColor;opacity:.9;position:relative}
.status .bat::after{content:'';position:absolute;inset:1.5px;right:5px;border-radius:2px;background:currentColor}
.status .sig{display:flex;gap:2px;align-items:flex-end;height:11px}.status .sig i{width:3px;background:currentColor;border-radius:1px;display:block}
.screen img{display:block;width:${w}px;height:${h}px}
.island{position:absolute;top:${rim + 11}px;left:50%;width:120px;height:34px;margin-left:-60px;border-radius:20px;background:#000}
</style></head><body><div class="phone"><div class="screen"><div class="status" data-pending><span>9:41</span><span class="r"><span class="sig"><i style="height:4px"></i><i style="height:6px"></i><i style="height:8px"></i><i style="height:11px"></i></span><span class="bat"></span></span></div><img src="${dataUrl(src)}"></div><div class="island"></div></div><script>
// The status bar takes the colour of the screen's top edge, so a dimmed screen under a sheet stays one surface.
const img = document.querySelector('.screen img')
img.decode().then(() => {
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = 4
  const g = c.getContext('2d')
  g.drawImage(img, 0, 0)
  const [r, gr, b] = g.getImageData(Math.floor(img.naturalWidth / 2), 1, 1, 1).data
  const bar = document.querySelector('.status')
  bar.style.background = 'rgb(' + r + ' ' + gr + ' ' + b + ')'
  bar.style.color = 0.299 * r + 0.587 * gr + 0.114 * b > 140 ? '#18181b' : '#f4f4f5'
  bar.removeAttribute('data-pending')
})
</script></body></html>`
  await render(browser, html, out, 2, true)
}

/** The backdrop and window for the walkthrough, with an empty content area the video is laid into. */
export const videoStage = async (browser, { scheme, out, w, h, canvas }) => {
  await render(browser, windowHtml({ scheme, title: 'Crewboard<span>127.0.0.1:4700</span>', w, h, canvas, inner: `<div class="c"></div>` }), out, 1)
}

/** A white-on-black mask with the window's rounded bottom corners, for the video's alpha. */
export const videoMask = async (browser, { out, w, h }) => {
  const html = `<!doctype html><html><head><style>*{margin:0}html,body{width:${w}px;height:${h}px;background:#000}div{width:${w}px;height:${h}px;background:#fff;border-radius:0 0 12px 12px}</style></head><body><div></div></body></html>`
  await render(browser, html, out, 1)
}

const render = async (browser, html, out, scale, transparent = false) => {
  const page = await browser.newPage({ deviceScaleFactor: scale, viewport: { width: 400, height: 400 } })
  await page.setContent(html)
  const size = await page.evaluate(() => ({ width: document.body.scrollWidth, height: document.body.scrollHeight }))
  await page.setViewportSize(size)
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())))
  await page.waitForFunction(() => !document.querySelector('[data-pending]'))
  await page.screenshot({ path: out, omitBackground: transparent })
  await page.close()
}
