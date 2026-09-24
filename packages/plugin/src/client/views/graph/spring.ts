/**
 * The graph's whole motion budget: one critically damped spring per axis plus Apple's inertia
 * projection. Every animation is re-targetable mid-flight — the spring keeps its current position
 * and velocity, which is what makes a drag interruptible and a burst of events read as one move.
 */
export type Spring = { x: number; v: number }

export const spring = (x = 0): Spring => ({ x, v: 0 })

/** Fixed sub-step so a dropped frame cannot blow the integrator up. */
const MAX_STEP = 1 / 120

/**
 * Apple's spring parameters: `response` is how long the spring takes to travel, `damping` is the
 * damping ratio — 1.0 means «arrives without overshoot», which is what a work tool wants.
 */
export function springStep(s: Spring, target: number, dt: number, response = 0.38, damping = 1): void {
  const w = (2 * Math.PI) / response
  const steps = Math.max(1, Math.ceil(dt / MAX_STEP))
  const h = dt / steps
  for (let i = 0; i < steps; i += 1) {
    const a = -w * w * (s.x - target) - 2 * damping * w * s.v
    s.v += a * h
    s.x += s.v * h
  }
}

/** Reduced motion, or a fresh node: jump there and stop. */
export function snap(s: Spring, target: number): void {
  s.x = target
  s.v = 0
}

export function settled(s: Spring, target: number, eps = 0.4): boolean {
  return Math.abs(s.x - target) < eps && Math.abs(s.v) < eps * 4
}

/** Where a flick of `velocity` px/s comes to rest under UIScrollView-style deceleration. */
export function project(velocity: number, decel = 0.998): number {
  return (velocity / 1000) * (decel / (1 - decel))
}

/** Rubber band past an edge: the further you pull, the less the canvas follows. */
export function rubber(value: number, min: number, max: number, dimension = 420, c = 0.55): number {
  if (value > max) {
    const over = value - max
    return max + (over * dimension * c) / (dimension + c * over)
  }
  if (value < min) {
    const over = min - value
    return min - (over * dimension * c) / (dimension + c * over)
  }
  return value
}

export const clamp = (v: number, min: number, max: number): number => (min > max ? (min + max) / 2 : Math.min(max, Math.max(min, v)))
