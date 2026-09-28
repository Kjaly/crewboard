# rv4 — Independent review of the rebuilt Review view

**Verdict: needs fixes. Critical: none established. Important: I1–I10 below.**

Reviewed commit `1f57158` (the supplied rv4 worktree), against `docs/notes/2026-09-23-review-view-audit.md` and the owner's decisions. No product source, tests, configuration, or real plan was edited. Builds produced ignored output; review scripts, snapshots and this report are in `/tmp`. `git status --short` and `git diff --stat` remained empty.

## Evidence and limits

- **Source** means inspected implementation, with current-worktree line references.
- **Reproduced** means local read-only host GET handlers invoked directly with a copied plan and the real read-only backend readers, raw-file arithmetic, or server-rendered component output. These are not stand observations. No host service, reconciliation, GC, launch, acceptance or other mutating action was invoked against the real plan.
- **Automated** means the repository tests run in this review: **235 core + 30 CLI + 391 plugin = 656 tests passed**, across 136 files. `pnpm build`, `pnpm typecheck`, and the i18n/boundary guards in `pnpm test` passed. The bundle test passed at its current 560 KiB ceiling.
- **Stand: blocked.** The in-app browser was unavailable. The available Chrome browser then rejected opening `http://127.0.0.1:4640/?lang=en`: “The user declined permission … must not attempt … workaround.” No alternate route around that denial was used. Thus **EN 1440, RU 1440, EN 1100, RU 1100 are all unverified**, including screenshots, measured overflow, contrast, row height, actual keyboard focus, panel open/closed, run expansion and task comparison. A listening stand was detected, but its content/build could not be inspected.
- Plan snapshot: **rev 651**, `updatedAt=2026-09-23T17:24:49.787Z`, **140 tasks / 127 runs**, SHA-256 `75020e2f07aa91b0bd54184735cb55e823466029acc04b30626d8fc7d50db900`. Frozen at `/tmp/rv4-plan.json`. Deterministic arithmetic uses **2026-09-23T17:30:00Z** as the analytical snapshot time. This is not the audit's earlier 113-run / 105-task example. Active records can change after the copied observation.

Path conventions: `review.tsx`, `review-index.ts`, and `review-detail.tsx` are under `packages/plugin/src/client/views/`; other shortened client filenames refer to that same plugin. Raw `.orchestration` paths refer to `/Users/kjaly/WebstormProjects/dsh-orchestra/.orchestration`, not the rv4 worktree.

Reproduction artifacts: `/tmp/rv4-probe.ts`, `/tmp/rv4-probe-results.txt`, `/tmp/rv4-cost.json`, `/tmp/rv4-ui-probe.tsx`, `/tmp/rv4-ui-results.txt`, `/tmp/rv4-tests.log`, `/tmp/rv4-typecheck.log`, `/tmp/rv4-build.log`. Component checks used source rendering, not a browser or the denied stand.

## Ranked findings and concrete fixes

### Important I1 — A completed historical run adds 21 h 43 min of fictitious worker time

**Reproduced.** `k6`'s first run, `run_codex-mud30lva3hvw`, lacks `finishedAt` in the plan (frozen plan:1468 (`/tmp/rv4-plan.json:1468`)), but its raw `state.json:2` says `completed`, with `finishedAt=2026-09-22T19:46:53.183Z`. From the plan start, its duration is **205.513 s**. Review instead uses snapshot minus start: **78,392.330 s**, treating it as still running. That adds **78,186.817 s = 21 h 43 min 6.817 s**. Correcting this one record changes aggregate worker time from **43 h 35 min 19.329 s** to **21 h 52 min 12.512 s**; this is not a claim that every remaining historical record is reconciled.

`runCost` trusts the plan's terminal fields ([packages/core/src/cost/cost.ts:51](../../packages/core/src/cost/cost.ts)); the host never consults raw terminal state for this calculation ([packages/plugin/src/host/actions.ts:500](../../packages/plugin/src/host/actions.ts)); reconciliation only checks each task's **latest** run ([packages/core/src/orchestration/sync.ts:11](../../packages/core/src/orchestration/sync.ts)). The defect also keeps five-second “active” summary reads alive forever.

**Fix:** resolve terminal state for every unfinished run ID, including earlier attempts; use the recorded backend finish time and outcome with provenance. Do not infer endless activity from a missing historical plan field. Add a fixture with a completed earlier attempt and a completed later attempt.

### Important I2 — Unobserved CLI usage becomes known zero; recorded cache-write tokens disappear

**Reproduced on rv4 itself.** Raw state has `calls=0` and zero-initialized tokens, with no completed usage observation. The host returns `tokens={0,0,0,0}`, no pending flag, and `availability.input/output/cacheRead/reasoning='known'`. The UI therefore reports measured zeros. `runCliRun` initializes these counters ([packages/core/src/runs/cli-runner.ts:221](../../packages/core/src/runs/cli-runner.ts)), `createCliBackend.usage` drops observation/pending metadata ([packages/core/src/runs/cli-backend.ts:80](../../packages/core/src/runs/cli-backend.ts)), and `runCost` defaults supplied usage to known ([packages/core/src/cost/cost.ts:69](../../packages/core/src/cost/cost.ts)). The pending-header test injects an already-correct pending fixture; it never exercises this producer chain.

For `run_claude-mucx8iye1zdy`, raw state records **182,687 cache-write tokens**. The CLI adapter omits that field, the `Tokens` type omits it, and the run header always renders an availability label for cache write ([packages/core/src/cost/cost.ts:6](../../packages/core/src/cost/cost.ts); [packages/plugin/src/client/views/review-detail.tsx:96](../../packages/plugin/src/client/views/review-detail.tsx)). Even a passed-through known cache-write state would currently become “Unavailable.” Observation timestamps, source/finality and reasoning-in-output semantics also do not reach the response.

**Fix:** carry per-metric observation state end to end; distinguish initialization from an observed zero, retain cacheWrite counts and timestamps, and render known counts. Add adapter→host→header tests using real-format initial and measured CLI states.

### Important I3 — “Accepted with result” and the ledger's outcome are not trustworthy

**Reproduced/source.** The actual component output says **125 / 139 accepted with result**. Its 125 consists of **14 explicitly `result`, 22 `disputed`, and 89 legacy acceptances without a typed verdict**. The snapshot correctly separates three negative closures, but the Review numerator counts every other accepted task ([packages/plugin/src/client/views/review.tsx:343](../../packages/plugin/src/client/views/review.tsx)). E likewise counts every attributable `accept` as a success ([packages/plugin/src/client/views/review.tsx:399](../../packages/plugin/src/client/views/review.tsx)). Both rv3 and rvc are explicitly disputed, yet improve the worker success numerator.

The index separates execution and decision, but the reused ledger reverses that improvement: `GET trace` calls any run with a later attempt `returned` ([packages/plugin/src/host/actions.ts:580](../../packages/plugin/src/host/actions.ts)); `LedgerView` prefers that combined review outcome over execution ([packages/plugin/src/client/panel/trace-ledger.tsx:79](../../packages/plugin/src/client/panel/trace-ledger.tsx)). Thus f3's cancelled Claude attempt can be “Cancelled / No recorded decision” above and “Returned” inside the ledger. Run header/task comparison also use only the **first** matching review interval, while the index unions all matching intervals ([packages/plugin/src/client/views/review-detail.tsx:83](../../packages/plugin/src/client/views/review-detail.tsx); [packages/plugin/src/client/views/review-index.ts:52](../../packages/plugin/src/client/views/review-index.ts)).

**Fix:** propagate typed verdicts and decision association IDs into the shared summary; distinguish result, negative, disputed and legacy-unknown counts and coverage. Keep execution/decision/trigger separate in the ledger too. Union all run-associated intervals everywhere; never use existence of another attempt as evidence of rejection.

### Important I4 — Quota totals disagree between overview, task history and ledger

**Reproduced.** rv3 records **52→53 = +1 pp**, and rvc **54→55 = +1 pp**. Both reach `cost.totals`; D shows their deltas. F1 instead labels their unknown-attribution legacy samples “Shared window; run attribution unavailable”; F2's cumulative quota shows **0 pp**. `quotaWindows` only adds exclusive samples ([packages/plugin/src/client/views/review-detail.tsx:22](../../packages/plugin/src/client/views/review-detail.tsx)). This directly misses the owner's merge decision to retain legacy unknown-attribution samples and exclude only samples known to be shared.

Conversely, A–E's `windows()` adds **shared** samples to worker/task contribution totals and merely sets a warning ([packages/plugin/src/client/views/review.tsx:92](../../packages/plugin/src/client/views/review.tsx)); per-row accounting subtracts reset samples without checking `reset` ([packages/plugin/src/client/views/review.tsx:500](../../packages/plugin/src/client/views/review.tsx)). ID deduplication exists, but overlapping observations with different IDs are summed, and collectors still write only legacy before/after values ([packages/core/src/orchestration/sync.ts:58](../../packages/core/src/orchestration/sync.ts)). The ledger still prints `%`, not pp ([packages/plugin/src/client/panel/trace-ledger.tsx:77](../../packages/plugin/src/client/panel/trace-ledger.tsx)).

**Fix:** one shared accounting projection for all surfaces. Retain unknown legacy deltas with an uncertainty label; exclude known shared samples from attributable totals, while showing account-window observations separately. Preserve reset boundaries, stable sample/account/window identity and precision; do not subtract a reset as spending. Use pp / п. п. throughout.

### Important I5 — Missing money turns into USD 0, while the ledger reintroduces unlabeled subscription dollars

**Reproduced.** rv3/rvc have no dollar estimate, but `GET cost` initializes their task `apiEquivalentUsd` to zero and F2 displays **USD 0**. f3 has subscription equivalents and an unavailable Devin run; the task header displays **“Partial data · USD 0” API cash** because coverage counts `run.usd`, which includes subscription estimates. See [packages/plugin/src/host/actions.ts:529](../../packages/plugin/src/host/actions.ts) and [packages/plugin/src/client/views/review-detail.tsx:122](../../packages/plugin/src/client/views/review-detail.tsx).

The top B block correctly separates **cash USD 0.868** from **equivalent ≈ USD 71.567**, but the reused ledger's money cell still reads overloaded `cost.usd` ([packages/plugin/src/client/panel/trace-ledger.tsx:77](../../packages/plugin/src/client/panel/trace-ledger.tsx)). f3's **USD 2.468604 equivalent** therefore appears as a generic money figure there. The run inspector's standalone “Estimate, not charged” paragraph is not a substitute for labeling each figure consistently. Coverage is not per metric; totals are generally not labeled “at least”; unavailable and not-applicable often collapse to `—`. Price source/model exist only partly; rate date/version and source record provenance are missing.

**Fix:** aggregate optional monetary values with per-measure eligible/known/pending counts; leave absent values absent. Use billing-aware `notApplicable`, including promotional status. Consume separated fields everywhere, including LedgerView, with the muted estimate label attached to the estimate. Carry historical rate/source metadata rather than generic `rate_estimate`/`legacy_cost_record` labels alone.

### Important I6 — Several index/comparison controls do not perform the displayed operation

**Reproduced/source.** A one-minute duration filter removes **all three active rows**, even though their snapshot durations are 78,392 s, 339 s and 310 s. The filter calls `runDurationMs(run, run.finishedAt ?? run.startedAt)`, so every unfinished run has duration zero ([packages/plugin/src/client/views/review-index.ts:109](../../packages/plugin/src/client/views/review-index.ts)).

Tasks mode exposes Sort and direction controls, but `taskRows` always sorts by latest **run start** and ignores `state.sort/descending`; “View waiting tasks” likewise cannot sort by active wait ([packages/plugin/src/client/views/review.tsx:224](../../packages/plugin/src/client/views/review.tsx), `:255`, `:802`). “Last activity” excludes finishes/decisions. E's Unclassified option uses `__unknown`, but worker filtering compares it literally to the empty class, yielding no rows ([packages/plugin/src/client/views/review.tsx:383](../../packages/plugin/src/client/views/review.tsx)). E distinguishes worker/model/billing in its grouping key but omits billing in the label and only passes canonical worker/class to “Inspect contributions,” thereby broadening that contribution set ([packages/plugin/src/client/views/review.tsx:385](../../packages/plugin/src/client/views/review.tsx), `:1159`). The actual plan yields multiple indistinguishable Codex rows across missing/present billing metadata.

**Fix:** pass the same snapshot time into duration filtering; implement task-specific sorts and active-wait ordering, with last activity derived from all relevant events. Normalize unknown facets consistently and pass the complete worker identity to contribution filters. Label unknown billing/model explicitly instead of silently presenting duplicate identities. Add functional tests for each control in each mode.

### Important I7 — Live detail mixes stale headers with refreshed ledgers and can steal focus

**Source.** Opening a run stores the current `run` and task `summary` object in the navigation stack ([packages/plugin/src/client/app.tsx:402](../../packages/plugin/src/client/app.tsx)). `ReviewDrilldown` always prefers that object ([packages/plugin/src/client/views/review-detail.tsx:135](../../packages/plugin/src/client/views/review-detail.tsx)). Only trace polling updates; its new `trace.cost` does not update the metric header or UsageOverTime total. Task history fetches once (`:75`). A finished transition never updates the original run's flag, so detail can continue polling and label the run running. Ledger polling also stops scheduling after an error, and completed-but-pending usage is not independently refreshed.

Every new cost snapshot refocuses the previously opened run button ([packages/plugin/src/client/views/review.tsx:297](../../packages/plugin/src/client/views/review.tsx)). A user can be typing in a filter when the five-second refresh pulls focus away. Lists reorder immediately; the specified “N updates available” hold is absent. Same-plan stale data is retained only when **rev is unchanged**: rev is part of the identity key, so a new revision clears it ([packages/plugin/src/client/insight.ts:323](../../packages/plugin/src/client/insight.ts)).

**Fix:** store IDs in navigation state, select current data by ID, and poll metric/detail sources until terminal usage settles. Use a local clock anchored to server snapshot time. Restore focus only on a navigation return, preserve the reading anchor during updates, and keep stale data keyed by repo/plan rather than revision.

### Important I8 — Summary loading still reads all event histories and sends unused overviews

**Reproduced.** On 127 real runs, one `GET cost` performs **127 event reads**, builds **9,034 overview marks**, and serializes roughly **989 KB UTF-8**; approximately **777 KB** is unused overview content. First direct-handler read was **3.84 s**, second **0.91 s**; event reads rose from 127 to 254, proving no completed-summary cache. These are local host timings, not browser/network latency. At 500 runs, the specified lightweight cached read has not been delivered.

[packages/plugin/src/host/actions.ts:500](../../packages/plugin/src/host/actions.ts) still awaits event and usage reads sequentially and builds every trajectory at `:513`. The rva journal's lightweight-read claim does not describe this merged implementation. D no longer renders those overview arrays. Active polling repeats the whole operation every five seconds.

**Fix:** remove overview/event construction from GET cost; cache completed summaries by usage/source fingerprint, refresh only active/pending summaries, and lazily load detail. Benchmark 500 real-shaped summaries and full browser interaction separately. The pure helper benchmark passes comfortably but does not validate this host path.

### Important I9 — Detail navigation is not durable, and task/step origin restoration is incomplete

**Source/automated.** Run→task→Back works in the existing navigation test. In-session run-origin scroll/focus restoration has also been added beyond what the journals report. However detail pushes history entries with the **same URL**, stores full objects only in React state, and every `popstate` simply pops a frame ([packages/plugin/src/client/app.tsx:123](../../packages/plugin/src/client/app.tsx), `:255`). Reload cannot restore the detail stack, browser Forward cannot rebuild it, and selected ledger step/scroll is local to a remounted ledger. Task-origin focus is not marked/restored; only `[data-review-run][data-review-origin]` is handled (`:130`, `:402`). D uses buttons, not durable links.

Legacy attempts also get a hard-coded “Attempt 1” subtitle even when the header facts know the true index ([packages/plugin/src/client/views/review-detail.tsx:93](../../packages/plugin/src/client/views/review-detail.tsx), `:103`). From task history, `task-review` does not supply fallback attemptIndex, so the wrong subtitle persists.

**Fix:** put repo/plan/task/run and durable query state in the existing route model, persist step and list anchors separately, handle Back/Forward symmetrically, and restore the exact originating task/run control. Derive attempt numbering once from the complete stable task sequence. Use actual links for destinations.

### Important I10 — The ledger contract and keyboard investigation path remain unfinished

**Source/automated.** Reusing v5 is correct, and full record search/inspection exists. It does not provide the specified 100-step paging, stable seek IDs, retained bounds, selected-interval feedback, approximation markers, shared M/T/E/C/!/R/H legend, Jump to latest, or bounded output with Load more. The host silently slices spans ([packages/plugin/src/host/actions.ts:581](../../packages/plugin/src/host/actions.ts)), while sending all ledger records. The ledger virtualizes visual rows but mounts a button for every overview record ([packages/plugin/src/client/panel/trace-ledger.tsx:85](../../packages/plugin/src/client/panel/trace-ledger.tsx)); long runs create hundreds of tab stops. Selecting a mark changes state/scroll but does not focus the target row. Drag-range and wheel zoom have no equivalent semantic keyboard controls. Raw output is rendered directly in `<pre>`.

The long-run test verifies virtual rendering, search and inspection; it is not a keyboard reachability/paging test. Usage rows also lack an event contract that distinguishes delta/cumulative reports and parent/leaf attribution; the task chart always says no step-level usage, without fetching a task usage stream ([packages/plugin/src/client/views/review-detail.tsx:127](../../packages/plugin/src/client/views/review-detail.tsx)). This is safe for genuinely final-only history, but not the specified capability when event data exists.

**Fix:** finish the shared v5/host contract: stable IDs, explicit completeness/cursors, seek/focus, bounded detail loading, labeled legend and keyboard timeline controls. Keep overview navigation out of the primary Tab sequence; provide a single accessible summary and direct ledger navigation. Introduce source-identified usage events and reconcile only additive leaf measures.

### Minor findings

- **M1 — Translation is incomplete despite a passing guard.** Source-rendered RU controls contain `completed`, `accept`, `known`, `task`; F2 says `accepted`/`ready`, detail dates/numbers use browser locale instead of selected language, and detail quota hard-codes `pp`. Evidence: [packages/plugin/src/client/views/review.tsx:722](../../packages/plugin/src/client/views/review.tsx), `:752`, `:798`; [packages/plugin/src/client/views/review-detail.tsx:13](../../packages/plugin/src/client/views/review-detail.tsx), `:22`, `:122`. **Fix:** map protocol values to dictionary labels and use `getLang()` consistently; test selected-language output, not just dictionary-key parity. Date filters compare UTC calendar slices while shown dates are local (`review-index.ts:110`); explicitly use the displayed timezone.
- **M2 — Still too much low-value detail before evidence.** B's “sources/rates/measurements” disclosures are raw lists rather than navigable evidence, repeated `unknown` windows dominate run/detail text, every D row repeats timezone/full run ID, and all eleven filters remain exposed. F's twenty-plus fact cells precede the primary ledger. “Progress history → History unavailable” remains an inert disclosure even though history was deferred. **Fix:** compact secondary IDs/timezone/provenance into disclosures, attach source links, use More filters, group the mandatory header facts, and remove the deferred-history affordance until useful. Do not remove mandatory missing-metric labels.
- **M3 — Numeric/layout rules are only partly consistent.** A/B use container widths and the intended 23 px values; D's numeric cells and E's totals are right aligned. Task-mode duration/wait cells lack `orc-num`; F tables explicitly left-align all cells. The under-960px grid rule applies to E and Tasks tables too, although their columns have different meanings ([packages/plugin/src/client/styles.ts:120](../../packages/plugin/src/client/styles.ts), `:132`, `:149`; `review.tsx:1056`). **Fix:** table-specific responsive templates, labels for cells whose headers become visually hidden, consistent numeric alignment. Actual overflow/contrast must be checked on the stand; none is claimed here.
- **M4 — Eager bundle growth affects every tab.** Current client: **526,274 bytes**, gzip **135,970**. Rebuilt audit baseline `ec4f8aa`: **381,741 bytes**, gzip **98,870**. Growth **37.9% raw / 37.5% gzip**. This includes intervening non-Review work, so it is not attributed wholly to the three tasks. Journals separately report rv3 472,695 and rvc 510,177 bytes, with raised ceilings. Current build guard allows 560 KiB ([packages/plugin/test/build.test.ts:35](../../packages/plugin/test/build.test.ts)). **Fix:** lazy-load Review/detail and language assets; track size deltas against an explicit budget rather than treating a raised threshold as a performance pass. The source already mentions a separate `bb` task; it is not part of this verdict.

## Five-run independent recomputation

Token order below is **input / output / cache read / cache write / reasoning**. Duration is UTC finish−plan start, active duration is analytical snapshot−start. Human wait is a union only of explicitly associated run intervals; legacy task-only waits are not assigned to a run. Rounded whole-second durations are acceptable presentation rounding.

| Run and raw evidence | Recomputed values | Host/UI comparison |
|---|---|---|
| f3 · `run_claude-mucx8iye1zdy`; frozen plan:824 (`/tmp/rv4-plan.json:824`); raw `.orchestration/runs/run_claude-mucx8iye1zdy/state.json:1` | **109.146 s**; **22 / 6,453 / 960,598 / 182,687 / 0**; quota unavailable; raw reported dollar figure **2.468604**, treated as subscription equivalent, cash not applicable; run wait unavailable | Host duration **109 s**, other carried token values and equivalent match. **182,687 cache-write tokens lost.** Execution cancelled is correct. f3's later task-only wait is 24.884 s; it must not be assigned to this cancelled attempt. |
| rv3 · `run_codex-muea2a3w2dqs`; frozen plan:4536 (`/tmp/rv4-plan.json:4536`); raw state `:1` | **1,147.311 s**; **171,531 / 45,743 / 8,801,280 / 0 / 6,106**; **+1 pp**; no recorded cash/estimate; exact wait **101.238 s** | Host **1,147 s**, token values and **101,238 ms** match. F2 incorrectly displays quota **0 pp** and estimate **USD 0**. Acceptance is explicitly disputed. |
| rvc · `run_codex-mueb0ax7kcne`; frozen plan:4737 (`/tmp/rv4-plan.json:4737`); raw state `:1` | **1,455.999 s**; **158,128 / 38,760 / 10,301,056 / 0 / 7,539**; **+1 pp**; no recorded cash/estimate; exact wait **2,612.186 s** | Host **1,456 s**, carried tokens and **2,612,186 ms** match. Same quota/zero-estimate error. Acceptance explicitly disputed. |
| rv4 · `run_codex-muedhkdj6hvs`; frozen plan:4590 (`/tmp/rv4-plan.json:4590`); copied raw state `:1` | At 17:30Z, **338.777 s** active; token fields are initial zeros with **0 observations**, therefore pending, not measured zero; quota before 56 with no after, delta unavailable; money unavailable/not applicable; no review interval | Host worker duration matches. It incorrectly reports **known zero tokens** and fails a ≥1-minute duration filter. Task detail calls the state `ready` from persisted task state while run execution says running. |
| rel4 · `run_dsh-mue3fpp10ed4`; frozen plan:3695 (`/tmp/rv4-plan.json:3695`); raw state `:1` and events | **458.468 s**; **125,977 / 67,145 / 6,124,416 / unavailable / 52,789**; cash **USD 0.077556812**, rounded by backend to **0.077557**, displayed **USD 0.078**; quota/estimate unavailable; no exact run interval | Host duration **458 s**, cash and tokens match. The state contains a session ID rather than billing amounts: independently summed **52 matching records** in `~/.dsh/dsh-bill/records.jsonl`. The 52 raw `usage` events are context observations, not a substitute for bills. Task-only finish→accept wait **34.323 s** is correctly withheld from the run. |

Raw state copies for the five samples are under `/tmp/rv4-evidence/`. The DSH bill sum is recorded in this report rather than copying unrelated billing history. Cache-write zero for Codex is a raw stored counter, not proof that the backend measured that dimension; the missing observation contract prevents that stronger claim.

Additional consistency checks:

- Top-level cash recomputes to **USD 0.867869**, display **USD 0.868**, across 22 records. Subscription equivalents recompute separately to **USD 71.567115**, display **≈ USD 71.567**, across nine Claude runs. They are not added together. These are recorded usage/benchmark figures, not an invoice reconciliation.
- Legacy quota deltas total **33 pp** in the supplied records (23 GPT-6 Sol, 5 Luna, 5 Astra; the GPT-5.6 Sol group contributes zero). This is the owner's requested legacy arithmetic, not proof of exclusive spend in a known shared account window.
- Plan elapsed **100,624.362 s = 27 h 57 min 4.362 s** is correctly first start→snapshot for an unfinished plan. Worker total is arithmetically consistent with the response but substantively wrong due to I1.
- Review wait union **67,500.352 s = 18 h 45 min 0.352 s** matches the 113 supplied/inferred task intervals. Only **five interval records** exist explicitly in the raw plan; the rest are legacy task-only approximations. The generic completeness note under C does not adequately qualify this headline as incomplete historical evidence.
- `claude-opus` and `claude/opus` merge into **one canonical group, nine runs**. Raw aliases are retained. Generic historical `codex` is nevertheless remapped to today's `codex/gpt-6-astra` ([packages/core/src/routing/identity.ts:3](../../packages/core/src/routing/identity.ts)), contrary to the spec's prohibition on reinterpreting historical generic aliases. Preserve unresolved historical identity unless a recorded model proves it.
- No-run component output gives **0/0, Not started, No runs yet**, with no fake run time. It unnecessarily adds “End inferred from terminal tasks” for an empty array and “Decision history incomplete.” Empty task detail can still show a fake USD 0 equivalent because of I5.

## Spec conformance matrix

“Met” below refers to the inspected/reproduced behavior, not an unperformed visual sign-off. “Partly” identifies substantive gaps; “Missed” means the requested behavior is absent. Owner-deferred progress history is not a delivery failure. Wireframe sample numbers are illustrative, not acceptance fixtures.

| Spec item | Result | Evidence / remaining work |
|---|---|---|
| Overall A→B→C→D→E order; F separate destination | **Met** | `review.tsx:539`, `:584`, `:665`, `:716`, `:1122`; app mounts detail separately. |
| Default whole plan, all runs, newest first; D filters do not rescope A–C; E own class | **Met** | Initial state `review.tsx:46`; summaries use unfiltered cost; worker selector `:1125`. |
| Visible timezone; date range “runs started in range” | **Partly** | Dates show timezone; range filters exist. UTC-day matching differs from shown local dates; caption is two ordinary From/To labels. |
| Plan elapsed first start→completion/snapshot; inferred end labeled; unfinished idle advances | **Partly** | Calculation `review.tsx:318`; inferred label exists. Explicit completion contract missing; idle plans with no active/pending run stop polling, so snapshot time can freeze. |
| Worker sum including concurrency and live elapsed | **Partly** | Correct summation; I1 terminal reconciliation and I7 freshness. |
| Plan/task/run review-wait unions and association | **Partly** | Index/plan union correct; task-only legacy kept separate. Run/F2 first-interval limitation and incomplete-history labeling, I3. |
| Task elapsed, attempt work, cumulative totals across all attempts | **Partly** | Host summary exists. Terminal end uses last accept only; superseded/negative terminal events and active cumulative columns incomplete (`actions.ts:528`; `review-detail.tsx:119`). |
| Progress result/negative/disputed/superseded/open, denominator/exclusions | **Partly** | Current counts and superseded exclusion present; disputed and legacy-unknown results conflated, I3. |
| Recorded returns/relaunches; unique attempts | **Partly** | Trigger/index fields and decisions exist. Legacy ledger infers returned; no robust deduplication by run ID in aggregate loop; task return/relaunch summary incomplete. |
| Availability all five states, observedAt/source/final, measured zero, partial coverage | **Partly** | Types added, but producers and UI do not honor the full contract; I2/I5. |
| Locale number separators, explicit USD/three decimals, pp/tiny deltas/coarse zero | **Partly** | Overview USD and pp correct; F uses environment locale/pp, no `<0.1 pp` precision presentation; quota legacy field rounded early. |
| A three metric cells, 22–24 px, 8/16 spacing, overlap explanation | **Met in source** | `styles.ts:101`; actual layout/contrast blocked. |
| A responsive three columns→stack under 760 content px | **Met in source** | `styles.ts:148`; four stand cases unverified. |
| A progress-history table/chart | **Met owner-adjusted scope** | Deferred; no invented trend. Inert history disclosure is unnecessary noise, M2. |
| A no-runs/loading/error/retry/stale behavior | **Partly** | Empty and skeleton/retry exist; stale data discarded on rev change, I7. |
| B three titled cash/quota/equivalent regions; no combined grand total | **Met in B** | `review.tsx:589`; reused ledger/task accounting still violates semantics, I4/I5. |
| B muted estimate, not charged; fixed subscription fees unallocated | **Met in B** | `review.tsx:625`; equivalent style `styles.ts:106`. Owner label exists EN/RU. |
| B sources/rates/model/version/date/coverage; promotional status | **Partly** | Source/rate lists and coverage exist; historical rates, source IDs and promotional status missing. |
| B per-account/provider/window samples, dedup/overlap/reset/shared handling | **Partly** | ID dedup exists; I4. Family labels in B are fixed, but D/F still expose unknown windows. |
| B tokens coexist with quota, missing values visible; narrow stack | **Partly** | F contains both; labels visible. Missing-state explanation/coverage incomplete; CSS stacks. |
| B independent loading/error | **Missed** | A–E share one cost request and gate. |
| C waiting/returned/failed/stopped/multiple counts; buttons focus D | **Met structurally** | `review.tsx:668`; decisions limited by historical association. |
| C waits ranked by active wait, top three ready-since/dependants, Graph handoff | **Partly** | Top-three ordering, links and dependant count present. D waiting order wrong; no Graph handoff or displayed longest duration. |
| C recorded reasons/source previews, incomplete-history coverage, isolated states | **Partly** | Incomplete-history sentence present; numerical decision coverage, reason previews and isolated loading/error absent. |
| D semantic table, separate task/run destinations, full titles/selection | **Partly** | Table and independent buttons exist; run selection exact. No actual links/noninteractive row opening, task-title focus disclosure incomplete. |
| D default task/attempt, worker/start, execution/decision, elapsed/wait, accounting/open | **Met structurally** | `review.tsx:442`; no worker hidden at narrow breakpoint. |
| D optional equivalent/tokens/lane/class/start/reason/overview columns | **Partly** | Only equivalent toggle; overview sensibly omitted visually but still loaded. |
| D text search title/task/run/canonical/aliases | **Partly** | Raw alias of each run searched; all proven aliases are not expanded to every canonical row. |
| D execution/decision/worker/class/lane/usage/wait/duration/date facets, OR within/AND across | **Partly** | Most scalar facets exist; multi-select OR and partial/notApplicable facets absent; duration/date defects I6/M1. |
| D start/duration/wait/cash/equivalent/window-quota sorting, unknown last/ties | **Partly** | Run sort helpers meet null-last/ties; only elapsed has sortable table-header semantics; task sorting broken. |
| D task/lane/worker groups, counts/subtotals, child order, separate expand/task link | **Met substantially** | Groups generated before paging; task oldest-first, totals separate, unknown accounting caveats I4/I5. |
| D Tasks mode includes no-run tasks, cumulative work/wait/money, returns/latest decision/activity | **Partly** | Includes no-run tasks and metrics. Latest decision is latest-run association, not latest task event; last activity is start only; I6. |
| D Tasks grouping and has-worker filter | **Partly** | Worker filter checks matching run. All task-mode grouping absent; worker unavailable as required, but lane grouping also absent. |
| D 50 defaults, 25/50/100, ten pages for 500, group25/child20/tasks50 | **Met for client paging** | Existing 500-run helper test plus independent ten-page traversal; rendered test mounts 50 of 120. |
| D lightweight/cache/lazy overview; five-second active refresh; update hold/cancel | **Partly** | Polling and stale-request ignore exist; no AbortController, visibility gate, update hold, completed cache or lazy overview, I7/I8. |
| D state repo/plan/filter/mode/group/expanded/sort/page/scroll/focus; durable links | **Partly** | In-memory state plus in-session run scroll restored; durable/step/task focus missing, I9. |
| D result announcements, empty plan/filter, Retry, no cross-repo stale rows | **Met substantially** | Tests cover repository isolation, status and empty cases; same-plan revision retention still wrong. |
| E All/Mixed classes, touched sort and separate measure sorts | **Partly** | Default and most sorts present; Unclassified broken, quota sort absent. |
| E canonical/model/billing identity; preserve proven aliases without historical guesses | **Partly** | Claude merges; generic codex is guessed, billing not shown, contribution identity too broad. |
| E accepted-result/reviewed denominator, small sample, finished median/running count | **Partly** | Median/small-sample/running count implemented; success numerator/decision coverage wrong, I3. |
| E shared-task count, incomplete cost/decision coverage, no universal winner | **Partly** | No ranking badge; shared-task counts and metric coverage absent. |
| E contribution filter→complete task history, empty class + All control, isolated states | **Partly** | Full task history yes; contribution identity inaccurate; selector can return All but no dedicated empty action; loading/error shared. |
| F1 exact run→panel→expand; main area at1100; 420–480 panel/min760 main | **Partly** | Dedicated Review panel at≥1428, width420, shared ledger; not operational panel Runs tab. Actual available width/resize behavior unverified. |
| F1 mandatory IDs/model/attempt/times/tokens/money/quota/wait/outcome/decision/reason/availability | **Partly** | All principal labels present; cacheWrite value, current metrics, attempts and provenance gaps I2/I3/I7/I9. |
| F1 reasoning inclusion; execution permission waits separate | **Partly** | Reasoning displayed without inclusion semantics; no fabricated permission-wait duration. |
| F1 immediately readable shared v5 ledger and record details/search/kinds | **Met structurally** | Single LedgerView, existing search/detail test passes. Large header reduces ledger prominence. |
| F1 100-step paging/stable seek/retained range/mark↔row focus and highlight | **Missed** | I10; virtualization is not this contract. |
| Shared typed legend/approximation/counts/sampling/time-position semantics | **Partly** | Time positioning and translated kind filter buttons exist; required legend, approximation/sampling and bucket semantics absent. |
| F1 usage separate modes/cumulative/table/attributed/residual/no invented allocation | **Partly** | Final-only handling and negative discrepancy test pass; complete event/source/leaf semantics absent. |
| F1 discrete quota/reset/gaps, independent header/ledger/usage load and errors | **Partly** | Text sample display avoids invented curve, but I4. Ledger retry preserves header; no separate usage endpoint. |
| F1 live visible five-second usage+trace, local clock, pause/follow/latest/settling | **Partly** | Trace poll and scroll-position follow exist; I7/I10. |
| F navigation query/anchor/step persistence, panel return, browser Back/Forward/Escape/Close | **Partly** | In-page Back test passes; I9; no operational actions triggered by inspection. |
| F2 all attempts despite origin filters, main-area comparison, 2/3 paged columns | **Met substantially** | Host fetch includes all attempts; paging test passes; real layout blocked. |
| F2 task state/class/lane/elapsed/work/wait/cost/attempt-return-relaunch header | **Partly** | Principal cumulative facts exist; class/lane and return/relaunch counts absent; persisted state can disagree with live execution. |
| F2 trigger/model/outcomes/reasons/times/tokens/separate raw cumulative accounting | **Partly** | Comparison exists; cacheWrite/reasoning rows, exact numbering, coverage and active cumulative work incomplete. |
| F2 decision/review/relaunch history incl actor/source; task absolute-time usage chart | **Partly** | Accept/reject notes rendered; not full lifecycle; table of final run amounts, no segmented event chart. |
| F2 no-run/single-run/missing-log/error Retry+Back | **Partly** | Single-run/error navigation implemented; fake zero estimate in no-run summary; missing empty trace can appear as empty ledger without explicit missing-log reason. |
| Layout container-aware, 1100 second accounting row, wrap/filter density, RU expansion | **Partly in source** | CSS exists, but no rendered verification and all filters exposed. M3 responsive table concerns. |
| Keyboard semantic headings/dl/tables/captions/scope/aria-sort/disclosures/focus return | **Partly** | Most semantics exist; I9/I10; only elapsed sort uses aria-sort; sort-direction button has only an arrow. |
| English/Russian full copy/plurals/localized errors, contrast/focus verification | **Partly** | Dictionaries/guard pass; M1; actual contrast/focus blocked. |
| Contracts: identity/billing launch snapshots and legacy provenance | **Partly** | Fields exist; historical generic guesses and comparison identity handling need fixes. |
| Contracts: metric availability and cash/estimate/rate provenance | **Partly** | I2/I5; types exceed what adapters transmit. |
| Contracts: quota identities/timestamps/resolution/reset/attribution | **Partly** | Partial schema, legacy collectors; no reliable complete sample capture. |
| Contracts: stable decisions/intervals with verdict/reason/association | **Partly** | Intervals written, but notes lack stable run/event IDs; verdict not attached to interval; source='human' also marks automatically entered review. |
| Contracts: task summary/current-class fallback and plan lifecycle/completion | **Partly** | Task summaries exist; currentClassFallback flag is only set when class is absent, not for current-class historical fallback (`actions.ts:530`); lifecycle/completion/history contract absent (history UI deferred). |
| Contracts: versioned lightweight summary, plan-scoped task/run/usage detail, cursor/seek | **Partly** | schemaVersion2 and task ownership validation; API calls omit plan IDs (`api.ts:51`); no run-usage or cursor contract. |
| Contracts: source-deduped timestamped usage events, parent/leaf/reconciliation | **Missed as a complete contract** | Some ledger token/cost records work; no general event stream; I10. |
| Leave-outs: no total cash+quota, leaderboard/forecast/blame, duplicate full trace, bulk ops/infinite scroll | **Met substantially** | Uses shared ledger, pages, no Review operations or fabricated historical progress. Retained old economics/timeline source is not imported by Review. |

Old audit coverage, for traceability: **F1 partly, F2 partly, F3 partly, F4 missed in the CLI producer, F5 partly, F6 partly, F7 partly, F8 missed; I1 partly, I2 partly, I3 partly, I4 missed, I5 partly, I6 partly, I7 met; D1 met structurally, D2 partly, D3/D4 partly, D5 partly, D6 partly; X1 partly, X2 partly, X3 met, X4 partly; U1 met, U2 partly, U3 met, U4 partly (history owner-deferred).** Reasons and fixes appear in the matrix and findings above.

## What the three task journals explicitly left undone

**rva:** Its worktree/journal file is no longer available. The authored journal text is recoverable in rva run events:84 (`/Users/kjaly/WebstormProjects/dsh-orchestra/.orchestration/runs/run_codex-mue78vrcgu2q/events.jsonl:84`), and final evidence references it; a later edit at `:119` has no diff payload, so this is the recoverable draft plus final report, not a claim to have read the final file. Explicit not-done items: client active refresh (F6), worker/class denominators (I3), ledger counts/sampling (I4), typed trajectory categories (I5), review wording (I7), detailed usage/residual/retained-history work, navigation/visual checks. Changed/limited items: exact legacy intervals unreconstructable; current quota capture remains before/after with unknown attribution; cache-write/semantics not normalized across adapters; full coverage UI deferred; completed-summary cache, detail cursors and `GET run-usage` deferred. It claims events/trajectories were removed from GET cost, which is false for the merged code now. Its final answer confirms stable account/window capture and detailed usage reconciliation remain. It also records repository-wide Biome lint failures, distinct from the passing required checks.

**rv3:** Read rv3 journal (`/Users/kjaly/WebstormProjects/dsh-orchestra-orch-rv3/docs/tmp/2026.09.23_rv3-review-drilldown_deviations.md:13`). No standalone usage-event stream or seekable cursor; task usage shows final amounts only; cache-write value unavailable; navigation in memory, no reloadable link; dedicated Review panel rather than operational task-panel Runs tab; cursor/stable seek work left to v5/host; all four stand checks blocked by EPERM. Bundle ceiling raised 450→480 KiB; measured 472,695 bytes. Those limits were not all resolved later.

**rvc:** Read rvc journal (`/Users/kjaly/WebstormProjects/dsh-orchestra-orch-rvc/docs/tmp/2026.09.23_rvc-review-screen_deviations.md:5`). Missing rate date/version; shared cost loading/error; reason previews; URL links, task-mode grouping, live-update hold, deep-link filters, scroll anchors, visible-row-only overview fetch; shared-task counts and worker quota sorting. Legacy economics/timeline retained because tests import them. Stand checks blocked by EPERM. Bundle ceiling raised 480→520 KiB, measured 510,177 bytes. Its C row contradicts itself about dependency counts: current source does show blocked-dependant counts. Its scroll-restoration gap is now partly repaired by app-level in-session restoration; durable and task/step restoration remain incomplete.

Owner decisions/merge fixes: history deferral **met**; B's muted “estimate, not charged” **met**, cross-surface accounting **partly**; legacy quota inclusion **met in core aggregate, missed in F**; family window labels **met in B, partly elsewhere**; four-key repair is present in the sense that dictionary guard/build pass, but it did not make raw protocol-valued controls localized (M1).

## Information, usefulness, design and interaction

| Block | Does it answer its question? | Remaining noise / practical implication |
|---|---|---|
| A Progress/time | **Partly.** Hierarchy and overlap explanation help; progress numerator and worker total are currently misleading. | Do not make routing/time decisions from these numbers before I1/I3. Qualify incomplete historical wait near its value. |
| B Money/quota | **Mostly at overview level.** Correctly separates USD 0.868 recorded cash from ≈USD 71.567 equivalent; quota uncertainty is visible. | Evidence disclosures need source links and real window identity; cross-surface contradictions undermine trust. |
| C Investigate | **Partly.** A useful filter launcher for recorded executions and repeat attempts. | Zero returns is not complete decision evidence; reason previews and a dependable longest-wait path are still absent. |
| D Index | **Useful foundation.** All runs reachable by pages/search; run/task destinations distinct. | Dense IDs/timezones/accounting repeated per row, exposed advanced filters, and broken task/active filters reduce investigation efficiency. |
| E Worker comparison | **Not yet reliable for routing.** Class context, sample size, median and reviewed denominator are better than a leaderboard. | Disputed successes, unlabeled identity splits, unknown billing and missing shared-task/coverage data remain material. |
| F Run/task | **Useful evidence access, incomplete explanation.** All attempts and shared ledger are available without inventing per-step distribution. | Large fact inventory, duplicated contradictory ledger totals, missing measured cache-write values and stale header data need repair. |

Width/language matrix: **1440 EN blocked; 1440 RU blocked; 1100 EN blocked; 1100 RU blocked.** CSS/source suggests the intended hierarchy, wrapping and responsive main-area detail, but no actual alignment/overflow/contrast measurements or screen-reader/manual keyboard pass can be asserted. Viewport height, zoom/font metrics and screenshots are unavailable. Server rendering verified language strings and values, not layout.

At hundreds of runs: pure filter/sort/group/page helpers were independently exercised over 500 real-shaped summaries, with ten 50-run pages. In a warmed, post-suite run the median was **1.63 ms**, p95 **1.91 ms**, over 100 iterations; an earlier run under test/build contention reached p95 52.49 ms. These numbers exclude React layout/browser paint and network/host work. Existing rendered test confirms 50 mounted run links out of 120 and page restoration. Group child paging and keyboard access to every run were not verified on the stand. Required <100 ms cached *browser interaction* remains unmeasured.

## Regression checks outside Review and test evidence

- **Graph:** existing `graph-review-highlight.test.tsx` tests (“marks review nodes…”, “Приёмка lens…”, graph accept action) passed; no Graph-specific source regression established by this review. The shared initial bundle is larger. Rendered Graph smoke is blocked.
- **Work:** `work-review.test.tsx` tests “places attention and reviews in Needs you…”, “uses the same core closed status in Work, Graph and the task panel” passed. This validates that negative closure behavior is shared, not that Review's disputed numerator is correct. No new Work-specific functional regression established.
- **Task panel:** “opens the requested run trace inside the task panel” passed. Operational panel still uses `RunTracePanel` (`task-panel.tsx:341`), while Review uses its dedicated detail surface. Shared ledger accounting/outcome defects I3/I5 affect both entry points; rendered handoff remains unverified.
- **Data/Review tests:** `cost.test.ts` “keeps the quota of legacy runs whose attribution is unknown” passes **only core totals**; it does not cover F2. “prefers backend usage for money and tokens” injects pending/observed fixtures, missing I2's actual adapter issue. `review-index.test.ts` covers 500-row paging, unknown-last sorting and union of overlapping exact waits; it omits active minimum-duration and Tasks-mode sorting. `review-detail.test.tsx` verifies final-only residual, negative discrepancy, dedup, attempt paging and pending header. `review-cost-hook.test.tsx` checks cross-repo isolation and stale retention at the same revision. `review-navigation.test.tsx` checks in-session Back, not reload/Forward/selected-step restoration. `trace-ledger.test.tsx` checks virtual rows/search/full inspection, not keyboard timeline parity or cursor paging.
- **Bundle:** current 526,274-byte minified client passes the current 560 KiB tripwire and keeps ELK/DXF/structured preview in separate assets. Passing that raised guard is not evidence that the initial-load regression disappeared. Baseline comparison and attribution limits are in M4.

## Result claim

**Needs fixes. No Critical finding established.** Important findings:

1. **I1:** Historical terminal run counted indefinitely as active, inflating worker time.
2. **I2:** Unobserved usage reported as known zero; cache-write counts lost.
3. **I3:** Disputed/legacy results and ledger outcomes misclassified; detail wait association incomplete.
4. **I4:** Legacy/shared/reset quota accounting disagrees across surfaces.
5. **I5:** Missing monetary totals become zero; ledger loses cash-versus-estimate semantics.
6. **I6:** Active-duration, task sorting and worker comparison/contribution controls are incorrect.
7. **I7:** Live detail remains stale and polling can steal focus/reorder reading context.
8. **I8:** Summary endpoint still rereads all histories and sends nearly 1 MB for 127 runs.
9. **I9:** Detail navigation is not reloadable/Forward-safe and does not restore task/step origin fully.
10. **I10:** Shared ledger paging/seek/completeness and keyboard investigation contract remain unfinished.

Automated checks are green; raw-data correctness is not. Required rendered EN/RU × 1440/1100 acceptance remains blocked by the explicit browser-access denial and must be completed before claiming the view ready.
