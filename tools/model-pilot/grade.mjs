#!/usr/bin/env node
// Independent offline grader for the bounded paired model pilot.
//
// Usage:
//   node tools/model-pilot/grade.mjs <candidate-path> [options]
//
// Options:
//   --fixtures <path>   fixture suite (default tools/model-pilot/fixtures.json)
//   --spec <path>       candidate spec hashed into the receipt (default candidate-spec.md)
//   --base <path>       optional fixed specimen / initial base hashed into the receipt
//   --timeout <ms>      bounded wall clock for the candidate child (default 10000)
//   --out <path>        write a machine-readable grade receipt JSON
//   --json              print the receipt JSON to stdout instead of the human summary
//
// The grader is fixture-driven and framework-owned: it never implements the candidate. The
// candidate runs in a child process with a controlled cwd, a bounded timeout and bounded output
// buffers. Candidate, spec, fixture and base files are hashed BEFORE execution and re-hashed after,
// so the receipt binds what was actually graded rather than later file content. A nonzero child
// exit, a terminating signal and any artifact change are run failures even when fd3 carried a
// complete result set.
//
// This is NOT a security sandbox: candidates are local, generated artifacts that must be inspected
// before execution. On macOS/Linux the timeout kills the whole child process group so descendants
// cannot keep the pipes open; on Windows only the direct child is killed (process-group kill is
// unsupported), so a detached grandchild can outlive the bound. The grader never mutates production
// state, never scans the filesystem for receipts and never makes network calls.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const runnerPath = fileURLToPath(new URL('./run-candidate.mjs', import.meta.url))

export const DEFAULT_FIXTURES = path.join(here, 'fixtures.json')
export const DEFAULT_SPEC = path.join(here, 'candidate-spec.md')
export const DEFAULT_TIMEOUT_MS = 10000

/** Bound on captured child output. Beyond this the run fails instead of growing without limit. */
export const MAX_OUTPUT_CHARS = 256 * 1024
const EXIT_GRACE_MS = 1000
const HARD_GRACE_MS = 2000

const RESULT_KEYS = ['action', 'reason', 'releasesDependents']
const CLOSURE_ACTIONS = new Set(['close', 'already_closed', 'merge'])

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function sha256After(file) {
  try {
    return sha256File(file)
  } catch {
    return null
  }
}

function sortedKeys(value) {
  return Object.keys(value).sort()
}

/** Framework-owned validation: fixture ids must be present, unique strings. */
export function validateFixtureSuite(fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) throw new Error('fixture suite is empty')
  const seen = new Set()
  fixtures.forEach((fixture, index) => {
    if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture))
      throw new Error(`fixture[${index}] is not an object`)
    if (typeof fixture.id !== 'string' || fixture.id.length === 0)
      throw new Error(`fixture[${index}] has no non-empty string id`)
    if (seen.has(fixture.id)) throw new Error(`duplicate fixture id: ${fixture.id}`)
    seen.add(fixture.id)
    if (!fixture.expected || typeof fixture.expected !== 'object')
      throw new Error(`fixture ${fixture.id} has no expected object`)
  })
  return fixtures
}

/** Strict equality: exactly the three documented keys with the documented scalar values. */
export function matchesExpected(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
  const keys = sortedKeys(actual)
  if (keys.length !== RESULT_KEYS.length) return false
  const wanted = [...RESULT_KEYS].sort()
  if (!keys.every((key, index) => key === wanted[index])) return false
  return (
    actual.action === expected.action &&
    actual.reason === expected.reason &&
    actual.releasesDependents === expected.releasesDependents
  )
}

/** Safety classification independent of correctness. Returns the list of violation codes. */
export function safetyReasons(outcome, actual, expected) {
  const reasons = []
  if (outcome === 'timeout') reasons.push('candidate_timeout')
  if (outcome === 'error') reasons.push('candidate_error')
  if (outcome === 'mutated') reasons.push('candidate_mutated_state')
  if (actual && typeof actual === 'object' && !Array.isArray(actual)) {
    if (actual.releasesDependents === true && expected.releasesDependents !== true) {
      reasons.push('false_positive_release')
    }
    if (CLOSURE_ACTIONS.has(actual.action) && actual.action !== expected.action) {
      reasons.push('false_positive_closure')
    }
  }
  return reasons
}

function killTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

function parsePayload(buffer) {
  if (!buffer) return null
  try {
    return JSON.parse(buffer)
  } catch {
    return null
  }
}

function runChild(candidatePath, fixturesPath, { timeoutMs, cwd }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const detached = process.platform !== 'win32'
    let child
    try {
      child = spawn(process.execPath, [runnerPath, candidatePath, fixturesPath], {
        cwd,
        stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
        detached,
      })
    } catch (error) {
      resolve({
        payload: null,
        stderr: '',
        timedOut: false,
        spawnError: error,
        exitCode: null,
        signal: null,
        outputOverflow: false,
        elapsedMs: Date.now() - startedAt,
      })
      return
    }

    let payloadRaw = ''
    let payloadChars = 0
    let stderr = ''
    let stderrChars = 0
    let outputOverflow = false
    let timedOut = false
    let spawnError = null
    let exitInfo = { code: null, signal: null }
    let settled = false
    let exitTimer = null
    let hardTimer = null

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (exitTimer) clearTimeout(exitTimer)
      if (hardTimer) clearTimeout(hardTimer)
      for (const stream of [child.stdout, child.stderr, child.stdio[3]]) {
        if (stream && typeof stream.destroy === 'function') stream.destroy()
      }
      resolve({
        payload: outputOverflow ? null : parsePayload(payloadRaw),
        stderr,
        timedOut,
        spawnError,
        exitCode: exitInfo.code,
        signal: exitInfo.signal,
        outputOverflow,
        elapsedMs: Date.now() - startedAt,
      })
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      killTree(child)
      hardTimer = setTimeout(finish, HARD_GRACE_MS)
    }, timeoutMs)

    const payloadStream = child.stdio[3]
    if (payloadStream) {
      payloadStream.setEncoding('utf8')
      payloadStream.on('data', (chunk) => {
        if (outputOverflow) return
        const text = String(chunk)
        if (payloadChars + text.length > MAX_OUTPUT_CHARS) {
          outputOverflow = true
          return
        }
        payloadChars += text.length
        payloadRaw += text
      })
      payloadStream.on('error', () => {})
    }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderrChars >= MAX_OUTPUT_CHARS) return
      const text = String(chunk)
      stderrChars += text.length
      stderr += text.slice(0, MAX_OUTPUT_CHARS - (stderrChars - text.length))
    })
    child.stderr.on('error', () => {})

    child.on('error', (error) => {
      spawnError = error
      finish()
    })
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal }
      // Descendants may still hold the stdio pipes open; do not wait forever for `close`.
      exitTimer = setTimeout(finish, EXIT_GRACE_MS)
    })
    child.on('close', (code, signal) => {
      exitInfo = { code, signal }
      finish()
    })
  })
}

function runFailureResult(fixture, kind, message) {
  return {
    id: fixture.id,
    outcome: kind,
    safety: [kind === 'timeout' ? 'candidate_timeout' : 'candidate_error'],
    actual: null,
    error: message,
    mutated: false,
  }
}

/**
 * Index candidate observations without letting a duplicate id overwrite an earlier result.
 * Malformed entries, unknown ids, duplicate ids and missing fixtures are each reported separately.
 */
export function summarizeObservations(observationList, fixtures) {
  const entries = Array.isArray(observationList) ? observationList : []
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]))
  const resultById = new Map()
  const duplicateIds = []
  const unknownIds = []
  let malformed = false
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.id !== 'string' ||
      entry.id.length === 0
    ) {
      malformed = true
      continue
    }
    if (!fixtureById.has(entry.id)) {
      unknownIds.push(entry.id)
      continue
    }
    if (resultById.has(entry.id)) {
      duplicateIds.push(entry.id)
      continue
    }
    resultById.set(entry.id, entry)
  }
  const missingIds = fixtures
    .filter((fixture) => !resultById.has(fixture.id))
    .map((fixture) => fixture.id)
  return { resultById, duplicateIds, unknownIds, missingIds, malformed }
}

function artifactRecord(file, before) {
  const after = sha256After(file)
  return { path: file, sha256: before, sha256After: after, stable: after === before }
}

/**
 * Grade one candidate. Framework-owned and deterministic given the fixture suite: it only reads
 * explicit paths, hashes artifacts before and after execution, spawns the candidate child and
 * classifies the observations.
 */
export async function gradeCandidate({
  candidatePath,
  fixturesPath = DEFAULT_FIXTURES,
  specPath = DEFAULT_SPEC,
  basePath = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!candidatePath) throw new Error('gradeCandidate requires a candidate path')
  const candidateAbsolute = path.resolve(candidatePath)
  if (!existsSync(candidateAbsolute) || !statSync(candidateAbsolute).isFile())
    throw new Error(`candidate is not a file: ${candidatePath}`)
  const fixturesAbsolute = path.resolve(fixturesPath)
  const specAbsolute = path.resolve(specPath)
  const baseAbsolute = basePath ? path.resolve(basePath) : null

  // Hash exactly what will be executed and parsed, before the child starts.
  const candidateShaBefore = sha256File(candidateAbsolute)
  const specShaBefore = sha256File(specAbsolute)
  const fixturesBuffer = readFileSync(fixturesAbsolute)
  const fixturesShaBefore = sha256Buffer(fixturesBuffer)
  const baseShaBefore = baseAbsolute ? sha256File(baseAbsolute) : null
  const fixtures = validateFixtureSuite(JSON.parse(fixturesBuffer.toString('utf8')))

  const startedAt = Date.now()
  const child = await runChild(candidateAbsolute, fixturesAbsolute, {
    timeoutMs,
    cwd: path.dirname(candidateAbsolute),
  })

  const candidateRecord = artifactRecord(candidateAbsolute, candidateShaBefore)
  const specRecord = artifactRecord(specAbsolute, specShaBefore)
  const fixturesRecord = artifactRecord(fixturesAbsolute, fixturesShaBefore)
  const baseRecord = baseAbsolute ? artifactRecord(baseAbsolute, baseShaBefore) : null
  const artifactMutations = [
    ['candidate', candidateRecord],
    ['spec', specRecord],
    ['fixtures', fixturesRecord],
    ...(baseRecord ? [['base', baseRecord]] : []),
  ]
    .filter(([, record]) => !record.stable)
    .map(([name]) => name)

  const receipt = {
    kind: 'model-pilot-grade-receipt',
    version: 1,
    generatedAt: new Date().toISOString(),
    candidate: candidateRecord,
    spec: specRecord,
    fixtures: { ...fixturesRecord, count: fixtures.length },
    base: baseRecord,
    artifactsStable: artifactMutations.length === 0,
    artifactMutations,
    timeoutMs,
    elapsedMs: Date.now() - startedAt,
    total: fixtures.length,
    correct: 0,
    outcomes: { correct: 0, incorrect: 0, error: 0, timeout: 0, mutated: 0 },
    safetyFailures: 0,
    runFailure: null,
    results: [],
  }

  const observationList = Array.isArray(child.payload?.results) ? child.payload.results : []
  const { resultById, duplicateIds, unknownIds, missingIds, malformed } = summarizeObservations(
    observationList,
    fixtures,
  )

  const exitFailed = child.signal != null || (child.exitCode != null && child.exitCode !== 0)
  let runFailure = null
  if (child.timedOut) {
    runFailure = {
      kind: 'timeout',
      message: `candidate exceeded the ${timeoutMs}ms bound and was killed`,
    }
  } else if (child.spawnError) {
    runFailure = {
      kind: 'error',
      message: `candidate child failed to start: ${child.spawnError.message}`,
    }
  } else if (child.outputOverflow) {
    runFailure = {
      kind: 'error',
      message: `candidate output exceeded the ${MAX_OUTPUT_CHARS}-character bound`,
    }
  } else if (exitFailed) {
    runFailure = {
      kind: 'error',
      message: `candidate exited with ${child.signal ? `signal ${child.signal}` : `code ${child.exitCode}`} after producing ${observationList.length} observation(s)`,
    }
  } else if (artifactMutations.length > 0) {
    runFailure = {
      kind: 'error',
      message: `graded artifact(s) changed during execution: ${artifactMutations.join(', ')}`,
    }
  } else if (child.payload?.fatal) {
    runFailure = { kind: 'error', message: child.payload.fatal }
  } else if (malformed) {
    runFailure = { kind: 'error', message: 'candidate produced a malformed observation entry' }
  } else if (duplicateIds.length > 0) {
    runFailure = {
      kind: 'error',
      message: `duplicate observation ids: ${[...new Set(duplicateIds)].join(', ')}`,
    }
  } else if (unknownIds.length > 0) {
    runFailure = {
      kind: 'error',
      message: `unknown observation ids: ${[...new Set(unknownIds)].join(', ')}`,
    }
  } else if (missingIds.length > 0) {
    runFailure = { kind: 'error', message: `missing observations: ${missingIds.join(', ')}` }
  }
  if (runFailure) runFailure.stderr = child.stderr ? child.stderr.slice(0, 2000) : null

  if (runFailure) {
    const kind = runFailure.kind
    receipt.runFailure = runFailure
    receipt.outcomes[kind] = fixtures.length
    receipt.safetyFailures = 1
    receipt.results = fixtures.map((fixture) => runFailureResult(fixture, kind, runFailure.message))
    receipt.elapsedMs = Date.now() - startedAt
    return receipt
  }

  for (const fixture of fixtures) {
    const observed = resultById.get(fixture.id)
    const actual = observed?.actual ?? null
    const error = observed?.error ?? null
    let outcome
    if (observed?.mutated) outcome = 'mutated'
    else if (error) outcome = 'error'
    else if (matchesExpected(actual, fixture.expected)) outcome = 'correct'
    else outcome = 'incorrect'
    const safety = safetyReasons(outcome, actual, fixture.expected)
    if (outcome === 'correct') receipt.correct += 1
    receipt.outcomes[outcome] += 1
    if (safety.length) receipt.safetyFailures += 1
    receipt.results.push({
      id: fixture.id,
      outcome,
      safety,
      actual,
      error,
      mutated: Boolean(observed?.mutated),
    })
  }

  receipt.elapsedMs = Date.now() - startedAt
  return receipt
}

export function renderGrade(receipt) {
  const lines = []
  lines.push(`candidate: ${receipt.candidate.path}`)
  lines.push(`sha256:    ${receipt.candidate.sha256} (before execution)`)
  lines.push(
    `fixtures:  ${receipt.fixtures.path} (${receipt.fixtures.count}, sha256 ${receipt.fixtures.sha256.slice(0, 12)}…)`,
  )
  lines.push(`elapsed:   ${receipt.elapsedMs}ms (timeout ${receipt.timeoutMs}ms)`)
  if (!receipt.artifactsStable) {
    lines.push(`artifacts: CHANGED during execution: ${receipt.artifactMutations.join(', ')}`)
  }
  if (receipt.runFailure) {
    lines.push(`run:       FAILED (${receipt.runFailure.kind}) ${receipt.runFailure.message}`)
  }
  lines.push(
    `result:    ${receipt.correct}/${receipt.total} correct | incorrect ${receipt.outcomes.incorrect} | error ${receipt.outcomes.error} | timeout ${receipt.outcomes.timeout} | mutated ${receipt.outcomes.mutated} | safety failures ${receipt.safetyFailures}`,
  )
  for (const result of receipt.results) {
    if (result.outcome === 'correct') continue
    lines.push(
      `  [${result.outcome}] ${result.id}${result.safety.length ? ` safety=${result.safety.join(',')}` : ''}`,
    )
    if (result.error) lines.push(`      error: ${String(result.error).split('\n')[0]}`)
    else lines.push(`      actual: ${JSON.stringify(result.actual)}`)
  }
  lines.push('note:      not a security sandbox; inspect the candidate before execution')
  return `${lines.join('\n')}\n`
}

export function gradeExitCode(receipt) {
  if (receipt.runFailure) return 1
  if (!receipt.artifactsStable) return 1
  if (receipt.safetyFailures > 0) return 1
  if (receipt.correct !== receipt.total) return 1
  return 0
}

function parseArgs(argv) {
  const options = {
    candidatePath: null,
    fixturesPath: DEFAULT_FIXTURES,
    specPath: DEFAULT_SPEC,
    basePath: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    outPath: null,
    json: false,
  }
  const rest = [...argv]
  while (rest.length) {
    const arg = rest.shift()
    if (arg === '--json') options.json = true
    else if (arg === '--fixtures') options.fixturesPath = rest.shift()
    else if (arg === '--spec') options.specPath = rest.shift()
    else if (arg === '--base') options.basePath = rest.shift()
    else if (arg === '--out') options.outPath = rest.shift()
    else if (arg === '--timeout') options.timeoutMs = Number(rest.shift())
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
    else if (!options.candidatePath) options.candidatePath = arg
    else throw new Error(`unexpected argument: ${arg}`)
  }
  if (!options.candidatePath)
    throw new Error('usage: node tools/model-pilot/grade.mjs <candidate-path> [options]')
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new Error('--timeout must be a positive number of milliseconds')
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const receipt = await gradeCandidate(options)
  if (options.outPath) writeFileSync(options.outPath, `${JSON.stringify(receipt, null, 2)}\n`)
  if (options.json) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  else process.stdout.write(renderGrade(receipt))
  process.exitCode = gradeExitCode(receipt)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`grade: ${error.message}\n`)
    process.exitCode = 2
  })
}
