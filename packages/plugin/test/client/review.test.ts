import { expect, it } from 'vitest'
import { backgroundReview, reviewWaiting, snapshotWaiting } from '../../src/client/review.js'
import { makeRepo, makeSnapshot, makeTask } from './helpers.js'

it('counts reviewable work across current and background plans using the core waiting count', () => {
  const repo = makeRepo([
    makeTask({ id: 'review', status: 'in_review' }),
    makeTask({ id: 'decision', kind: 'decision', status: 'ready', needsHuman: true }),
    makeTask({ id: 'blocked', kind: 'decision', status: 'blocked', needsHuman: true }),
  ], [], { plans: [
    { id: 'main', goal: 'current', archived: false, current: true, rev: 1, updatedAt: '', taskCount: 3, running: 0, inReview: 1, waitingHuman: 2, ready: 0, accepted: 0, attention: [] },
    { id: 'background', goal: 'background', archived: false, current: false, rev: 1, updatedAt: '', taskCount: 4, running: 0, inReview: 1, waitingHuman: 3, ready: 0, accepted: 0, attention: [] },
  ] })
  expect(backgroundReview(repo).map((plan) => plan.id)).toEqual(['background'])
  expect(reviewWaiting(repo)).toBe(5)
  expect(snapshotWaiting(makeSnapshot(repo))).toBe(5)
})
