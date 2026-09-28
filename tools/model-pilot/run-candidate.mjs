// Child-process harness for grading a model-supplied candidate.
//
// This file is NOT a candidate and deliberately does not implement `assessClosure`. It only
// imports the candidate module, runs it once per fixture inside a dedicated child process and
// writes the raw observations to file descriptor 3. The parent (`grade.mjs`) owns the bounded
// timeout, the controlled cwd and the safety classification. Writing to fd 3 keeps candidate
// stdout/stderr chatter away from the machine-readable result.
//
// There is no security sandbox here: the candidate is local, generated and independently
// inspected before execution.

import { readFileSync, writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const RESULT_FD = 3

function emit(payload) {
  try {
    writeSync(RESULT_FD, JSON.stringify(payload))
  } catch {
    // The parent may already have closed the pipe after a timeout; nothing to do.
  }
}

function describe(error) {
  if (error && typeof error.stack === 'string') return error.stack
  return String(error)
}

const [candidatePath, fixturesPath] = process.argv.slice(2)

let fixtures
try {
  fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'))
} catch (error) {
  emit({ fatal: `cannot read fixtures: ${describe(error)}` })
  process.exit(0)
}

let assessClosure
try {
  const candidateModule = await import(pathToFileURL(candidatePath).href)
  assessClosure = candidateModule.assessClosure
} catch (error) {
  emit({ fatal: `candidate import failed: ${describe(error)}` })
  process.exit(0)
}

if (typeof assessClosure !== 'function') {
  emit({ fatal: 'candidate does not export a function named assessClosure' })
  process.exit(0)
}

const results = []

for (const fixture of fixtures) {
  const state = structuredClone(fixture.state)
  const before = JSON.stringify(state)
  let actual = null
  let error = null
  try {
    const value = assessClosure(state)
    actual = value === undefined ? null : JSON.parse(JSON.stringify(value))
  } catch (thrown) {
    error = describe(thrown)
  }
  results.push({
    id: fixture.id,
    actual,
    error,
    mutated: JSON.stringify(state) !== before,
  })
}

emit({ results })
// Deliberately no `process.exit(0)`: a nonzero `process.exitCode` or exit handler installed by the
// candidate must surface so the parent can reject the run instead of reporting a clean grade.
