// Framework-owned tests for the trial report utility. Every world is a temp directory tree that
// the manifest names explicitly; nothing here scans the real repository or calls the network.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { analyzeManifest, renderReport } from './report.mjs'

const reportPath = fileURLToPath(new URL('./report.mjs', import.meta.url))
const FIXTURE_IDS = ['a', 'b', 'c', 'd']

function shaFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function makeWorld() {
  const root = mkdtempSync(path.join(tmpdir(), 'model-pilot-report-'))
  const abs = (rel) => path.join(root, rel)
  const ensure = (rel, content) => {
    mkdirSync(path.dirname(abs(rel)), { recursive: true })
    writeFileSync(abs(rel), content)
  }
  ensure('candidate-spec.md', 'spec v1\n')
  ensure(
    'fixtures.json',
    `${JSON.stringify(FIXTURE_IDS.map((id) => ({ id, expected: { action: 'close' } })))}\n`,
  )
  ensure('base.json', '{"base":"fixed"}\n')
  ensure('base-other.json', '{"base":"other"}\n')
  ensure('candidates/luna.mjs', 'export function assessClosure(){}\n')
  ensure('candidates/flash.mjs', 'export function assessClosure(){}\n')
  ensure('receipts/review.json', '{"review":"done"}\n')
  const desc = (rel) => ({ path: rel, sha256: shaFile(abs(rel)) })
  return { root, abs, ensure, desc }
}

function correctResults() {
  return FIXTURE_IDS.map((id) => ({ id, outcome: 'correct', safety: [] }))
}

function writeGradeReceipt(world, rel, overrides = {}) {
  const candidateRel = overrides.candidateRel ?? 'candidates/luna.mjs'
  const results = overrides.results ?? correctResults()
  const derived = { correct: 0, incorrect: 0, error: 0, timeout: 0, mutated: 0 }
  for (const row of results) derived[row.outcome] = (derived[row.outcome] ?? 0) + 1
  const body = {
    kind: 'model-pilot-grade-receipt',
    version: 1,
    candidate: {
      path: world.abs(candidateRel),
      sha256: overrides.candidateSha ?? shaFile(world.abs(candidateRel)),
    },
    spec: {
      path: world.abs('candidate-spec.md'),
      sha256: overrides.specSha ?? shaFile(world.abs('candidate-spec.md')),
    },
    fixtures: {
      path: world.abs('fixtures.json'),
      sha256: overrides.fixturesSha ?? shaFile(world.abs('fixtures.json')),
      count: overrides.fixturesCount ?? FIXTURE_IDS.length,
    },
    base: {
      path: world.abs('base.json'),
      sha256: overrides.baseSha ?? shaFile(world.abs('base.json')),
    },
    artifactsStable: overrides.artifactsStable ?? true,
    total: overrides.total ?? results.length,
    correct: overrides.correct ?? derived.correct,
    outcomes: overrides.outcomes ?? derived,
    safetyFailures: overrides.safetyFailures ?? 0,
    runFailure: overrides.runFailure ?? null,
    results,
  }
  world.ensure(rel, `${JSON.stringify(body)}\n`)
  return world.desc(rel)
}

function writeCostExport(world, rel, { runId, worker, model, taskId, run: runOverrides = {} }) {
  const run = {
    runId,
    agent: worker,
    canonicalWorkerId: worker,
    model,
    taskId,
    cashUsd: { value: 0.25, currency: 'USD', source: 'dsh_bill_records' },
    availability: { cash: 'known' },
    billingMode: 'api',
    pending: false,
    ...runOverrides,
  }
  world.ensure(rel, `${JSON.stringify({ runs: [run] })}\n`)
  return world.desc(rel)
}

function buildManifest(
  world,
  { pairCount = 1, pairBase = null, gradeOverrides = {}, costOverrides = {} } = {},
) {
  const pairs = []
  for (let index = 0; index < pairCount; index += 1) {
    const runA = `run-a-${index}`
    const runB = `run-b-${index}`
    const taskA = `task-a-${index}`
    const taskB = `task-b-${index}`
    const gradeA = writeGradeReceipt(world, `receipts/grade-a-${index}.json`, {
      candidateRel: 'candidates/luna.mjs',
      ...gradeOverrides.A,
    })
    const gradeB = writeGradeReceipt(world, `receipts/grade-b-${index}.json`, {
      candidateRel: 'candidates/flash.mjs',
      ...gradeOverrides.B,
    })
    const costA = writeCostExport(world, `receipts/cost-a-${index}.json`, {
      runId: runA,
      worker: 'codex/gpt-6-luna',
      model: 'gpt-6-luna',
      taskId: taskA,
      run: costOverrides.A ?? {},
    })
    const costB = writeCostExport(world, `receipts/cost-b-${index}.json`, {
      runId: runB,
      worker: 'dsh/deepseek-flash',
      model: 'deepseek-flash',
      taskId: taskB,
      run: costOverrides.B ?? {},
    })
    pairs.push({
      pairId: `pair-${index}`,
      base: pairBase ?? world.desc('base.json'),
      arms: [
        {
          arm: 'A',
          worker: 'codex/gpt-6-luna',
          model: 'gpt-6-luna',
          candidate: world.desc('candidates/luna.mjs'),
          attempts: [
            {
              attempt: 1,
              taskId: taskA,
              runId: runA,
              durationMs: 1000,
              retry: false,
              gradeReceipt: gradeA,
              costExport: costA,
            },
          ],
        },
        {
          arm: 'B',
          worker: 'dsh/deepseek-flash',
          model: 'deepseek-flash',
          candidate: world.desc('candidates/flash.mjs'),
          attempts: [
            {
              attempt: 1,
              taskId: taskB,
              runId: runB,
              durationMs: 2000,
              retry: false,
              gradeReceipt: gradeB,
              costExport: costB,
            },
          ],
        },
      ],
    })
  }
  return {
    schemaVersion: 1,
    pilot: 'paired-model-pilot',
    specimen: { base: world.desc('base.json') },
    spec: world.desc('candidate-spec.md'),
    fixtures: world.desc('fixtures.json'),
    plannedRepetitions: 20,
    independentReview: {
      reviewer: 'orchestrator',
      reviewedAt: '2026-09-28',
      artifact: world.desc('receipts/review.json'),
    },
    attribution: { orchestrator: 'unknown', review: 'unknown' },
    pairs,
  }
}

function workerReport(report, worker) {
  return report.workers.find((entry) => entry.worker === worker)
}

function hasError(report, pattern) {
  return report.errors.some((error) => pattern.test(error))
}

test('accepts a provenance-clean single pair but declares it inconclusive', () => {
  const world = makeWorld()
  const report = analyzeManifest(buildManifest(world), { root: world.root })
  assert.deepEqual(report.errors, [])
  assert.equal(report.verdict.status, 'inconclusive')
  assert.ok(report.verdict.reasons.some((reason) => /paired repetitions/.test(reason)))
  assert.equal(report.observedRepetitions, 1)
})

test('rejects a pair whose initial base fingerprint differs from the specimen', () => {
  const world = makeWorld()
  const report = analyzeManifest(
    buildManifest(world, { pairBase: world.desc('base-other.json') }),
    {
      root: world.root,
    },
  )
  assert.equal(report.verdict.status, 'rejected')
  assert.ok(hasError(report, /initial base fingerprint mismatch/))
})

test('rejects a missing descriptor sha256 for a frozen artifact', () => {
  const world = makeWorld()
  const manifest = buildManifest(world)
  delete manifest.spec.sha256
  const report = analyzeManifest(manifest, { root: world.root })
  assert.equal(report.verdict.status, 'rejected')
  assert.ok(hasError(report, /spec: missing or invalid sha256/))
})

test('rejects a missing grade receipt', () => {
  const world = makeWorld()
  const manifest = buildManifest(world)
  delete manifest.pairs[0].arms[0].attempts[0].gradeReceipt
  const report = analyzeManifest(manifest, { root: world.root })
  assert.equal(report.verdict.status, 'rejected')
  assert.ok(hasError(report, /missing grade receipt/))
})

test('rejects a marker-only grade receipt with no bindings', () => {
  const world = makeWorld()
  const manifest = buildManifest(world)
  world.ensure('receipts/grade-a-0.json', '{"kind":"model-pilot-grade-receipt"}\n')
  manifest.pairs[0].arms[0].attempts[0].gradeReceipt = world.desc('receipts/grade-a-0.json')
  const report = analyzeManifest(manifest, { root: world.root })
  assert.equal(report.verdict.status, 'rejected')
  assert.ok(hasError(report, /candidate binding|results must be a non-empty array/))
})

test('rejects an empty results array', () => {
  const world = makeWorld()
  const report = analyzeManifest(
    buildManifest(world, { gradeOverrides: { A: { results: [], total: 4, correct: 0 } } }),
    { root: world.root },
  )
  assert.equal(report.verdict.status, 'rejected')
  assert.ok(hasError(report, /results must be a non-empty array/))
})

test('rejects a grade receipt whose safety count contradicts its results', () => {
  const world = makeWorld()
  const report = analyzeManifest(
    buildManifest(world, {
      gradeOverrides: {
        A: {
          results: [
            { id: 'a', outcome: 'incorrect', safety: ['false_positive_closure'] },
            { id: 'b', outcome: 'correct', safety: [] },
            { id: 'c', outcome: 'correct', safety: [] },
            { id: 'd', outcome: 'correct', safety: [] },
          ],
          safetyFailures: 0,
        },
      },
    }),
    { root: world.root },
  )
  assert.equal(report.verdict.status, 'rejected')
  assert.ok(hasError(report, /safetyFailures=0 but 1 results carry safety flags/))
})

test('rejects duplicate run ids across attempts', () => {
  const world = makeWorld()
  const manifest = buildManifest(world, { pairCount: 2 })
  manifest.pairs[1].arms[1].attempts[0].runId = manifest.pairs[0].arms[0].attempts[0].runId
  const report = analyzeManifest(manifest, { root: world.root })
  assert.equal(report.verdict.status, 'rejected')
  assert.ok(hasError(report, /duplicate run id/))
})

test('rejects mismatched spec, fixture and candidate fingerprints', () => {
  const world = makeWorld()
  const spec = analyzeManifest(
    buildManifest(world, { gradeOverrides: { A: { specSha: '0'.repeat(64) } } }),
    { root: world.root },
  )
  assert.ok(hasError(spec, /spec fingerprint mismatch/))
  const fixtures = analyzeManifest(
    buildManifest(world, { gradeOverrides: { A: { fixturesSha: '1'.repeat(64) } } }),
    { root: world.root },
  )
  assert.ok(hasError(fixtures, /fixture fingerprint mismatch/))
  const candidate = analyzeManifest(
    buildManifest(world, { gradeOverrides: { A: { candidateSha: '2'.repeat(64) } } }),
    { root: world.root },
  )
  assert.ok(hasError(candidate, /candidate fingerprint mismatch/))
})

test('rejects a fixture suite with duplicate ids', () => {
  const world = makeWorld()
  world.ensure('fixtures.json', '[{"id":"x"},{"id":"x"}]\n')
  const report = analyzeManifest(buildManifest(world), { root: world.root })
  assert.equal(report.verdict.status, 'rejected')
  assert.ok(hasError(report, /duplicate fixture id/))
})

test('never counts an errored attempt as a successful paired repetition', () => {
  const world = makeWorld()
  const errored = FIXTURE_IDS.map((id) => ({ id, outcome: 'error', safety: ['candidate_error'] }))
  const report = analyzeManifest(
    buildManifest(world, {
      gradeOverrides: { A: { results: errored, total: 4, correct: 0, safetyFailures: 4 } },
    }),
    { root: world.root },
  )
  assert.deepEqual(report.errors, [])
  assert.equal(report.observedRepetitions, 0)
  const luna = workerReport(report, 'codex/gpt-6-luna')
  assert.equal(luna.total, 4)
  assert.equal(luna.outcomes.error, 4)
  assert.equal(luna.safetyFailures, 4)
  assert.equal(luna.successful, 0)
})

test('rejects a grade run failure that under-reports safety', () => {
  const world = makeWorld()
  const timedOut = FIXTURE_IDS.map((id) => ({
    id,
    outcome: 'timeout',
    safety: ['candidate_timeout'],
  }))
  const report = analyzeManifest(
    buildManifest(world, {
      gradeOverrides: {
        A: {
          results: timedOut,
          total: 4,
          correct: 0,
          safetyFailures: 0,
          runFailure: { kind: 'timeout', message: 'exceeded bound' },
        },
      },
    }),
    { root: world.root },
  )
  assert.equal(report.verdict.status, 'rejected')
  assert.ok(hasError(report, /runFailure must be recorded with at least one safety failure/))
})

test('rejects a cost export that is a normalized wrapper instead of a raw export', () => {
  const world = makeWorld()
  const manifest = buildManifest(world)
  world.ensure(
    'receipts/cost-a-0.json',
    '{"kind":"crewboard-cost-receipt","apiCashUsd":1,"coverage":{"apiCashUsd":"observed"}}\n',
  )
  manifest.pairs[0].arms[0].attempts[0].costExport = world.desc('receipts/cost-a-0.json')
  const report = analyzeManifest(manifest, { root: world.root })
  assert.equal(report.verdict.status, 'rejected')
  assert.ok(hasError(report, /expected a raw crewboard cost --json export/))
})

test('keeps a partial cash observation partial instead of observing it', () => {
  const world = makeWorld()
  const report = analyzeManifest(
    buildManifest(world, {
      costOverrides: {
        A: { cashUsd: { value: 1.5, currency: 'USD' }, availability: { cash: 'partial' } },
      },
    }),
    { root: world.root },
  )
  assert.deepEqual(report.errors, [])
  const luna = workerReport(report, 'codex/gpt-6-luna')
  assert.equal(luna.money.apiCash.partial, 1)
  assert.equal(luna.money.apiCash.observed, 0)
  assert.equal(luna.money.apiCash.observedTotalUsd, 0)
  assert.ok(report.warnings.some((warning) => /stays "partial"/.test(warning)))
})

test('never overrides a declared unknown cash state with a numeric value', () => {
  const world = makeWorld()
  const report = analyzeManifest(
    buildManifest(world, {
      costOverrides: {
        A: { cashUsd: { value: 2, currency: 'USD' }, availability: { cash: 'unavailable' } },
      },
    }),
    { root: world.root },
  )
  assert.deepEqual(report.errors, [])
  const luna = workerReport(report, 'codex/gpt-6-luna')
  assert.equal(luna.money.apiCash.unavailable, 1)
  assert.equal(luna.money.apiCash.observed, 0)
  assert.equal(luna.money.apiCash.observedTotalUsd, 0)
})

test('rejects an invalid declared availability state', () => {
  const world = makeWorld()
  const report = analyzeManifest(
    buildManifest(world, { costOverrides: { A: { availability: { cash: 'weird' } } } }),
    { root: world.root },
  )
  assert.equal(report.verdict.status, 'rejected')
  assert.ok(hasError(report, /invalid availability.cash/))
})

test('keeps a declared notApplicable cash state even while other usage is pending', () => {
  const world = makeWorld()
  const report = analyzeManifest(
    buildManifest(world, {
      costOverrides: {
        A: { cashUsd: undefined, availability: { cash: 'notApplicable' }, pending: true },
      },
    }),
    { root: world.root },
  )
  assert.deepEqual(report.errors, [])
  const luna = workerReport(report, 'codex/gpt-6-luna')
  assert.equal(luna.money.apiCash.notApplicable, 1)
  assert.equal(luna.money.apiCash.pending, 0)
})

test('keeps missing billing pending rather than zero', () => {
  const world = makeWorld()
  const manifest = buildManifest(world)
  world.ensure('receipts/cost-a-0.json', '{"runs":[]}\n')
  manifest.pairs[0].arms[0].attempts[0].costExport = world.desc('receipts/cost-a-0.json')
  const report = analyzeManifest(manifest, { root: world.root })
  assert.deepEqual(report.errors, [])
  const luna = workerReport(report, 'codex/gpt-6-luna')
  assert.equal(luna.money.apiCash.pending, 1)
  assert.equal(luna.money.apiCash.observed, 0)
  assert.ok(report.warnings.some((warning) => /absent from the cost export/.test(warning)))
})

test('rejects worker, model and task identity mismatches against the cost export', () => {
  const world = makeWorld()
  const worker = analyzeManifest(
    buildManifest(world, {
      costOverrides: { A: { agent: 'dsh/other', canonicalWorkerId: 'dsh/other' } },
    }),
    { root: world.root },
  )
  assert.ok(hasError(worker, /worker mismatch/))
  const model = analyzeManifest(
    buildManifest(world, { costOverrides: { A: { model: 'other-model' } } }),
    {
      root: world.root,
    },
  )
  assert.ok(hasError(model, /model mismatch/))
  const task = analyzeManifest(
    buildManifest(world, { costOverrides: { A: { taskId: 'wrong-task' } } }),
    {
      root: world.root,
    },
  )
  assert.ok(hasError(task, /taskId mismatch/))
})

test('rejects duplicate run entries for the same runId in a cost export', () => {
  const world = makeWorld()
  const manifest = buildManifest(world)
  const payload = {
    runs: [
      { runId: 'run-a-0', agent: 'codex/gpt-6-luna', model: 'gpt-6-luna', taskId: 'task-a-0' },
      { runId: 'run-a-0', agent: 'codex/gpt-6-luna', model: 'gpt-6-luna', taskId: 'task-a-0' },
    ],
  }
  world.ensure('receipts/cost-a-0.json', `${JSON.stringify(payload)}\n`)
  manifest.pairs[0].arms[0].attempts[0].costExport = world.desc('receipts/cost-a-0.json')
  const report = analyzeManifest(manifest, { root: world.root })
  assert.ok(hasError(report, /duplicate run entries for runId/))
})

test('declares safety failures not promotable even at the repetition threshold', () => {
  const world = makeWorld()
  const results = [
    { id: 'a', outcome: 'incorrect', safety: ['false_positive_closure'] },
    { id: 'b', outcome: 'correct', safety: [] },
    { id: 'c', outcome: 'correct', safety: [] },
    { id: 'd', outcome: 'correct', safety: [] },
  ]
  const manifest = buildManifest(world, {
    pairCount: 20,
    gradeOverrides: { A: { results, safetyFailures: 1 } },
  })
  const report = analyzeManifest(manifest, { root: world.root })
  assert.equal(report.verdict.status, 'not_promotable')
  assert.equal(report.totalSafetyFailures, 20)
  assert.ok(report.verdict.reasons.some((reason) => /safety failure/.test(reason)))
})

test('marks a full clean run eligible for broader evaluation, never promoted', () => {
  const world = makeWorld()
  const report = analyzeManifest(buildManifest(world, { pairCount: 20 }), { root: world.root })
  assert.deepEqual(report.errors, [])
  assert.equal(report.observedRepetitions, 20)
  assert.equal(report.verdict.status, 'eligible_for_broader_evaluation')
  assert.ok(
    report.verdict.reasons.some((reason) => /eligible for broader evaluation only/.test(reason)),
  )
  const rendered = renderReport(report)
  assert.doesNotMatch(rendered, /\bpromoted\b/i)
})

test('does not claim cost per accepted task when attribution is unknown', () => {
  const world = makeWorld()
  const report = analyzeManifest(buildManifest(world), { root: world.root })
  assert.ok(report.warnings.some((warning) => /attribution is unknown/.test(warning)))
  const rendered = renderReport(report)
  assert.match(rendered, /subscription API-equivalent estimate \(USD, not cash\)/)
  assert.doesNotMatch(rendered, /total cost per accepted task: \$/)
})

test('CLI exits 1 for a rejected manifest and 0 for a valid inconclusive one', () => {
  const world = makeWorld()
  const bad = buildManifest(world)
  delete bad.pairs[0].arms[0].attempts[0].gradeReceipt
  const badFile = path.join(world.root, 'manifest-bad.json')
  writeFileSync(badFile, JSON.stringify(bad))
  const badResult = spawnSync(process.execPath, [reportPath, badFile, '--root', world.root], {
    encoding: 'utf8',
  })
  assert.equal(badResult.status, 1)
  assert.match(badResult.stdout, /verdict:\s+rejected/)

  const goodFile = path.join(world.root, 'manifest-good.json')
  writeFileSync(goodFile, JSON.stringify(buildManifest(world)))
  const goodResult = spawnSync(process.execPath, [reportPath, goodFile, '--root', world.root], {
    encoding: 'utf8',
  })
  assert.equal(goodResult.status, 0)
  assert.match(goodResult.stdout, /verdict:\s+inconclusive/)
})
