# Multi-plan navigation foundation: data, snapshot and API contract

**Result:** the foundation layer for browsing and acting on a plan that is not the CLI/agent `current` one. It
adds the global «Now» progress projection, a read-only on-demand plan snapshot, explicit plan scoping on every
task-scoped HTTP route, and the matching client API. The next task owns the frontend (Global Now screen, stable
project switcher, tree, context restore); this note is the contract it builds on.

## Why

Browsing another plan used to change the shared CLI `current` plan: the screen's `plan-use` calls `openPlan`,
which for an active plan writes `.orchestration/current`. Every task read and mutation then fell back to that
pointer. The foundation removes the pointer from the browsing path: a request carries its own plan scope, and a
read of a non-current plan never writes.

## Global «Now» progress projection

Core (`packages/core/src/orchestration/snapshot.ts`) derives, in the same pass that already counts a plan:

- `PlanSummary.progress: { coverage: 'known' | 'unknown'; items: PlanProgressRef[] }` (optional on the type so
  older hosts and fixtures still typecheck; the host always fills it).
- `PlanProgressRef = { root; planId; taskId; title; kind; stage; worker?; decision?; humanReview?; since?; ageMin?; alerts? }`.

Stages are **factual**, never a claim about who must act:

| stage | meaning |
| --- | --- |
| `worker` | a worker run is active |
| `awaiting_check` | finished work the orchestrator has not taken (`check: pending`) |
| `checking` | the orchestrator is checking it (`check: checking`) |
| `checked` | the check is done; what follows (a person's review or an automatic close) is the accept policy's decision |
| `orchestrator` | the orchestrator's own root work, or a decision being prepared |
| `review` | finished work whose check is off/absent, or an open/prepared decision — the next step is not decided here |
| `unmerged` | accepted work not in the base branch |
| `alert` | no other current-work stage, but a run alarm exists |

Rules the next worker must keep:

- **One row per task.** Alarms ride `alerts` on the task's single row; `alert` is only used when there is no
  other stage. Do not derive a human requirement from stage names — `checked`/`review` do not mean "the person
  must confirm". Contract-declared `human_review` is read at the task-detail level (`contract.humanReviewRequired`)
  and, for the tasks the projection shows, as `humanReview` below.
- **Explicit `<human_review>`, never guessed.** `humanReview` is the contract's own `<human_review>` block read
  with the canonical `contractBlock` parser: `true` — required; `false` — the contract was read and does not
  require it; absent — the contract was missing/unreadable and the classification is **unknown** (the frontend
  must keep it neutral, not treat it as `false`). The contract is chosen exactly as the acceptance/auto-close
  gates choose it — `run.contractPath ?? task.contract` (`auto-close.ts`), so a newer `task.contract` cannot hide
  a requirement the checked run's contract declared. It is never inferred from `stage`, `in_review` or `check`,
  and no model call or `getTaskDetail` is made: only the small contract file is read, for the shown tasks, and an
  unchanged file is not re-read (bounded per-path/mtime cache). This is what lets «Now» keep a real human review
  apart from work the accept/auto-close policy may finish on its own.
- **Examples and archived plans contribute no items.** A plan that failed to read is `coverage: 'unknown'`,
  never an empty list. A plan on disk that `listPlans` could not load at all is still reported as `unknown` by id.
- No new scans, no transcripts, no model calls: the projection reuses the views/attention the counting pass
  already computed.

The host (`OrchestraService.snapshot()`) flattens the served plans into `OrchestraSnapshot.now`:

```ts
type OrchestraNow = {
  coverage: 'known' | 'unknown' | 'partial'   // partial = some repository is still on its first paint
  items: PlanProgressRef[]                    // repo order, then plan order — stable across polls
  unknown: Array<{ root: string; planId: string }>
}
```

The screen renders `now.items`; it never scans roots itself.

## Explicit, read-only plan snapshot

`GET /crewboard/api/plan-state?repo=<root>&plan=<planId>` → `{ ok, value: OrchestraRepoSnapshot }`.

- Built by the existing `buildRepoSnapshot(root, backends, now, planId, { readOnly: true, skipSummaries: true })`:
  full verdicts/conflicts/default-base, but **no plan write, no `current` pointer change, no run bookkeeping or
  merge reconciliation**. `skipSummaries` means the all-plan sync pass is not repeated — the host reuses the
  summaries the SSE traversal already derived (no N+1).
- One documented exception: reading a *corrupt* plan still writes the reader's recovery quarantine copy
  (`.corrupt-*`) — a recovery artifact of a damaged file, not a change to a healthy plan.
- The service coalesces concurrent reads and caches by `(root, plan)` within a bounded TTL **and** the
  repository **generation** (bumped on every refresh/watcher event). A plan revision alone does not move for
  runtime-only changes (evidence, receipts, run logs, files, Git), so the generation is the authoritative token.
  `OrchestraRepoSnapshot.generation` exposes it to the client.
- `plan` omitted = the served current plan (legacy). A present but empty/whitespace/unknown plan fails closed:
  `400 bad_plan`, never a fallback to `current`.

## Explicit plan scoping on task routes

POST body `plan` (or the legacy `planId`) and GET query `plan` select the plan for these routes; omitted keeps
the current-plan behavior:

- reads: `task`, `task-review`, `trace`, `diff`, `file`, `run-steps`, `cost`, `worktree-open`
- mutations: `run`, `run-checks`, `relaunch`, `continue`, `steer`, `stop`, `accept`, `accept-batch`, `merge`,
  `mark-merged`, `reject`, `drop`, `pos`, `task-upsert`, `task-add`, `task-status`

The scope is resolved once per request (`planOf`): present-but-empty/malformed → `400 bad_plan`; a valid id not
in the repository → `404 bad_plan`; `plan` and `planId` naming different plans → `400 bad_plan`. Nothing changes
`current` or the process plan view. The example/read-only guard and the native confirmation for
accept/merge/mark-merged/reject/drop are unchanged, so no approval or accept-policy bypass is introduced.

The routes not listed (`example-file`, `worktrees`, workers/settings, `plan-*` management) have no task plan
dimension. `plan-use` still moves the pointer on purpose; `openPlan`/`setPlanView` are unchanged.

## Client API (`packages/plugin/src/client/api.ts`)

- Every scoped `api.*` takes a trailing optional `plan`; it becomes `plan=` on GETs and `plan` on POSTs.
- `api.planState(repo, plan?)` reads the endpoint above.
- `shared.task`/`shared.taskReload` are keyed by plan **and** repo **and** task id, so the same task id in two
  plans is two resources. `taskVersion(repo, taskId, planId?)` carries the plan coordinate.
- `shared.planState(repo, plan, version)` is bounded by `SHARED_MAX_AGE_MS` **even when a version is given** —
  a plan revision can stay put while a receipt or runtime state changes. Pass
  `${repo.generation ?? repo.rev}:${plan.rev}` for the tightest cache, but never rely on the version alone.
- Writes still call `forgetRepo(repo)`, dropping that repository's reads (including plan-state).

## Tests

- `packages/core/test/navigation-progress.test.ts`: stage classification, one row per task with alarms,
  coverage `unknown` for an unreadable plan, read-only snapshot leaves the plan file, `.prev` backups, run
  bookkeeping and the `current` pointer untouched, `skipSummaries`, and the explicit `<human_review>`
  classification (`true`/`false`/unknown for an unread contract) with no inference from `in_review`.
- `packages/plugin/test/navigation-scoping.test.ts`: P1/P2 with the same task id — a read and a mutation of P2
  leave P1 and `current` unchanged; invalid/empty/conflicting plan fails; `plan-state` route; the `now`
  projection marks an unreadable plan unknown; the generation invalidates a cached plan-state without a rev move.
- `packages/plugin/test/client/navigation-scope.test.ts`: client plan params, per-plan shared cache keys, and
  the bounded plan-state TTL at a matching version.

## Measured host bundle cost

The preceding local build was 707,161 bytes; this foundation build is 716,536 bytes
(+9,375 bytes, 1.3%). The host ceiling was intentionally rebaselined from 691 to
735 KiB, retaining about 5% headroom around the measured 699.7 KiB. No dependency
was added and the runner/client ceilings remain unchanged. Global rows carry
references and state only; rich Activity remains an on-demand read.
