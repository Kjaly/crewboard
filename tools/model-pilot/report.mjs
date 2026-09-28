#!/usr/bin/env node
// Trial report utility for the bounded paired model pilot.
//
// Usage:
//   node tools/model-pilot/report.mjs <explicit-manifest.json> [--root <dir>] [--json]
//
// The manifest is the only input. It names every artifact explicitly (spec, fixture suite, initial
// base, candidate, grade receipt and a raw `crewboard cost --json` export). This tool never scans
// the filesystem for receipts, never reads private chats or credentials and never calls the
// network.
//
// Provenance is checked before any number is reported:
//   * frozen artifacts (spec/fixtures/base/candidate) and evidence files must declare a 64-hex
//     SHA-256 that matches the file;
//   * a grade receipt must bind candidate/spec/fixture/base, carry a non-empty results array whose
//     ids are exactly the fixture-suite ids, and be internally consistent
//     (total/correct/outcomes/safetyFailures against the results);
//   * a cost export must be the raw `crewboard cost --json` document; the report selects the exact
//     unique runId and validates taskId/worker/model against the attempt. Missing billing stays
//     pending/unavailable, never zero.
//
// Money axes are never summed into one number:
//   * observed API cash (USD actually billed);
//   * subscription API-equivalent estimate (USD not billed, an estimate only);
//   * shared provider quota (not money).
// With orchestrator/review attribution unknown, no full cost per accepted task and no exact quota
// saving may be claimed. Public fixtures can make a pilot eligible for broader evaluation; they can
// never promote production routing, and no routing action is taken here.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const MIN_PAIRED_REPETITIONS = 20
export const ELIGIBLE_STATUS = 'eligible_for_broader_evaluation'

const GRADE_KIND = 'model-pilot-grade-receipt'
const GRADE_OUTCOMES = new Set(['correct', 'incorrect', 'error', 'timeout', 'mutated'])
const COVERAGE_STATES = new Set(['observed', 'partial', 'pending', 'unavailable', 'notApplicable'])
const AVAILABILITY_MAP = {
  known: 'observed',
  partial: 'partial',
  pending: 'pending',
  unavailable: 'unavailable',
  notApplicable: 'notApplicable',
}
const SHA256 = /^[0-9a-f]{64}$/

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function isSha256(value) {
  return typeof value === 'string' && SHA256.test(value)
}

function resolveArtifact(root, relative) {
  if (typeof relative !== 'string' || relative.length === 0)
    throw new Error('missing artifact path')
  const absolute = path.resolve(root, relative)
  const rel = path.relative(root, absolute)
  if (rel.startsWith('..') || path.isAbsolute(rel))
    throw new Error(`artifact path escapes the report root: ${relative}`)
  if (!existsSync(absolute) || !statSync(absolute).isFile())
    throw new Error(`artifact not found: ${relative}`)
  return absolute
}

function loadDescriptor(
  root,
  descriptor,
  label,
  errors,
  { required = true, requireSha = true } = {},
) {
  if (!descriptor || typeof descriptor.path !== 'string' || descriptor.path.length === 0) {
    if (required) errors.push(`${label}: missing artifact path`)
    return null
  }
  let absolute
  try {
    absolute = resolveArtifact(root, descriptor.path)
  } catch (error) {
    errors.push(`${label}: ${error.message}`)
    return null
  }
  const sha256 = sha256File(absolute)
  const declared = descriptor.sha256
  if (requireSha && !isSha256(declared)) {
    errors.push(`${label}: missing or invalid sha256 (need 64 lowercase hex)`)
  } else if (isSha256(declared) && declared !== sha256) {
    errors.push(`${label}: sha256 mismatch (declared ${declared}, actual ${sha256})`)
  }
  return { path: descriptor.path, absolute, sha256 }
}

function loadJson(file, label, errors) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    errors.push(`${label}: cannot parse JSON (${error.message})`)
    return null
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function emptyAxis() {
  return {
    observed: 0,
    partial: 0,
    pending: 0,
    unavailable: 0,
    notApplicable: 0,
    observedTotalUsd: 0,
  }
}

function emptyMoney() {
  return { apiCash: emptyAxis(), subscriptionApiEquivalent: emptyAxis(), sharedQuota: emptyAxis() }
}

function mergeMoney(target, source) {
  for (const axis of ['apiCash', 'subscriptionApiEquivalent', 'sharedQuota']) {
    for (const state of COVERAGE_STATES) target[axis][state] += source[axis][state]
    target[axis].observedTotalUsd += source[axis].observedTotalUsd
  }
}

function moneyValue(field) {
  if (typeof field === 'number' && Number.isFinite(field)) return field
  if (isPlainObject(field) && typeof field.value === 'number' && Number.isFinite(field.value))
    return field.value
  return undefined
}

function addAxis(axis, state, value, label, errors, warnings) {
  if (!COVERAGE_STATES.has(state)) {
    errors.push(`${label}: invalid coverage state ${JSON.stringify(state)}`)
    return
  }
  if (state === 'observed') {
    if (value === undefined) {
      errors.push(`${label}: money declared observed without a finite value`)
      axis.unavailable += 1
      return
    }
    axis.observed += 1
    axis.observedTotalUsd += value
    return
  }
  axis[state] += 1
  if (value !== undefined) {
    warnings.push(`${label}: value ${value} stays "${state}" per the export, not observed`)
  }
}

/** Validate a grade receipt against the fixture suite and its own result rows. */
export function validateGradeReceipt(grade, { label, fixtureIds, errors }) {
  const outcome = {
    outcomes: { correct: 0, incorrect: 0, error: 0, timeout: 0, mutated: 0 },
    safety: 0,
    valid: true,
  }
  const fail = (message) => {
    errors.push(`${label}: ${message}`)
    outcome.valid = false
  }
  if (grade.kind !== GRADE_KIND) fail(`unexpected kind ${JSON.stringify(grade.kind)}`)
  for (const key of ['candidate', 'spec', 'fixtures', 'base']) {
    if (!isSha256(grade[key]?.sha256))
      fail(`missing or invalid ${key} binding (need 64-hex sha256)`)
  }
  const results = grade.results
  if (!Array.isArray(results) || results.length === 0) {
    fail('results must be a non-empty array')
    return outcome
  }
  if (!Number.isInteger(grade.total) || grade.total <= 0) fail('total must be a positive integer')
  else if (grade.total !== results.length)
    fail(`total=${grade.total} but results has ${results.length} rows`)
  if (typeof grade.fixtures?.count === 'number' && grade.fixtures.count !== fixtureIds.size)
    fail(`fixtures.count=${grade.fixtures.count} but the suite has ${fixtureIds.size} fixtures`)

  const resultIds = new Set()
  for (const row of results) {
    if (!isPlainObject(row)) {
      fail('result row is not an object')
      continue
    }
    if (typeof row.id !== 'string' || row.id.length === 0) {
      fail('result row has no string id')
      continue
    }
    if (resultIds.has(row.id)) fail(`duplicate result id ${row.id}`)
    resultIds.add(row.id)
    if (!fixtureIds.has(row.id)) fail(`result id ${row.id} is not in the fixture suite`)
    if (!GRADE_OUTCOMES.has(row.outcome)) {
      fail(`result ${row.id} has unknown outcome ${JSON.stringify(row.outcome)}`)
      continue
    }
    outcome.outcomes[row.outcome] += 1
    if (Array.isArray(row.safety) && row.safety.length > 0) outcome.safety += 1
  }
  for (const id of fixtureIds) if (!resultIds.has(id)) fail(`fixture ${id} has no result row`)

  const declared = isPlainObject(grade.outcomes) ? grade.outcomes : {}
  for (const key of GRADE_OUTCOMES) {
    if (declared[key] !== outcome.outcomes[key])
      fail(`outcomes.${key}=${declared[key]} but results have ${outcome.outcomes[key]}`)
  }
  if (grade.correct !== outcome.outcomes.correct)
    fail(`correct=${grade.correct} but results have ${outcome.outcomes.correct}`)

  const reportedSafety = grade.safetyFailures
  if (!Number.isInteger(reportedSafety) || reportedSafety < 0)
    fail('safetyFailures must be a non-negative integer')
  else if (grade.runFailure) {
    if (reportedSafety < 1) fail('a runFailure must be recorded with at least one safety failure')
  } else if (reportedSafety !== outcome.safety) {
    fail(`safetyFailures=${reportedSafety} but ${outcome.safety} results carry safety flags`)
  }
  if (grade.artifactsStable === false && !(Number.isInteger(reportedSafety) && reportedSafety >= 1))
    fail('an artifact change must be recorded with a safety failure')

  outcome.safety = Number.isInteger(reportedSafety)
    ? Math.max(reportedSafety, grade.runFailure ? 1 : 0)
    : 0
  return outcome
}

/** Consume a raw `crewboard cost --json` document and map the exact run onto money axes. */
export function readCostExport(doc, attempt, arm, label, errors, warnings) {
  if (!isPlainObject(doc)) {
    errors.push(`${label}: not an object`)
    return null
  }
  if (!Array.isArray(doc.runs)) {
    errors.push(`${label}: expected a raw crewboard cost --json export with a runs array`)
    return null
  }
  const matches = doc.runs.filter((run) => isPlainObject(run) && run.runId === attempt.runId)
  if (matches.length > 1) {
    errors.push(`${label}: duplicate run entries for runId ${attempt.runId}`)
    return null
  }
  if (matches.length === 0) {
    warnings.push(
      `${label}: run ${attempt.runId} is absent from the cost export; cash and estimate stay pending`,
    )
    const pending = emptyMoney()
    pending.apiCash.pending += 1
    pending.subscriptionApiEquivalent.pending += 1
    pending.sharedQuota.unavailable += 1
    return pending
  }
  const run = matches[0]
  const worker = nonEmptyString(run.canonicalWorkerId) ? run.canonicalWorkerId : run.agent
  if (!nonEmptyString(worker)) errors.push(`${label}: matched run has no worker identity`)
  else if (nonEmptyString(arm.worker) && worker !== arm.worker)
    errors.push(`${label}: worker mismatch (export ${worker} != arm ${arm.worker})`)
  if (run.model !== undefined && arm.model !== undefined && run.model !== arm.model)
    errors.push(`${label}: model mismatch (export ${run.model} != arm ${arm.model})`)
  else if (run.model === undefined)
    warnings.push(`${label}: cost export omits model for ${attempt.runId}`)
  if (run.taskId === undefined)
    errors.push(`${label}: cost export omits taskId; export with crewboard cost --by task --json`)
  else if (nonEmptyString(attempt.taskId) && run.taskId !== attempt.taskId)
    errors.push(`${label}: taskId mismatch (export ${run.taskId} != attempt ${attempt.taskId})`)

  const money = emptyMoney()
  const cashValue = moneyValue(run.cashUsd)
  const declaredCash = run.availability?.cash
  if (declaredCash !== undefined && AVAILABILITY_MAP[declaredCash] === undefined)
    errors.push(`${label}: invalid availability.cash ${JSON.stringify(declaredCash)}`)
  let cashState =
    AVAILABILITY_MAP[declaredCash] ?? (cashValue !== undefined ? 'observed' : 'unavailable')
  // Only infer pending when the export declared nothing; a declared state always wins.
  if (
    run.pending === true &&
    cashValue === undefined &&
    AVAILABILITY_MAP[declaredCash] === undefined
  )
    cashState = 'pending'
  addAxis(money.apiCash, cashState, cashValue, label, errors, warnings)

  const estimateValue = moneyValue(run.apiEquivalentUsd)
  const estimateState =
    estimateValue !== undefined ? 'observed' : run.pending === true ? 'pending' : 'unavailable'
  addAxis(money.subscriptionApiEquivalent, estimateState, estimateValue, label, errors, warnings)

  const samples = Array.isArray(run.quotaMeasurements) ? run.quotaMeasurements : []
  if (samples.length === 0) money.sharedQuota.unavailable += 1
  else if (
    samples.some(
      (sample) => isPlainObject(sample) && sample.reset !== true && sample.attribution !== 'shared',
    )
  )
    money.sharedQuota.observed += 1
  else if (samples.some((sample) => isPlainObject(sample) && sample.attribution === 'shared'))
    money.sharedQuota.partial += 1
  else money.sharedQuota.unavailable += 1
  return money
}

/**
 * Validate an explicit pilot manifest and build a provenance-checked report. Never reads a path
 * that the manifest does not name.
 */
export function analyzeManifest(manifest, { root = REPO_ROOT } = {}) {
  const errors = []
  const warnings = []
  const report = {
    generatedAt: new Date().toISOString(),
    root,
    pilot: manifest?.pilot ?? null,
    fingerprints: null,
    plannedRepetitions: null,
    observedRepetitions: 0,
    independentReview: null,
    attribution: manifest?.attribution ?? null,
    attempts: [],
    workers: [],
    totalSafetyFailures: 0,
    errors,
    warnings,
    verdict: { status: 'rejected', reasons: [] },
  }

  if (!isPlainObject(manifest)) {
    errors.push('manifest: not a JSON object')
    report.verdict.reasons.push('manifest is not a JSON object')
    return report
  }

  const specimen = loadDescriptor(root, manifest.specimen?.base, 'specimen.base', errors)
  const spec = loadDescriptor(root, manifest.spec, 'spec', errors)
  const fixtures = loadDescriptor(root, manifest.fixtures, 'fixtures', errors)
  const independentReview = loadDescriptor(
    root,
    manifest.independentReview?.artifact,
    'independentReview.artifact',
    errors,
    { required: false },
  )
  report.fingerprints = {
    base: specimen ? { path: specimen.path, sha256: specimen.sha256 } : null,
    spec: spec ? { path: spec.path, sha256: spec.sha256 } : null,
    fixtures: fixtures ? { path: fixtures.path, sha256: fixtures.sha256 } : null,
  }
  report.independentReview = manifest.independentReview
    ? {
        reviewer: manifest.independentReview.reviewer ?? null,
        reviewedAt: manifest.independentReview.reviewedAt ?? null,
        artifact: independentReview,
      }
    : null
  if (manifest.independentReview && !nonEmptyString(manifest.independentReview.reviewer))
    warnings.push('independentReview.reviewer is empty')

  const fixtureIds = new Set()
  if (fixtures) {
    const suite = loadJson(fixtures.absolute, 'fixtures', errors)
    if (suite !== null) {
      if (!Array.isArray(suite)) {
        errors.push('fixtures: expected a JSON array')
      } else {
        for (const fixture of suite) {
          const id = isPlainObject(fixture) && nonEmptyString(fixture.id) ? fixture.id : null
          if (!id) {
            errors.push('fixtures: every fixture needs a non-empty string id')
            break
          }
          if (fixtureIds.has(id)) {
            errors.push(`fixtures: duplicate fixture id: ${id}`)
            break
          }
          fixtureIds.add(id)
        }
      }
    }
  }

  const planned =
    Number.isInteger(manifest.plannedRepetitions) && manifest.plannedRepetitions > 0
      ? manifest.plannedRepetitions
      : MIN_PAIRED_REPETITIONS
  if (manifest.plannedRepetitions !== undefined && manifest.plannedRepetitions !== planned)
    errors.push(
      `plannedRepetitions must be a positive integer (got ${JSON.stringify(manifest.plannedRepetitions)})`,
    )
  report.plannedRepetitions = planned
  if (planned < MIN_PAIRED_REPETITIONS)
    warnings.push(
      `plannedRepetitions ${planned} is below the ${MIN_PAIRED_REPETITIONS}-pair evaluation minimum`,
    )

  if (!Array.isArray(manifest.pairs) || manifest.pairs.length === 0) {
    errors.push('pairs: expected a non-empty array')
    return finishReport(report)
  }

  const seenRunIds = new Map()
  const workerAccumulator = new Map()

  manifest.pairs.forEach((pair, pairIndex) => {
    const pairLabel = `pairs[${pairIndex}]${nonEmptyString(pair?.pairId) ? ` (${pair.pairId})` : ''}`
    if (!isPlainObject(pair)) {
      errors.push(`${pairLabel}: not an object`)
      return
    }
    const pairBase = loadDescriptor(root, pair.base, `${pairLabel}.base`, errors)
    if (pairBase && specimen && pairBase.sha256 !== specimen.sha256)
      errors.push(
        `${pairLabel}.base: initial base fingerprint mismatch (pair ${pairBase.sha256} != specimen ${specimen.sha256})`,
      )
    if (!Array.isArray(pair.arms) || pair.arms.length !== 2) {
      errors.push(`${pairLabel}: expected exactly two arms for a paired comparison`)
      return
    }
    const workers = pair.arms.map((arm) => (nonEmptyString(arm?.worker) ? arm.worker : null))
    if (workers[0] && workers[0] === workers[1])
      errors.push(`${pairLabel}: both arms name the same worker ${workers[0]}`)

    let successfulArms = 0
    pair.arms.forEach((arm, armIndex) => {
      const armLabel = `${pairLabel}.arms[${armIndex}]`
      if (!isPlainObject(arm)) {
        errors.push(`${armLabel}: not an object`)
        return
      }
      if (!nonEmptyString(arm.worker)) errors.push(`${armLabel}: missing worker identity`)
      if (!nonEmptyString(arm.model)) errors.push(`${armLabel}: missing model identity`)
      const candidate = loadDescriptor(root, arm.candidate, `${armLabel}.candidate`, errors)
      if (!Array.isArray(arm.attempts) || arm.attempts.length === 0) {
        errors.push(`${armLabel}: expected a non-empty attempts array`)
        return
      }
      if (arm.attempts.length > 1)
        warnings.push(
          `${armLabel}: ${arm.attempts.length - 1} retry(ies); the smoke budget is one attempt per model`,
        )
      const key = nonEmptyString(arm.worker) ? `${arm.worker}\u0000${arm.model ?? ''}` : armLabel
      const accumulator = workerAccumulator.get(key) ?? {
        worker: arm.worker ?? null,
        model: arm.model ?? null,
        attempts: 0,
        retries: 0,
        successful: 0,
        graded: 0,
        correct: 0,
        total: 0,
        outcomes: { correct: 0, incorrect: 0, error: 0, timeout: 0, mutated: 0 },
        safetyFailures: 0,
        runFailures: 0,
        durationMs: 0,
        money: emptyMoney(),
      }
      workerAccumulator.set(key, accumulator)

      let armSuccessful = false
      arm.attempts.forEach((attempt, attemptIndex) => {
        const attemptLabel = `${armLabel}.attempts[${attemptIndex}]`
        if (!isPlainObject(attempt)) {
          errors.push(`${attemptLabel}: not an object`)
          return
        }
        if (nonEmptyString(attempt.runId)) {
          if (seenRunIds.has(attempt.runId))
            errors.push(
              `duplicate run id: ${attempt.runId} (${seenRunIds.get(attempt.runId)} and ${attemptLabel})`,
            )
          else seenRunIds.set(attempt.runId, attemptLabel)
        } else errors.push(`${attemptLabel}: missing runId`)
        if (!nonEmptyString(attempt.taskId)) errors.push(`${attemptLabel}: missing taskId`)
        const durationMs =
          typeof attempt.durationMs === 'number' &&
          Number.isFinite(attempt.durationMs) &&
          attempt.durationMs >= 0
            ? attempt.durationMs
            : null
        if (durationMs === null)
          errors.push(`${attemptLabel}: durationMs must be a finite non-negative number`)
        const retry = attempt.retry === true || attemptIndex > 0

        const gradeDescriptor = attempt.gradeReceipt
        if (
          !gradeDescriptor ||
          typeof gradeDescriptor.path !== 'string' ||
          gradeDescriptor.path.length === 0
        ) {
          errors.push(`${attemptLabel}: missing grade receipt`)
          return
        }
        const gradeFile = loadDescriptor(
          root,
          gradeDescriptor,
          `${attemptLabel}.gradeReceipt`,
          errors,
        )
        const grade = gradeFile
          ? loadJson(gradeFile.absolute, `${attemptLabel}.gradeReceipt`, errors)
          : null
        let attemptSafety = 0
        let successful = false
        if (grade) {
          const errorsBefore = errors.length
          const validation = validateGradeReceipt(grade, {
            label: `${attemptLabel}.gradeReceipt`,
            fixtureIds,
            errors,
          })
          if (
            candidate &&
            isSha256(grade.candidate?.sha256) &&
            grade.candidate.sha256 !== candidate.sha256
          )
            errors.push(`${attemptLabel}.gradeReceipt: candidate fingerprint mismatch`)
          if (spec && isSha256(grade.spec?.sha256) && grade.spec.sha256 !== spec.sha256)
            errors.push(`${attemptLabel}.gradeReceipt: spec fingerprint mismatch`)
          if (
            fixtures &&
            isSha256(grade.fixtures?.sha256) &&
            grade.fixtures.sha256 !== fixtures.sha256
          )
            errors.push(`${attemptLabel}.gradeReceipt: fixture fingerprint mismatch`)
          if (pairBase && isSha256(grade.base?.sha256) && grade.base.sha256 !== pairBase.sha256)
            errors.push(`${attemptLabel}.gradeReceipt: base fingerprint mismatch`)
          const receiptClean = errors.length === errorsBefore
          attemptSafety = validation.safety
          successful =
            receiptClean &&
            !grade.runFailure &&
            grade.artifactsStable !== false &&
            attemptSafety === 0 &&
            validation.outcomes.correct === grade.total &&
            grade.total > 0
          accumulator.graded += 1
          accumulator.correct += Number(grade.correct ?? 0)
          accumulator.total += Number(grade.total ?? 0)
          for (const outcomeKey of Object.keys(validation.outcomes))
            accumulator.outcomes[outcomeKey] += validation.outcomes[outcomeKey]
          accumulator.safetyFailures += attemptSafety
          report.totalSafetyFailures += attemptSafety
          if (grade.runFailure) accumulator.runFailures += 1
          if (successful) accumulator.successful += 1
          armSuccessful = armSuccessful || successful
        }

        let money = null
        if (attempt.costExport && typeof attempt.costExport.path === 'string') {
          const costFile = loadDescriptor(
            root,
            attempt.costExport,
            `${attemptLabel}.costExport`,
            errors,
          )
          const cost = costFile
            ? loadJson(costFile.absolute, `${attemptLabel}.costExport`, errors)
            : null
          if (cost) {
            money = readCostExport(
              cost,
              attempt,
              arm,
              `${attemptLabel}.costExport`,
              errors,
              warnings,
            )
            if (money) mergeMoney(accumulator.money, money)
          }
        } else {
          warnings.push(
            `${attemptLabel}: no cost export supplied; cash and estimate coverage stay unknown`,
          )
        }

        accumulator.attempts += 1
        if (retry) accumulator.retries += 1
        if (durationMs !== null) accumulator.durationMs += durationMs
        report.attempts.push({
          pairId: pair.pairId ?? null,
          arm: nonEmptyString(arm.arm) ? arm.arm : armIndex === 0 ? 'A' : 'B',
          worker: arm.worker ?? null,
          model: arm.model ?? null,
          attempt: attemptIndex + 1,
          taskId: attempt.taskId ?? null,
          runId: attempt.runId ?? null,
          durationMs,
          retry,
          graded: Boolean(grade),
          successful,
          correct: grade ? Number(grade.correct ?? 0) : null,
          total: grade ? Number(grade.total ?? 0) : null,
          safetyFailures: grade ? attemptSafety : null,
          runFailure: grade?.runFailure ?? null,
          money,
        })
      })

      if (armSuccessful) successfulArms += 1
    })

    if (successfulArms === 2) report.observedRepetitions += 1
  })

  report.workers = [...workerAccumulator.values()].sort((a, b) =>
    String(a.worker).localeCompare(String(b.worker)),
  )
  return finishReport(report)
}

function finishReport(report) {
  const { errors, warnings, plannedRepetitions, observedRepetitions, totalSafetyFailures } = report
  if (errors.length > 0) {
    report.verdict = {
      status: 'rejected',
      reasons: ['provenance validation failed; results are not comparable'],
    }
    return report
  }
  const reasons = []
  const reviewPresent = Boolean(
    report.independentReview?.artifact && report.independentReview.reviewer,
  )
  if (!reviewPresent) reasons.push('independent review receipt missing')
  if (observedRepetitions < plannedRepetitions || observedRepetitions < MIN_PAIRED_REPETITIONS) {
    reasons.push(
      `observed ${observedRepetitions} successful paired repetitions < required ${Math.max(plannedRepetitions, MIN_PAIRED_REPETITIONS)}; the sample is inconclusive`,
    )
  }
  if (totalSafetyFailures > 0)
    reasons.push(`${totalSafetyFailures} safety failure(s) preserved in the denominator`)

  let status
  if (totalSafetyFailures > 0) status = 'not_promotable'
  else if (reasons.length > 0) status = 'inconclusive'
  else status = ELIGIBLE_STATUS
  report.verdict = { status, reasons }
  if (status === ELIGIBLE_STATUS) {
    report.verdict.reasons.push(
      'public fixtures make this pilot eligible for broader evaluation only; production routing is unchanged',
    )
  }
  if (report.attribution?.orchestrator !== 'known' || report.attribution?.review !== 'known') {
    warnings.push(
      'orchestrator/review attribution is unknown: full cost per accepted task and exact quota saving are not computed',
    )
  }
  return report
}

function moneyLine(label, axis) {
  const total = axis.observed ? `observed total ${axis.observedTotalUsd}` : 'observed total n/a'
  return `    ${label}: observed ${axis.observed}, partial ${axis.partial}, pending ${axis.pending}, unavailable ${axis.unavailable}, notApplicable ${axis.notApplicable} (${total})`
}

export function renderReport(report) {
  const lines = []
  lines.push(`pilot:      ${report.pilot ?? 'unknown'}`)
  lines.push(`root:       ${report.root}`)
  if (report.fingerprints) {
    lines.push(
      `spec:       ${report.fingerprints.spec?.path ?? 'missing'} sha256 ${report.fingerprints.spec?.sha256?.slice(0, 12) ?? 'n/a'}…`,
    )
    lines.push(
      `fixtures:   ${report.fingerprints.fixtures?.path ?? 'missing'} sha256 ${report.fingerprints.fixtures?.sha256?.slice(0, 12) ?? 'n/a'}…`,
    )
    lines.push(
      `base:       ${report.fingerprints.base?.path ?? 'missing'} sha256 ${report.fingerprints.base?.sha256?.slice(0, 12) ?? 'n/a'}…`,
    )
  }
  lines.push(
    `planned:    ${report.plannedRepetitions} paired repetitions (minimum ${MIN_PAIRED_REPETITIONS})`,
  )
  lines.push(`observed:   ${report.observedRepetitions} fully successful graded pairs`)
  lines.push(
    `review:     ${report.independentReview?.reviewer ? `${report.independentReview.reviewer} (${report.independentReview.reviewedAt ?? 'no date'})` : 'missing'}`,
  )
  lines.push('')
  lines.push('attempts:')
  for (const attempt of report.attempts) {
    const score = attempt.graded ? `${attempt.correct}/${attempt.total} correct` : 'not graded'
    const money = attempt.money
      ? ` | cash ${attempt.money.apiCash.observed ? attempt.money.apiCash.observedTotalUsd : 'unknown'} / estimate ${attempt.money.subscriptionApiEquivalent.observed ? attempt.money.subscriptionApiEquivalent.observedTotalUsd : 'unknown'}`
      : ' | cost unknown'
    lines.push(
      `  ${attempt.pairId ?? '?'} arm ${attempt.arm} ${attempt.worker ?? '?'} attempt ${attempt.attempt} run ${attempt.runId ?? '?'} ${score} | successful ${attempt.successful} | safety ${attempt.safetyFailures ?? 'n/a'} | ${attempt.durationMs ?? 'n/a'}ms${attempt.retry ? ' [retry]' : ''}${money}`,
    )
    if (attempt.runFailure)
      lines.push(`      run failure: ${attempt.runFailure.kind} ${attempt.runFailure.message}`)
  }
  lines.push('')
  lines.push('workers (money axes are never summed together):')
  for (const worker of report.workers) {
    lines.push(`  ${worker.worker ?? '?'} / ${worker.model ?? '?'}`)
    lines.push(
      `    attempts ${worker.attempts}, retries ${worker.retries}, successful ${worker.successful}, graded ${worker.graded}, correct ${worker.correct}/${worker.total}`,
    )
    lines.push(
      `    outcomes correct ${worker.outcomes.correct}, incorrect ${worker.outcomes.incorrect}, error ${worker.outcomes.error}, timeout ${worker.outcomes.timeout}, mutated ${worker.outcomes.mutated}`,
    )
    lines.push(
      `    safety failures ${worker.safetyFailures}, run failures ${worker.runFailures}, duration ${worker.durationMs}ms`,
    )
    lines.push(moneyLine('observed API cash (USD)', worker.money.apiCash))
    lines.push(
      moneyLine(
        'subscription API-equivalent estimate (USD, not cash)',
        worker.money.subscriptionApiEquivalent,
      ),
    )
    lines.push(moneyLine('shared quota (not money)', worker.money.sharedQuota))
  }
  lines.push('')
  lines.push(`verdict:    ${report.verdict.status}`)
  for (const reason of report.verdict.reasons) lines.push(`  reason:   ${reason}`)
  for (const error of report.errors) lines.push(`  error:    ${error}`)
  for (const warning of report.warnings) lines.push(`  warning:  ${warning}`)
  return `${lines.join('\n')}\n`
}

function parseArgs(argv) {
  const options = { manifestPath: null, root: REPO_ROOT, json: false }
  const rest = [...argv]
  while (rest.length) {
    const arg = rest.shift()
    if (arg === '--json') options.json = true
    else if (arg === '--root') options.root = path.resolve(rest.shift())
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
    else if (!options.manifestPath) options.manifestPath = arg
    else throw new Error(`unexpected argument: ${arg}`)
  }
  if (!options.manifestPath)
    throw new Error(
      'usage: node tools/model-pilot/report.mjs <explicit-manifest.json> [--root <dir>] [--json]',
    )
  return options
}

export function reportExitCode(report) {
  return report.verdict.status === 'rejected' ? 1 : 0
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const absolute = path.resolve(options.manifestPath)
  const manifest = JSON.parse(readFileSync(absolute, 'utf8'))
  const report = analyzeManifest(manifest, { root: options.root })
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else process.stdout.write(renderReport(report))
  process.exitCode = reportExitCode(report)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`report: ${error.message}\n`)
    process.exitCode = 2
  }
}
