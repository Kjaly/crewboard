/**
 * Every animation the graph plays, in one place, so the spec's motion table can be read off the code.
 * All of it is optional: jsdom and older shells have no Web Animations API, and reduced motion
 * replaces movement with a short opacity change — never with nothing at all, so the event is still seen.
 */

const EASE_OUT = 'cubic-bezier(.23,1,.32,1)'
const EASE_FLOW = 'cubic-bezier(.77,0,.175,1)'

type Animatable = { animate?: Element['animate'] }

const can = (el: Element | null | undefined): el is Element => typeof (el as Animatable | null)?.animate === 'function'

/** New task: opacity + a hair of scale. 220 ms. */
export function appear(el: Element | null, reduced: boolean): void {
  if (!can(el)) return
  if (reduced) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' })
    return
  }
  el.animate([{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 220, easing: EASE_OUT })
}

/** Removal is faster than arrival — 150 ms — so the plan never feels like it is dissolving. */
export function leave(el: Element | null, reduced: boolean): void {
  if (!can(el)) return
  const frames = reduced ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.96)' }]
  el.animate(frames, { duration: 150, easing: EASE_OUT, fill: 'forwards' })
}

/** One outline ping, only on the transitions that matter: start, trouble, acceptance, unblocking. */
export function flash(el: HTMLElement | null, color: string, reduced: boolean): void {
  if (!can(el)) return
  el.style.setProperty('--orc-ping', color)
  if (reduced) {
    el.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 560, easing: 'ease-out' })
    return
  }
  el.animate([{ opacity: 0.75, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.09)' }], { duration: 520, easing: EASE_OUT })
}

/** Causality made visible: light runs along the edge, and only then the dependent task wakes up. */
export function lightEdge(path: SVGPathElement | null, reduced: boolean, done: () => void): void {
  if (!can(path) || typeof path.getTotalLength !== 'function' || reduced) {
    done()
    return
  }
  const length = path.getTotalLength() || 0
  if (length === 0) {
    done()
    return
  }
  path.classList.add('orc-gedge--flow')
  path.style.strokeDasharray = String(length)
  const animation = path.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration: 420, easing: EASE_FLOW })
  const finish = () => {
    path.classList.remove('orc-gedge--flow')
    path.style.strokeDasharray = ''
    done()
  }
  animation.addEventListener?.('finish', finish)
  if (!animation.addEventListener) finish()
}

/** A cubic that leaves the source on the right and arrives at the target on the left. */
export function edgePath(a: { x: number; y: number }, b: { x: number; y: number }, width: number, height: number): string {
  const x1 = a.x + width
  const y1 = a.y + height / 2
  const x2 = b.x
  const y2 = b.y + height / 2
  const mx = (x1 + x2) / 2
  return `M${x1} ${y1} C${mx} ${y1},${mx} ${y2},${x2 - 2} ${y2}`
}
