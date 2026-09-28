# Recovery check facts — an orchestrator report must be the current claim, not the old worker NOT RUN

Task: `orch/recovery-checks-28` (core current-verdict check-claim selection).
Date: 2026-09-28. Owner of this note: the core orchestration worker (plugin/client files, `scripts/release-check`
and `docs/releasing.md` belong to other workers).

## Result

Received. `verdictOf` now reads the current check claim of a recognized handoff from the orchestrator's report
instead of the preserved worker's claim. The observed failure — `release-size-28`, run
`run_dsh-mulc9etviuv3` — ended incomplete/`no_claim`; root took the preserved copy
(`verify --takeover`), committed `22258716d9ef622ca2a622a7ee27e44afa1f3ade`, ran the canonical checks 3/3 PASS
and finished with a positive `verify --done --report`. The task still showed `checks_not_run` 1 WARN from the
old worker answer, so `accept --auto` refused a recovery that every current fact supported.

## Facts

- The worker's evidence and its read-time projection are immutable history. In `release-size-28` the worker
  wrote `pnpm release:check` — **NOT RUN** (the sandbox blocked the machine-wide slot queue) and the other two
  commands PASS.
- Once the orchestrator takes, commits, checks and reports on that copy, the task has a *recognized handoff*:
  the last run is `incomplete`, the check is `checked` with a report and a commit, and the report's source is
  `orchestrator`.
- `verdictOf` already took the handoff's *verdict claim* from that report (`claimOf(report)`), but it still
  built its `checks_run` / `checks_not_run` facts from `workerClaimProjection` / `evidence.checks`. So the
  historical worker NOT RUN was presented as the current root's NOT RUN and its `warn` tone blocked the
  automatic verdict gate.
- The receipts Crewboard ran itself (`checks.json`: run, worktree, commit, contract path and revision, every
  mandatory command passing) were never the problem. They matched the current HEAD and contract.

## Change (minimal)

`packages/core/src/orchestration/verdict.ts`, inside `verdictOf`:

- the current check-claim commands are the current contract's `<checks>` when a contract is on the detail,
  else the commands the evidence/projection already carries (the `verdictFromEvidence` path);
- **only** when `handoff` is recognized are those commands read against the orchestrator report with
  `checkState(report, command, commands)`;
- every other task keeps the previous order (`workerClaimProjection`, then `evidence.checks`, then the
  report), so an ordinary completed run is untouched.

No other source file changed. No evidence file, plan JSON, CLI, plugin or routing code changed.

## What the narrow fix deliberately does not do

- It does not remove or rewrite the historical worker NOT RUN: `evidence.checks` and `workerClaimProjection`
  still carry it, and `V-rc1/recovery` asserts both after acceptance and after the merge.
- It does not infer success from a green typecheck line or from the note. `checkState` scopes each command
  to its own identity, so a report that only names one command leaves the others `unreported` (flat).
- It does not let a report override a failing receipt. `automaticAcceptance` and `assertAutomaticMerge` still
  gate on `currentGateReceipts`: current run, worktree, commit, contract path and revision, and every
  mandatory command passing. Missing, failing or stale receipts are refused; a changed HEAD or contract after
  acceptance is refused; `<human_review>` is never auto-accepted and never auto-merged.
- It does not infer a positive result from a historical report without the explicit current attestation the
  other paths require: the handoff still needs the checked orchestrator report and commit.

## Controls covered by `packages/core/test/recovery-checks.test.ts`

- `V-rc1/recovery`: incomplete `no_claim` worker NOT RUN → takeover → commit → fresh receipts → root positive
  report → `automaticAcceptance` then `assertAutomaticMerge` and `mergeTask` allowed, while the original
  worker NOT RUN stays on the evidence and projection (also through `verdictFromEvidence`).
- `V-rc1/root-not-run`: a current root NOT RUN still warns, even though the historical worker passed.
- `V-rc1/no-root-report`: without the orchestrator report the worker NOT RUN stays current and blocks.
- `V-rc1/receipts-none|fail|stale`: a clean handoff with missing, failing or stale receipts is still refused.
- `V-rc1/changed-head`, `V-rc1/changed-contract`: automatic merge refuses a HEAD or contract changed after
  acceptance.
- `V-rc1/human-review`: a `human_review` contract is refused by both gates.
- `V-rc1/ordinary`: a completed run with a worker NOT RUN keeps warning (no handoff).

The suite exercises the real orchestration API (`getTaskDetail`, `automaticAcceptance`,
`assertAutomaticMerge`, `acceptTask`, `mergeTask`), not a mirrored helper.

## Verification and environment limits (2026-09-28)

- `pnpm --filter @crewboard/core typecheck` — **PASS**.
- `node scripts/check-docs.mjs --strict` — **PASS** (47 files before this note; 48 with it).
- `git diff --check` — **PASS**.
- `pnpm --filter @crewboard/core test` — **BLOCKED for the canonical path in this sandbox**: `crewboard slot`
  cannot write the real machine-wide queue (`No permission to write
  /Users/kjaly/.config/crewboard/slots/slot-….lock`), and the core vitest harness calls `ps` in its
  per-test reaper, which the sandbox denies (`spawnSync ps EPERM`). Running the relevant files directly, all
  198 test bodies complete without an assertion error; every reported failure is that one `ps EPERM`
  afterEach. No temp slot dir, lock deletion, alternative config or scope reduction was used. Root's
  `--run-checks` owns the real queue and is the authoritative run.
- The regression was confirmed to fail before the fix: with the old state selection, `V-rc1/recovery` and
  `V-rc1/receipts-none` fail on the current `checks_not_run`, and `V-rc1/root-not-run` cannot see the root's
  NOT RUN because the historical worker passed.
