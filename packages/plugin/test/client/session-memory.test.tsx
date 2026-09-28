// @vitest-environment jsdom
// navigation-context-28: window-session memory. Private drafts and receipts live in the shared store module,
// keyed by physical root + plan + task, survive a screen unmount, and are never written to localStorage. The
// graph camera pose is keyed by root + plan and restored on a return through the real camera.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { createCamera } from '../../src/client/views/graph/camera.js'
import {
  deliveryForRun,
  familyCopyOf,
  feedPositionOf,
  planMemoryOf,
  rememberFamilyCopy,
  rememberPlan,
  rememberTask,
  resetSessionMemory,
  restoredDelivery,
  steerSettledPatch,
  subscribeMemory,
  useTaskMemory,
  SENDING_TTL_MS,
  type Delivery,
} from '../../src/client/store.js'

const ROOT = '/repo'

afterEach(() => { cleanup(); resetSessionMemory() })

function Composer({ root, plan, task }: { root: string; plan?: string; task: string }) {
  const [memory, remember] = useTaskMemory(root, plan, task)
  const delivery = deliveryForRun(memory.delivery, undefined)
  return (
    <div>
      <textarea aria-label="draft" value={memory.draft ?? ''} onChange={(event) => remember({ draft: event.target.value })} />
      <span data-testid="receipt">{delivery?.state ?? '-'}:{delivery?.text ?? '-'}</span>
    </div>
  )
}
const draft = () => (screen.getByRole('textbox', { name: 'draft' }) as HTMLTextAreaElement).value

it('keeps each task\u2019s draft by root + plan + task, and never writes it to storage', () => {
  const { unmount } = render(<Composer root={ROOT} plan="p1" task="shared" />)
  fireEvent.change(screen.getByRole('textbox', { name: 'draft' }), { target: { value: 'hello A' } })
  unmount()
  // A same-id task in another plan is a different memory.
  const other = render(<Composer root={ROOT} plan="p2" task="shared" />)
  expect(draft()).toBe('')
  other.unmount()
  render(<Composer root={ROOT} plan="p1" task="shared" />)
  expect(draft()).toBe('hello A')
  expect(localStorage.getItem('crewboard:draft')).toBeNull()
  for (let i = 0; i < localStorage.length; i++) expect(localStorage.key(i)).not.toContain('hello A')
})

it('stores an in-flight receipt on the captured task and observes it on return, never on another task', () => {
  rememberTask(ROOT, 'p1', 'shared', { draft: 'для A', delivery: { state: 'sending', text: 'для A', runId: 'r1', at: Date.now() } })
  const first = render(<Composer root={ROOT} plan="p1" task="shared" />)
  expect(draft()).toBe('для A')
  expect(screen.getByTestId('receipt').textContent).toBe('sending:для A')
  first.unmount()
  render(<Composer root={ROOT} plan="p2" task="shared" />)
  expect(screen.getByTestId('receipt').textContent).toBe('-:-')
})

it('subscribes to memory changes so a restored screen observes a receipt that settled while unmounted', () => {
  const seen: number[] = []
  const off = subscribeMemory(() => seen.push(1))
  rememberTask(ROOT, 'p1', 'shared', { draft: 'x' })
  rememberTask(ROOT, 'p1', 'shared', { delivery: { state: 'refused', text: 'x', runId: 'r1', at: Date.now() } })
  off()
  expect(seen.length).toBe(2)
})

it('only an accepted delivered write clears the exact submitted revision', () => {
  const memory = { draft: 'text' }
  const delivered = (): Delivery => ({ state: 'delivered', text: 'text', at: Date.now(), result: { delivery: 'delivered', state: 'queued', runId: 'r1', file: 'f', message: 'text', steerId: 's' } })
  expect(steerSettledPatch(memory, 'text', delivered())).toHaveProperty('draft', '')
  // A refused or failed request keeps the text: the patch does not touch the draft at all.
  expect(steerSettledPatch(memory, 'text', { state: 'refused', text: 'text', at: Date.now() })).not.toHaveProperty('draft')
  expect(steerSettledPatch(memory, 'text', { state: 'failed', text: 'text', at: Date.now() })).not.toHaveProperty('draft')
  // A newer draft is never cleared by an older revision's answer.
  expect(steerSettledPatch({ draft: 'newer' }, 'text', delivered())).not.toHaveProperty('draft')
})

it('an aged pending receipt reads as unconfirmed client state, never as a factual failure', () => {
  const stale = { state: 'sending' as const, text: 'x', at: Date.now() - SENDING_TTL_MS - 1 }
  // Elapsed time proves nothing: the state is the client's «unconfirmed», not a claim that the send failed.
  expect(restoredDelivery(stale)?.state).toBe('unconfirmed')
  expect(restoredDelivery(stale)?.result).toBeUndefined()
  expect(restoredDelivery({ ...stale, at: Date.now() })?.state).toBe('sending')
  // A receipt captured against another run is not this run's current feedback.
  expect(deliveryForRun({ state: 'delivered', text: 'x', runId: 'r1', at: Date.now() }, 'r2')).toBeUndefined()
  expect(deliveryForRun({ state: 'delivered', text: 'x', runId: 'r1', at: Date.now() }, 'r1')?.state).toBe('delivered')
})

it('A\u2192B\u2192A restores the exact claimed camera transform; an explicit jump overrides it', () => {
  const box = { minX: 0, minY: 0, maxX: 3000, maxY: 3000 }
  const a = createCamera()
  a.setViewport(1000, 600)
  a.setContent(box)
  a.centerOn(1500, 1500, true)
  a.beginDrag(500, 300, 0)
  a.drag(560, 340, 16)
  a.endDrag(true, 400)
  expect(a.touched).toBe(true)
  const saved = a.pose()
  rememberPlan(ROOT, 'p2', { camera: saved })
  // B is its own instance (the Graph is keyed by root+plan) and must not touch A's memory.
  const b = createCamera()
  b.setViewport(1000, 600)
  b.setContent(box)
  b.centerOn(200, 200, true)
  expect(planMemoryOf(ROOT, 'p3').camera).toBeUndefined()
  // Returning to A restores the claimed pose exactly.
  const back = createCamera()
  back.setViewport(1000, 600)
  back.setContent(box)
  const remembered = planMemoryOf(ROOT, 'p2').camera
  expect(remembered?.touched).toBe(true)
  back.restore(remembered!, true)
  expect(back.pose()).toEqual(saved)
  // An explicit jump (a walk to a node) overrides the memory.
  const jumped = createCamera()
  jumped.setViewport(1000, 600)
  jumped.setContent(box)
  jumped.restore(remembered!, true)
  jumped.centerOn(100, 100, true)
  expect(jumped.pose()).not.toEqual(saved)
})

it('remembers the Work done filter and expansion per root + plan', () => {
  rememberPlan(ROOT, 'p2', { work: { filter: 'followup', doneOpen: true } })
  expect(planMemoryOf(ROOT, 'p2').work).toEqual({ filter: 'followup', doneOpen: true })
  expect(planMemoryOf(ROOT, 'p3').work).toBeUndefined()
})

it('remembers the exact physical copy the reader used within a family, and never another family\u2019s', () => {
  expect(familyCopyOf('/repo/main')).toBeUndefined()
  rememberFamilyCopy('/repo/main', '/repo/.worktrees/feat')
  expect(familyCopyOf('/repo/main')).toBe('/repo/.worktrees/feat')
  // A second family keeps its own copy; the first is untouched.
  rememberFamilyCopy('/other/main', '/other/main')
  expect(familyCopyOf('/repo/main')).toBe('/repo/.worktrees/feat')
  expect(familyCopyOf('/other/main')).toBe('/other/main')
})

it('restores a feed position only for the run that captured it', () => {
  const memory = { anchor: 'message|t1', anchorOffset: -120, offset: 400, follow: false, feedRun: 'r1' }
  expect(feedPositionOf(memory, 'r1')).toEqual({ anchor: 'message|t1', anchorOffset: -120, offset: 400, follow: false })
  // A new run starts fresh: it must never inherit the previous run's scroll.
  expect(feedPositionOf(memory, 'r2')).toBeUndefined()
  expect(feedPositionOf(memory, undefined)).toBeUndefined()
  // Nothing saved for this task reads as no position, not as an empty one.
  expect(feedPositionOf({}, 'r1')).toBeUndefined()
})
