import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { placePopover, type Placement, type Side } from './tour-placement.js'

export const TOUR_KEY = 'crewboard:introduction-seen'
export function tourSeen(): boolean { try { return globalThis.localStorage?.getItem(TOUR_KEY) === '1' } catch { return false } }
export function markTourSeen(): void { try { globalThis.localStorage?.setItem(TOUR_KEY, '1') } catch { /* storage is optional */ } }

/** What each step points at; the step text names the same thing. */
export const TOUR_TARGETS = ['.orc-graph-wrap [data-task-id="build"]', '.orc-work', '.orc-panel .orc-report', '.orc-welcome__card--start'] as const
export const TOUR_STEPS = TOUR_TARGETS.length
// The report sits beside the Review money cards: below or above it keeps them in view.
const TOUR_PREFER: ReadonlyArray<readonly Side[]> = [[], [], ['bottom', 'top'], []]
// An attribute, not a class: React rewrites `className` whenever the target re-renders.
const HIGHLIGHT = 'data-tour-target'
// Used until the popover has been measured (and in environments without layout).
const FALLBACK_SIZE = { width: 320, height: 170 }

/** The part of the target that is on screen: a tall column is placed against what the user can see. */
function visibleBox(target: HTMLElement) {
  const box = target.getBoundingClientRect()
  const left = Math.max(0, box.left)
  const top = Math.max(0, box.top)
  return { left, top, width: Math.max(0, Math.min(window.innerWidth, box.right) - left), height: Math.max(0, Math.min(window.innerHeight, box.bottom) - top) }
}

export function Tour({ step, onStep, onClose }: { step: number; onStep(step: number): void; onClose(): void }) {
  const [placement, setPlacement] = useState<Placement | undefined>()
  const popover = useRef<HTMLElement>(null)
  const primary = useRef<HTMLButtonElement>(null)
  const last = step === TOUR_STEPS - 1
  // Focus returns to whatever the user was on before the tour opened.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => { if (before?.isConnected) before.focus() }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each new step moves focus to its primary button.
  useEffect(() => { primary.current?.focus() }, [step])
  useLayoutEffect(() => {
    const selector = TOUR_TARGETS[step]
    let target: HTMLElement | null = null
    const update = () => {
      const found = selector ? document.querySelector<HTMLElement>(selector) : null
      if (found !== target) {
        target?.removeAttribute(HIGHLIGHT)
        found?.setAttribute(HIGHLIGHT, '')
        target = found
      }
      const measured = popover.current?.getBoundingClientRect()
      const size = measured?.width ? { width: measured.width, height: measured.height } : FALLBACK_SIZE
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      // Until the target mounts, wait in the bottom corner rather than over the content.
      const next: Placement = found ? placePopover(visibleBox(found), size, viewport, TOUR_PREFER[step]) : { left: Math.max(14, viewport.width - 14 - size.width), top: Math.max(14, viewport.height - 14 - size.height), side: 'overlay' }
      setPlacement((old) => old && old.left === next.left && old.top === next.top && old.side === next.side ? old : next)
    }
    update()
    // Views and the task panel mount a moment after the step changes.
    const timers = [120, 350, 800].map((ms) => setTimeout(update, ms))
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      for (const timer of timers) clearTimeout(timer)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      target?.removeAttribute(HIGHLIGHT)
    }
  }, [step])
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopImmediatePropagation(); onClose() } }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [onClose])
  return <aside ref={popover} className={`orc-tour${placement ? ` orc-tour--${placement.side}` : ''}`} style={placement ? { left: placement.left, top: placement.top } : undefined} role="dialog" aria-label={t('welcome.eyebrow')} aria-modal="false" aria-describedby="orc-tour-text">
    <p className="orc-tour__count">{t('welcome.tourCount', { step: step + 1, total: TOUR_STEPS })}</p>
    <p id="orc-tour-text">{t(`welcome.tour${step + 1}`)}</p>
    <div className="orc-tour__actions">
      {step > 0 ? <button type="button" onClick={() => onStep(step - 1)}>{t('welcome.tourBack')}</button> : null}
      <button ref={primary} type="button" className="orc-tour__primary" onClick={() => last ? onClose() : onStep(step + 1)}>{last ? t('welcome.tourDone') : t('welcome.tourNext')}</button>
      {last ? null : <button type="button" className="orc-tour__skip" onClick={onClose}>{t('welcome.tourSkip')}</button>}
    </div>
  </aside>
}
