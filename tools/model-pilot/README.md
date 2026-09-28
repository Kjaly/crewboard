# Paired model pilot tooling

Framework-owned tooling for the bounded paired pilot described in
[`docs/audits/2026-09-28/cache-plan.md`](../../docs/audits/2026-09-28/cache-plan.md) (phase 3,
Flash pilot). This is **setup only**: the tooling itself has not run any model, makes no API calls
and changes no production route. Framework authoring did invoke the two workers once (Codex failed
with a 403, dsh Flash completed), but that smoke is not a graded pair. The smoke suite is public and
fixture-driven; it is **not** a blind benchmark and one sample per model proves nothing about
superiority. A full clean run only makes the pilot *eligible for broader evaluation*; it never
promotes production routing.

The tooling never implements the candidate. A model supplies `assessClosure`; the framework only
executes, classifies and reports it.

## Guardrails

- Owned paths: `tools/model-pilot/*` and `docs/evals/model-pilot.md` only.
- No provider, preset, routing, cost-reader or orchestration-core edits. The saved preset
  allow-list and `fallback: []` stay untouched.
- An explicit worker choice (`-a codex/gpt-6-luna`, `-a dsh/deepseek-flash`) is allowed only for
  this experiment and only when the saved preset already permits that worker. No fallback invention.
- Budget for the smoke: **one attempt per model, no automatic retries**, supervised at the first
  minute, stopped after a bounded wall time.
- No direct model/API calls from the grader, the report or the tests. Candidates are local,
  generated artifacts that the orchestrator independently inspects before execution.
- The child timeout and output bounds are **liveness guards, not a security sandbox**.

## Files

| Path | Purpose |
| --- | --- |
| `candidate-spec.md` | Frozen candidate contract and the exact normalized precedence. |
| `fixtures.json` | Shared public fixture suite (one case per precedence branch plus safety edges). |
| `grade.mjs` | `node tools/model-pilot/grade.mjs <candidate-path>` — independent offline grading. |
| `report.mjs` | `node tools/model-pilot/report.mjs <explicit-manifest.json>` — provenance-checked trial report. |
| `run-candidate.mjs` | Child harness that runs the candidate and reports raw observations. |
| `grade.test.mjs`, `report.test.mjs` | Native `node:test` regressions. |
| `candidates/`, `receipts/` | Drop points for model outputs and explicit receipts. |

`base.json` and `manifest.json` are **per-pilot inputs, not shipped**: the orchestrator creates them from the frozen artifact set before grading and reporting (the examples below assume both exist). The framework itself is complete and fixture-driven; no model sample, candidate or receipt is in the repository yet.

## Candidate contract

`candidate-spec.md` is authoritative. In short: pure synchronous JavaScript exporting
`assessClosure(state)` with no mutation, I/O or network, returning exactly
`{ action, reason, releasesDependents }`. Malformed state yields
`refresh_state / invalid_state / false`. The full first-match precedence is in the spec and must be
preserved verbatim.

## Grade one candidate

```bash
node tools/model-pilot/grade.mjs tools/model-pilot/candidates/flash.mjs \
  --fixtures tools/model-pilot/fixtures.json \
  --spec tools/model-pilot/candidate-spec.md \
  --base tools/model-pilot/base.json \
  --timeout 10000 \
  --out tools/model-pilot/receipts/flash-grade.json
```

Options: `--fixtures`, `--spec`, `--base`, `--timeout <ms>`, `--out <path>`, `--json`.

What the grader guarantees:

- It hashes the candidate, spec, fixture and base files **before** execution and re-hashes them
  afterwards. The receipt binds the before-execution hashes, so it describes what was actually
  graded, not later file content. Any change is an `artifactMutations` run failure.
- A nonzero child exit or a terminating signal is a run failure even when the child produced a
  complete observation set.
- Child output is bounded (256 KiB). On timeout the whole process group is killed on macOS/Linux
  so descendants cannot keep the pipes open; on Windows only the direct child is killed, so a
  detached grandchild can outlive the bound.
- Duplicate or missing fixture ids are rejected before the candidate runs. Duplicate, unknown or
  malformed observation ids are run failures and never overwrite an earlier result.
- `false_positive_release` (releasing dependents when not allowed) and `false_positive_closure`
  (returning `close`, `already_closed` or `merge` when a guard applies) are safety failures.
  Candidate errors, timeouts, state mutation and run failures are safety failures too.

Exit codes: `0` all fixtures correct with no safety failures, `1` incorrect/safety/run failure,
`2` usage or fixture-suite error.

## Run a single smoke pair through Crewboard

Preconditions: the repository plan is initialized, the saved preset allows both workers, and a
short contract points the worker at `candidate-spec.md` and the exact output path. Add two independent tasks from the same frozen Git base, one per model. Do not reuse a completed candidate's worktree for the other arm, and inspect the recorded baseline for both tasks. Do **not** edit the preset.

```bash
# One attempt per model. --worker passes preflight and must be in the saved allow-list.
crewboard run pilot-luna  -a codex/gpt-6-luna
crewboard run pilot-flash -a dsh/deepseek-flash

# Supervise the first minute, then stop after the agreed bounded wall time if still running.
crewboard status
crewboard stop pilot-flash
```

Each model writes its own file; the spec, fixture suite and initial base are identical:

```text
tools/model-pilot/candidates/luna.mjs
tools/model-pilot/candidates/flash.mjs
```

No retries and no worker substitution mid-run. Grade both outputs independently after creation:

```bash
node tools/model-pilot/grade.mjs tools/model-pilot/candidates/luna.mjs  --base tools/model-pilot/base.json --out tools/model-pilot/receipts/luna-grade.json
node tools/model-pilot/grade.mjs tools/model-pilot/candidates/flash.mjs --base tools/model-pilot/base.json --out tools/model-pilot/receipts/flash-grade.json
```

## Cost evidence: the raw `crewboard cost --json` export

The report consumes the **raw** cost export, not a hand-copied summary. Export with task ids:

```bash
crewboard cost --by task --json > tools/model-pilot/receipts/cost-export.json
```

The report selects the attempt's exact `runId` from `runs[]` and validates `agent`/
`canonicalWorkerId`, `model` and `taskId` against the arm and attempt. It maps
`cashUsd.value` plus `availability.cash` (`known`/`partial`/`pending`/`unavailable`/
`notApplicable`) to the cash axis and `apiEquivalentUsd.value` to the estimate axis. It never
overrides a declared `partial`/`unavailable`/`pending` state with a numeric value, never invents a
worker or model, and leaves a run that is absent from the export `pending`. `quotaMeasurements`
with `attribution: "shared"` stay on the shared-quota axis, which is not money. Money axes are
never added together.

A normalized wrapper file is rejected: the named artifact must itself be a raw export with a
`runs` array. Each named artifact descriptor in the manifest includes a 64-hex SHA-256 that must
match the file; compute it with `shasum -a 256 <file>`.

## Report one pair (or the whole trial)

The manifest is the only input and names every artifact explicitly:

```bash
node tools/model-pilot/report.mjs tools/model-pilot/manifest.json
node tools/model-pilot/report.mjs tools/model-pilot/manifest.json --json
```

Manifest shape (both arms shown abbreviated; every `sha256` is required):

```json
{
  "schemaVersion": 1,
  "pilot": "paired-model-pilot",
  "specimen": { "base": { "path": "tools/model-pilot/base.json", "sha256": "<64 hex>" } },
  "spec": { "path": "tools/model-pilot/candidate-spec.md", "sha256": "<64 hex>" },
  "fixtures": { "path": "tools/model-pilot/fixtures.json", "sha256": "<64 hex>" },
  "plannedRepetitions": 20,
  "independentReview": {
    "reviewer": "<name>",
    "reviewedAt": "2026-09-28",
    "artifact": { "path": "tools/model-pilot/receipts/review.json", "sha256": "<64 hex>" }
  },
  "attribution": { "orchestrator": "unknown", "review": "unknown" },
  "pairs": [
    {
      "pairId": "smoke-001",
      "base": { "path": "tools/model-pilot/base.json", "sha256": "<64 hex>" },
      "arms": [
        {
          "arm": "A",
          "worker": "codex/gpt-6-luna",
          "model": "gpt-6-luna",
          "candidate": { "path": "tools/model-pilot/candidates/luna.mjs", "sha256": "<64 hex>" },
          "attempts": [
            {
              "attempt": 1,
              "taskId": "pilot-luna",
              "runId": "run_...",
              "durationMs": 42000,
              "retry": false,
              "gradeReceipt": { "path": "tools/model-pilot/receipts/luna-grade.json", "sha256": "<64 hex>" },
              "costExport": { "path": "tools/model-pilot/receipts/cost-export.json", "sha256": "<64 hex>" }
            }
          ]
        },
        {
          "arm": "B",
          "worker": "dsh/deepseek-flash",
          "model": "deepseek-flash",
          "candidate": { "path": "tools/model-pilot/candidates/flash.mjs", "sha256": "<64 hex>" },
          "attempts": [
            {
              "attempt": 1,
              "taskId": "pilot-flash",
              "runId": "run_...",
              "durationMs": 51000,
              "retry": false,
              "gradeReceipt": { "path": "tools/model-pilot/receipts/flash-grade.json", "sha256": "<64 hex>" },
              "costExport": { "path": "tools/model-pilot/receipts/cost-export.json", "sha256": "<64 hex>" }
            }
          ]
        }
      ]
    }
  ]
}
```

The report rejects: a missing or non-64-hex descriptor SHA, a missing grade receipt, a grade
receipt whose candidate/spec/fixture/base bindings are absent or inconsistent, a grade receipt
whose `total`/`correct`/`outcomes`/`safetyFailures` disagree with its own `results`, a results set
that does not cover the fixture-suite ids exactly, duplicate fixture or run ids, a pair base that
differs from the fixed specimen, mismatched spec/fixture/candidate fingerprints, and a cost export
that is not raw or whose run identity disagrees with the arm. Errors and timeouts stay in the
correctness denominator but never count as a successful repetition. `--root <dir>` overrides the
repository root (used by tests).

Verdict: `rejected` (invalid provenance), `not_promotable` (safety failures), `inconclusive`
(fewer than the required successful paired repetitions or no independent review), or
`eligible_for_broader_evaluation`. The last only means the pilot may be evaluated further; public
fixtures cannot promote production routing and no routing action is taken. One sample per model is
always inconclusive.

## Tests

```bash
node --test tools/model-pilot/*.test.mjs
```

The tests cover incorrect/throw/timeout/negative-gate grader behaviour, late nonzero exit and
signal termination, artifact mutation, duplicate fixture/observation ids, and report
provenance/missing-receipt/marker-only-receipt/unknown-money/partial-coverage/mixed-export/low-N
safety.
