// The walkthrough's studio layer, injected into the live app: a cursor that glides, a ripple on click, captions,
// a camera that zooms onto what matters, and title cards. Nothing here changes the app itself.

/** Runs in the page before the app (page.addInitScript). Exposes window.__studio. */
export function studioInit() {
  const css = `
  #st-cursor{position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgb(255 255 255/.92);box-shadow:0 0 0 1.5px rgb(17 17 19/.55),0 4px 12px rgb(0 0 0/.35);z-index:2147483646;pointer-events:none;transition:transform 160ms cubic-bezier(.23,1,.32,1)}
  #st-cursor.down{transform:scale(.8)}
  .st-ripple{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:2px solid rgb(240 136 79/.9);z-index:2147483645;pointer-events:none;animation:st-ripple 560ms cubic-bezier(.23,1,.32,1) forwards}
  @keyframes st-ripple{from{opacity:1;transform:scale(.4)}to{opacity:0;transform:scale(1.25)}}
  #st-cap{position:fixed;left:50%;bottom:28px;max-width:80%;padding:11px 18px;border-radius:12px;background:rgb(17 17 19/.82);color:#f4f4f5;font:500 17px/1.35 Geist,system-ui,sans-serif;letter-spacing:-.01em;backdrop-filter:blur(12px);box-shadow:0 10px 30px rgb(0 0 0/.35),0 0 0 1px rgb(255 255 255/.08);z-index:2147483644;pointer-events:none;opacity:0;transform:translate(-50%,8px);transition:opacity 260ms ease-out,transform 260ms cubic-bezier(.23,1,.32,1)}
  #st-cap.on{opacity:1;transform:translate(-50%,0)}
  #st-card{position:fixed;inset:0;display:grid;place-items:center;align-content:center;gap:14px;background:#0d0d0f;background-image:radial-gradient(60% 55% at 18% 0%,rgb(240 136 79/.12),transparent 70%);color:#ededef;font-family:Geist,system-ui,sans-serif;z-index:2147483647;transition:opacity 600ms ease-out}
  #st-card.off{opacity:0;pointer-events:none}
  #st-card h1{font-size:64px;font-weight:600;letter-spacing:-.045em;line-height:1}
  #st-card h1 b{color:#f0884f;font-weight:600}
  #st-card p{font-size:20px;color:#a7a7ae;letter-spacing:-.01em;max-width:30ch;text-align:center;line-height:1.4}
  #st-card code{font:500 15px "Geist Mono",ui-monospace,monospace;color:#f6a77a;padding:6px 12px;border-radius:8px;background:rgb(240 136 79/.1)}
  body{transform-origin:0 0;transition:transform 900ms cubic-bezier(.65,0,.35,1)}`
  const mount = () => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    const root = document.documentElement
    const cursor = Object.assign(document.createElement('div'), { id: 'st-cursor' })
    const cap = Object.assign(document.createElement('div'), { id: 'st-cap' })
    const card = Object.assign(document.createElement('div'), { id: 'st-card' })
    root.append(cursor, cap, card)
    addEventListener('mousemove', (e) => {
      cursor.style.left = `${e.clientX}px`
      cursor.style.top = `${e.clientY}px`
    }, true)
    addEventListener('mousedown', (e) => {
      cursor.classList.add('down')
      const r = Object.assign(document.createElement('div'), { className: 'st-ripple' })
      r.style.left = `${e.clientX}px`
      r.style.top = `${e.clientY}px`
      root.append(r)
      setTimeout(() => r.remove(), 700)
    }, true)
    addEventListener('mouseup', () => cursor.classList.remove('down'), true)
    window.__studio = {
      caption(text) {
        if (!text) return cap.classList.remove('on')
        cap.classList.remove('on')
        setTimeout(() => {
          cap.textContent = text
          cap.classList.add('on')
        }, cap.textContent ? 200 : 0)
      },
      // Moves the camera so the box (viewport coordinates at scale 1) sits in the middle, without showing past the page edge.
      zoom(box, s = 1.35) {
        if (!box) {
          document.body.style.transform = ''
          return
        }
        const vw = innerWidth
        const vh = innerHeight
        const clamp = (v, lo) => Math.min(0, Math.max(lo, v))
        const tx = clamp(vw / 2 - s * (box.x + box.width / 2), vw - s * vw)
        const ty = clamp(vh / 2 - s * (box.y + box.height / 2), vh - s * vh)
        document.body.style.transform = `translate(${tx}px,${ty}px) scale(${s})`
      },
      card(html) {
        if (!html) return card.classList.add('off')
        card.innerHTML = html
        card.classList.remove('off')
      },
    }
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mount)
  else mount()
}

/** Page-side helpers that drive the studio layer and the mouse like a person would. */
export const director = (page) => {
  let at = { x: 640, y: 420 }
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
  const glideTo = async (x, y, ms = 750) => {
    const from = at
    const steps = Math.max(8, Math.round(ms / 16))
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps)
      await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k)
      await page.waitForTimeout(ms / steps)
    }
    at = { x, y }
  }
  const centre = async (locator) => {
    const b = await locator.boundingBox()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  return {
    pause: (ms) => page.waitForTimeout(ms),
    glide: async (locator, ms) => {
      const c = await centre(locator)
      await glideTo(c.x, c.y, ms)
    },
    glideTo,
    click: async (locator, ms = 750) => {
      const c = await centre(locator)
      await glideTo(c.x, c.y, ms)
      await page.waitForTimeout(140)
      await page.mouse.down()
      await page.waitForTimeout(90)
      await page.mouse.up()
    },
    caption: (text) => page.evaluate((t) => window.__studio.caption(t), text),
    zoom: async (locator, scale) => {
      const box = locator ? await locator.boundingBox() : null
      await page.evaluate(([b, s]) => window.__studio.zoom(b, s), [box, scale])
      await page.waitForTimeout(950)
    },
    card: (html) => page.evaluate((h) => window.__studio.card(h), html),
  }
}
