import type { PlanCost, PlanRunCost, ReviewCoverage } from './types.js'

const ended = (run: PlanRunCost) => run.finishedAt ?? run.startedAt
const latest = (runs: PlanRunCost[]) => runs.map(ended).sort().at(-1)
/** A run billed by subscription carries quota and an API-price estimate; cash does not apply to it. */
const subscription = (run: PlanRunCost) =>
  run.availability?.cash ? run.availability.cash === 'notApplicable' : run.billingMode ? run.billingMode === 'subscription' || run.billingMode === 'promotional' : /^(claude|codex|devin)/i.test(run.canonicalWorkerId ?? run.agent)

/**
 * Which runs each Review measure covers. The host sends it with `/api/cost`; the screen computes the
 * same from the runs when an older host did not. Eligibility follows the accounting rules: cash only
 * for API-billed runs, estimate and quota only for subscription runs (or runs that already carry one).
 */
export function reviewCoverage(runs: PlanRunCost[], historyCompleteness: PlanCost['historyCompleteness']): ReviewCoverage {
  const cashEligible = runs.filter((run) => !subscription(run) || !!run.cashUsd)
  const cashKnown = cashEligible.filter((run) => !!run.cashUsd)
  const equivalentEligible = runs.filter((run) => subscription(run) || !!run.apiEquivalentUsd)
  const equivalentKnown = equivalentEligible.filter((run) => !!run.apiEquivalentUsd)
  const quotaEligible = runs.filter((run) => subscription(run) || !!run.quotaMeasurements?.length)
  const quotaKnown = quotaEligible.filter((run) => !!run.quotaMeasurements?.length)
  const measured = runs.filter((run) => run.durationSec !== undefined)
  const starts = runs.map((run) => run.startedAt).sort()
  return {
    cash: { known: cashKnown.length, eligible: cashEligible.length, pending: cashEligible.filter((run) => run.pending && !run.cashUsd).length, ...(cashKnown.length ? { lastRunAt: latest(cashKnown) } : {}) },
    apiEquivalent: { known: equivalentKnown.length, eligible: equivalentEligible.length, pending: equivalentEligible.filter((run) => run.pending && !run.apiEquivalentUsd).length, ...(equivalentKnown.length ? { lastRunAt: latest(equivalentKnown) } : {}) },
    quota: { known: quotaKnown.length, eligible: quotaEligible.length, pending: quotaEligible.filter((run) => !run.finishedAt && !run.quotaMeasurements?.length).length, samples: new Set(quotaKnown.flatMap((run) => (run.quotaMeasurements ?? []).map((sample) => sample.sampleId))).size, ...(quotaKnown.length ? { lastRunAt: latest(quotaKnown) } : {}) },
    worker: { measured: measured.length, runs: runs.length, ...(starts.length ? { firstRunAt: starts[0], lastRunAt: latest(runs) } : {}) },
    reviewWait: { complete: historyCompleteness === 'complete' },
  }
}
