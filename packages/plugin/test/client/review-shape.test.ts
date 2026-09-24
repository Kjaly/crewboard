import { expect, it } from 'vitest'
import { costShape } from '../../src/client/views/review.js'
import type { PlanCost } from '../../src/shared/types.js'

const base = { schemaVersion: 2, rev: 3, generatedAt: 'a', runs: [{ runId: 'r1', taskId: 't', agent: 'x', startedAt: 's', durationSec: 10 }], totals: {}, accepted: [] } as unknown as PlanCost

// A running run's elapsed time changes on every poll; that alone must not raise «Updates available».
it('treats live numbers as the same shape and a finished run as a new one', () => {
  expect(costShape({ ...base, generatedAt: 'b', runs: [{ ...base.runs[0]!, durationSec: 70 }] })).toBe(costShape(base))
  expect(costShape({ ...base, runs: [{ ...base.runs[0]!, finishedAt: 'f', executionOutcome: 'completed' }] })).not.toBe(costShape(base))
  expect(costShape({ ...base, accepted: [{ taskId: 't', at: 'z' }] })).not.toBe(costShape(base))
})
