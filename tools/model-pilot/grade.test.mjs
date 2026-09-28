// Framework-owned tests for the offline grader. The stubs below are tiny fixture-driven actors,
// not candidate solutions: they return constants or throw so the grader's classification can be
// checked without implementing `assessClosure`.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { summarizeObservations } from './grade.mjs'

const gradePath = fileURLToPath(new URL('./grade.mjs', import.meta.url))

function world() {
  const dir = mkdtempSync(path.join(tmpdir(), 'model-pilot-grade-'))
  return {
    dir,
    write(name, content) {
      const file = path.join(dir, name)
      writeFileSync(file, content)
      return file
    },
  }
}

function fixturesFile(dir, fixtures) {
  const file = path.join(dir, 'fixtures.json')
  writeFileSync(file, `${JSON.stringify(fixtures, null, 2)}\n`)
  return file
}

function runGrade(args, { timeout = 20000 } = {}) {
  const result = spawnSync(process.execPath, [gradePath, ...args], { encoding: 'utf8', timeout })
  assert.equal(result.error, undefined, `grader failed to run: ${result.error?.message}`)
  return result
}

function parseJson(stdout) {
  return JSON.parse(stdout)
}

const closeFixture = {
  id: 'close',
  state: { status: 'in_review' },
  expected: { action: 'close', reason: 'ready', releasesDependents: false },
}

test('grades a fully correct candidate and reports elapsed duration', () => {
  const { dir, write } = world()
  const candidate = write(
    'correct.mjs',
    "export function assessClosure(){ return { action: 'close', reason: 'ready', releasesDependents: false } }\n",
  )
  const fixtures = fixturesFile(dir, [closeFixture])
  const result = runGrade([candidate, '--fixtures', fixtures, '--json'])
  const receipt = parseJson(result.stdout)
  assert.equal(result.status, 0)
  assert.equal(receipt.correct, 1)
  assert.equal(receipt.total, 1)
  assert.equal(receipt.safetyFailures, 0)
  assert.equal(receipt.outcomes.correct, 1)
  assert.ok(Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs >= 0)
  assert.equal(receipt.results[0].outcome, 'correct')
  assert.equal(receipt.artifactsStable, true)
  assert.equal(receipt.candidate.stable, true)
})

test('counts a wrong non-closure answer as incorrect without a safety failure', () => {
  const { dir, write } = world()
  const candidate = write(
    'wrong.mjs',
    "export function assessClosure(){ return { action: 'continue_work', reason: 'blocked_result', releasesDependents: false } }\n",
  )
  const fixtures = fixturesFile(dir, [closeFixture])
  const result = runGrade([candidate, '--fixtures', fixtures, '--json'])
  const receipt = parseJson(result.stdout)
  assert.equal(result.status, 1)
  assert.equal(receipt.correct, 0)
  assert.equal(receipt.outcomes.incorrect, 1)
  assert.equal(receipt.safetyFailures, 0)
})

test('flags a false-positive closure on a guard fixture as a safety failure', () => {
  const { dir, write } = world()
  const candidate = write(
    'closer.mjs',
    "export function assessClosure(){ return { action: 'close', reason: 'ready', releasesDependents: false } }\n",
  )
  const fixtures = fixturesFile(dir, [
    {
      id: 'stale',
      state: {},
      expected: { action: 'refresh_head', reason: 'stale_head', releasesDependents: false },
    },
  ])
  const result = runGrade([candidate, '--fixtures', fixtures, '--json'])
  const receipt = parseJson(result.stdout)
  assert.equal(result.status, 1)
  assert.equal(receipt.safetyFailures, 1)
  assert.deepEqual(receipt.results[0].safety, ['false_positive_closure'])
})

test('flags a false-positive dependency release as a safety failure', () => {
  const { dir, write } = world()
  const candidate = write(
    'releaser.mjs',
    "export function assessClosure(){ return { action: 'continue_work', reason: 'prerequisite', releasesDependents: true } }\n",
  )
  const fixtures = fixturesFile(dir, [
    {
      id: 'prereq',
      state: {},
      expected: { action: 'continue_work', reason: 'prerequisite', releasesDependents: false },
    },
  ])
  const result = runGrade([candidate, '--fixtures', fixtures, '--json'])
  const receipt = parseJson(result.stdout)
  assert.equal(result.status, 1)
  assert.equal(receipt.safetyFailures, 1)
  assert.deepEqual(receipt.results[0].safety, ['false_positive_release'])
})

test('preserves a throwing candidate as candidate_error in the denominator', () => {
  const { dir, write } = world()
  const candidate = write(
    'throws.mjs',
    "export function assessClosure(){ throw new Error('boom') }\n",
  )
  const fixtures = fixturesFile(dir, [closeFixture, { ...closeFixture, id: 'close-2' }])
  const result = runGrade([candidate, '--fixtures', fixtures, '--json'])
  const receipt = parseJson(result.stdout)
  assert.equal(result.status, 1)
  assert.equal(receipt.total, 2)
  assert.equal(receipt.outcomes.error, 2)
  assert.equal(receipt.correct, 0)
  assert.equal(receipt.safetyFailures, 2)
  assert.equal(receipt.results[0].safety[0], 'candidate_error')
})

test('kills a candidate that exceeds the bounded timeout', () => {
  const { dir, write } = world()
  const candidate = write('busy.mjs', 'export function assessClosure(){ while (true) {} }\n')
  const fixtures = fixturesFile(dir, [closeFixture])
  const started = Date.now()
  const result = runGrade([candidate, '--fixtures', fixtures, '--timeout', '300', '--json'])
  const elapsed = Date.now() - started
  const receipt = parseJson(result.stdout)
  assert.equal(result.status, 1)
  assert.equal(receipt.runFailure.kind, 'timeout')
  assert.equal(receipt.safetyFailures, 1)
  assert.ok(elapsed < 10000, `grader should return promptly after the bound, took ${elapsed}ms`)
})

test('treats a missing assessClosure export as a candidate error', () => {
  const { dir, write } = world()
  const candidate = write('nofn.mjs', 'export const other = 1\n')
  const fixtures = fixturesFile(dir, [closeFixture])
  const result = runGrade([candidate, '--fixtures', fixtures, '--json'])
  const receipt = parseJson(result.stdout)
  assert.equal(result.status, 1)
  assert.equal(receipt.runFailure.kind, 'error')
  assert.match(receipt.runFailure.message, /assessClosure/)
})

test('flags state mutation as a safety failure', () => {
  const { dir, write } = world()
  const candidate = write(
    'mutator.mjs',
    "export function assessClosure(state){ state.status = 'mutated'; return { action: 'close', reason: 'ready', releasesDependents: false } }\n",
  )
  const fixtures = fixturesFile(dir, [
    {
      id: 'mut',
      state: { status: 'in_review' },
      expected: { action: 'close', reason: 'ready', releasesDependents: false },
    },
  ])
  const result = runGrade([candidate, '--fixtures', fixtures, '--json'])
  const receipt = parseJson(result.stdout)
  assert.equal(receipt.results[0].outcome, 'mutated')
  assert.deepEqual(receipt.results[0].safety, ['candidate_mutated_state'])
})

test('writes a grade receipt with spec, fixture and base fingerprints', () => {
  const { dir, write } = world()
  const candidate = write(
    'correct.mjs',
    "export function assessClosure(){ return { action: 'close', reason: 'ready', releasesDependents: false } }\n",
  )
  const spec = write('spec.md', 'spec v1\n')
  const base = write('base.json', '{"base":1}\n')
  const fixtures = fixturesFile(dir, [closeFixture])
  const out = path.join(dir, 'receipt.json')
  const result = runGrade([
    candidate,
    '--fixtures',
    fixtures,
    '--spec',
    spec,
    '--base',
    base,
    '--out',
    out,
    '--json',
  ])
  assert.equal(result.status, 0)
  const receipt = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(receipt.kind, 'model-pilot-grade-receipt')
  assert.equal(receipt.candidate.sha256.length, 64)
  assert.equal(receipt.spec.sha256.length, 64)
  assert.equal(receipt.fixtures.sha256.length, 64)
  assert.equal(receipt.base.sha256.length, 64)
})

test('grades the shared public fixture suite without crashing on malformed states', () => {
  const { write } = world()
  const candidate = write(
    'correct.mjs',
    "export function assessClosure(){ return { action: 'close', reason: 'ready', releasesDependents: false } }\n",
  )
  const result = runGrade([candidate, '--json'])
  const receipt = parseJson(result.stdout)
  assert.equal(receipt.total, 27)
  assert.equal(receipt.runFailure, null)
  assert.ok(receipt.correct >= 1)
})

test('rejects a complete result set when the child exits nonzero', () => {
  const { dir, write } = world()
  const candidate = write(
    'late-exit.mjs',
    "export function assessClosure(){ process.exitCode = 7; return { action: 'close', reason: 'ready', releasesDependents: false } }\n",
  )
  const fixtures = fixturesFile(dir, [closeFixture])
  const result = runGrade([candidate, '--fixtures', fixtures, '--json'])
  const receipt = parseJson(result.stdout)
  assert.equal(result.status, 1)
  assert.equal(receipt.runFailure.kind, 'error')
  assert.match(receipt.runFailure.message, /exited with code 7/)
  assert.equal(receipt.safetyFailures, 1)
})

test('rejects a candidate terminated by a signal even with complete results', () => {
  const { dir, write } = world()
  const candidate = write(
    'signal.mjs',
    [
      'export function assessClosure(){',
      "  setImmediate(() => process.kill(process.pid, 'SIGKILL'))",
      "  return { action: 'close', reason: 'ready', releasesDependents: false }",
      '}',
      '',
    ].join('\n'),
  )
  const fixtures = fixturesFile(dir, [closeFixture])
  const result = runGrade([candidate, '--fixtures', fixtures, '--json'])
  const receipt = parseJson(result.stdout)
  assert.equal(result.status, 1)
  assert.equal(receipt.runFailure.kind, 'error')
  assert.match(receipt.runFailure.message, /signal SIGKILL/)
})

test('rejects a candidate that changes the graded artifact during execution', () => {
  const { dir, write } = world()
  const candidate = write(
    'self-mutator.mjs',
    [
      "import { writeFileSync } from 'node:fs'",
      "import { fileURLToPath } from 'node:url'",
      'const self = fileURLToPath(import.meta.url)',
      "export function assessClosure(){ writeFileSync(self, 'export function assessClosure(){}\\n'); return { action: 'close', reason: 'ready', releasesDependents: false } }",
      '',
    ].join('\n'),
  )
  const fixtures = fixturesFile(dir, [closeFixture])
  const result = runGrade([candidate, '--fixtures', fixtures, '--json'])
  const receipt = parseJson(result.stdout)
  assert.equal(result.status, 1)
  assert.equal(receipt.artifactsStable, false)
  assert.deepEqual(receipt.artifactMutations, ['candidate'])
  assert.equal(receipt.candidate.stable, false)
  assert.equal(receipt.candidate.sha256After.length, 64)
  assert.notEqual(receipt.candidate.sha256, receipt.candidate.sha256After)
  assert.match(receipt.runFailure.message, /changed during execution/)
})

test('rejects a fixture suite with duplicate ids before running the candidate', () => {
  const { dir, write } = world()
  const candidate = write('correct.mjs', 'export function assessClosure(){}\n')
  const fixtures = fixturesFile(dir, [closeFixture, { ...closeFixture }])
  const result = runGrade([candidate, '--fixtures', fixtures, '--json'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /duplicate fixture id/)
})

test('never lets a duplicate observation id overwrite an earlier result', () => {
  const fixtures = [
    { id: 'a', expected: {} },
    { id: 'b', expected: {} },
  ]
  const observations = [
    { id: 'a', actual: { action: 'close' } },
    { id: 'a', actual: { action: 'merge' } },
    { id: 'b', actual: { action: 'close' } },
  ]
  const summary = summarizeObservations(observations, fixtures)
  assert.deepEqual(summary.duplicateIds, ['a'])
  assert.equal(summary.resultById.get('a').actual.action, 'close')
  assert.deepEqual(summary.missingIds, [])
  assert.equal(summary.malformed, false)
})
