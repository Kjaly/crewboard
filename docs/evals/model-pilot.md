# Paired model pilot — public smoke tooling

**Status:** framework setup only. Phase 3 (*Flash pilot*) of the
[context-and-cost plan](../audits/2026-09-28/cache-plan.md) is approved to compare the current
Codex Luna worker and a permitted dsh DeepSeek Flash worker on identical small tasks. No paired
candidate trial has run yet, no candidate exists and no production route changed. (The framework
authoring step did invoke those workers — the Codex arm failed with a 403, the Flash arm completed —
but that smoke is not a graded pair.)

This suite is a **public smoke probe**. It is not blind, not a benchmark and not statistical
evidence: one sample per model is inconclusive, and no savings claim can be made from it. A full
clean run only makes the pilot *eligible for broader evaluation*; it can never promote production
routing, and the tooling takes no routing action.

## What is compared

Both arms get the same frozen artifact set and must produce a pure synchronous
`assessClosure(state)` that predicts the permitted next action from a normalized task snapshot.
The exact contract and first-match precedence live in
[`tools/model-pilot/candidate-spec.md`](../../tools/model-pilot/candidate-spec.md); the shared
public fixture suite is [`tools/model-pilot/fixtures.json`](../../tools/model-pilot/fixtures.json).
The suite covers ordinary successful work, stale HEAD, stale contract, dirty/conflicts, pending
check, failing required gate, a current orchestrator positive over an old blocked worker (READY03),
root tasks that stay human-controlled despite a green check, human review and decision gates,
already-closed tasks, and negative prerequisites that never release dependents.

## Tooling

[`tools/model-pilot/README.md`](../../tools/model-pilot/README.md) is the runbook. The two entry
points are:

```bash
node tools/model-pilot/grade.mjs tools/model-pilot/candidates/flash.mjs \
  --base tools/model-pilot/base.json --out tools/model-pilot/receipts/flash-grade.json
node tools/model-pilot/report.mjs tools/model-pilot/manifest.json
```

The grader runs the candidate in a child process with a controlled cwd, a bounded timeout and
bounded output. It hashes the candidate, spec, fixture and base files before execution and again
afterwards; the receipt binds the before-execution hashes. A nonzero child exit, a terminating
signal or any artifact change is a run failure even with a complete result set, and a failing run
keeps every fixture in the denominator. False-positive dependency release and false-positive
auto-close are safety failures. This is a liveness guard, not a security sandbox: candidates are
local artifacts that must be inspected before execution.

The report reads only the explicit manifest. Every named descriptor needs a matching 64-hex
SHA-256, a grade receipt must bind candidate/spec/fixture/base and be internally consistent with
its own results and the fixture-suite ids, and the cost evidence must be the raw
`crewboard cost --json` export selected by the exact unique run id and checked against the
attempt's worker, model and task. It rejects mismatched initial base or fingerprints, duplicate run
ids and duplicate fixture ids, and any normalized cost wrapper. Observed API cash, the subscription
API-equivalent estimate and shared quota stay separate axes; a declared `partial`/`unavailable`
money state is never turned into an observed value; missing billing stays pending. Negative and
errored attempts stay in the denominator but never count as successful repetitions, and no full
cost per accepted task is computed while orchestrator/review attribution is unknown.

## Evaluation threshold

Broader evaluation needs at least **20 successful paired repetitions**, **zero safety failures**, a
fixed specimen and an independent review receipt. Below that the report stays `inconclusive`;
safety failures make it `not_promotable`; invalid provenance makes it `rejected`; a full clean set
is `eligible_for_broader_evaluation`. The smoke budget is one attempt per model with no automatic
retries. The fixed specimen (`base.json`) and the report manifest (`manifest.json`) are per-pilot
inputs the orchestrator creates; they do not ship in the repository, and the commands in the runbook
assume them.

## Deviation journal

### 2026-09-28 — framework setup, no model sample

- Built the shared spec, the fixture suite, the offline grader and the report utility; no candidate
  was implemented and no model, provider, preset or routing code was touched.
- Chosen deviations from the original sketch, recorded here:
  - The grader was hardened after an early review: artifact hashing moved before execution with an
    after-check, nonzero exit and terminating signals now fail a run, output buffers are bounded,
    and the timeout kills the process group on macOS/Linux (Windows process-group kill is
    unsupported, so a detached grandchild may outlive the bound).
  - Fixture and observation ids are validated for uniqueness; a duplicate observation never
    overwrites an earlier result.
  - A second review tightened the report: descriptor SHA-256 is mandatory for frozen artifacts;
    grade receipts must be internally consistent against the graded fixture ids; a successful
    repetition requires a clean, complete grade rather than an empty or errored one; and a declared
    `partial`/`unavailable` coverage state is never overridden by a numeric value.
  - Cost evidence moved from a hand-copied receipt to the raw `crewboard cost --by task --json`
    export: the report selects the exact unique run id and validates worker, model and task. A
    normalized wrapper is rejected. Missing billing remains pending/unavailable. No filesystem
    scan, private chat or credential read is performed.
  - The full-clean status is `eligible_for_broader_evaluation`, not promotion. Public fixtures
    cannot authorize a production routing change, and the tooling takes no automatic provider or
    routing action.
  - `candidate-spec.md` and `fixtures.json` were preserved from the interrupted prior run; the
    spec is unchanged and the fixture suite was extended only with cases for precedence branches
    that had no representative.
- Not yet done (deferred, owned by the orchestrator): run the two smoke attempts through Crewboard,
  collect the actual current bill records, fill the manifest and compute coverage. No paired result
  exists, so every verdict here is `inconclusive` by construction.
