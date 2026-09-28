# Review / Итоги: audit and redesign specification

Date: 2026-09-23. Source baseline: `ec4f8aa`. Scope: documentation only; no product changes. Includes the owner's binding addition: detailed run and task drill-downs.

## Evidence and verification limits

This is a source-backed audit and implementable specification, **not a completed visual sign-off**. Evidence labels below distinguish source facts (S), owner observations (O), and proposed behavior (P). File references are repository-relative, with line numbers at the baseline above.

The owner reports 113 runs / 105 tasks, elapsed 24 h 36 min, worker time 34 h 42 min, human wait 17 h 33 min, duplicate “Claude Opus 5” rows, subscription equivalent approximately $69.10 beside $0.868 cash, and a running row with `0 / 0 / 0`. These are supplied observations, not independently measured totals. Wireframe values marked `…` are placeholders.

Attempted exactly:

```sh
pnpm --filter dsh-orchestra stand -- --repo /Users/kjaly/WebstormProjects/dsh-orchestra
```

The command failed: this checkout lacks `packages/plugin/lib/index.js`. Opening `http://127.0.0.1:4640/?lang=ru` through the browser tool was then rejected by browser security policy: the user denied access. No alternate browser, screenshot mechanism, or indirect stand access was attempted. The real plan was not modified. External comparisons below use public primary documentation, not logged-in product inspections.

| Required visual check | Actual verification |
| --- | --- |
| RU, 1440 px | Blocked; source/CSS assessment only |
| EN, 1440 px | Not opened after access denial; source/CSS assessment only |
| RU, 1100 px | Not opened after access denial; breakpoint assessment only |
| EN, 1100 px | Not opened after access denial; breakpoint assessment only |

Consequently, no measured overflow, contrast ratio, rendered row height, load latency, or screenshot claim appears here. The four visual checks remain a delivery validation requirement. The audit can support implementation planning now; it cannot certify rendered quality.

## 1. Questions people bring, in priority order

Scale: 0 absent; 1 fragments/unreliable; 2 useful but incomplete; 3 actionable and trustworthy. Priority reflects this owner's plan and requested investigation.

| Rank | Person's question | Current answer | Score | Required destination |
| --- | --- | --- | --- | --- |
| 1 | Where did the time go, and what can I change? | Elapsed, worker sum and review-wait union are shown together without explaining overlap; historical review intervals are incomplete. | 1 | Time summary → waiting tasks → task history |
| 2 | What failed or was returned, and why? | Several distinct outcomes are all called “Returned”; no reason in the list. Existing row opens a small trace. | 1 | Outcome filters → run ledger and recorded decision |
| 3 | What did this cost in cash versus subscription quota? | Some distinction exists (`≈`, cash/equivalent text), but one Total cell contains incompatible measures and partial data are under-described. | 1 | Separate accounting block → run cost evidence |
| 4 | What am I holding up? | A duration is displayed, but earlier runs can inherit later acceptance time; no ranked queue or evidence of dependency impact. | 1 | Current review waits → task panel |
| 5 | Is the plan converging, or are attempts accumulating? | Run count alone; no accepted-task trajectory, scope changes or attempts per task. | 0 | Progress summary → task attempt comparison |
| 6 | Which worker is worth using for this class of task? | Cost/time per touched task, duplicate aliases, no class or result denominator; cannot support a worker choice. | 1 | Class-filtered comparison → contributing tasks |
| 7 | What happened inside this run, and where was usage incurred? | Row does open a step list, but header has only duration/count and there is no usage series or cost reconciliation. | 1 | Run inspector → expanded v5 ledger |
| 8 | How much did this task take across returns and relaunches? | Requires finding rows manually and adding unlike amounts. | 0 | Task comparison with all attempts and cumulative accounting |

Review's purpose: explain results and resource use, then make every conclusion inspectable. Work remains the place to operate the queue; Graph remains the place to inspect dependency structure.

## 2. Findings by dimension

Severity: **P1** misleading result/accounting or missing essential investigation; **P2** materially impedes interpretation/navigation; **P3** polish. No P0 incident is established.

### Function and data

| ID | Severity | Evidence | Finding and prescribed fix |
| --- | --- | --- | --- |
| F1 | P1 | O duplicate Opus rows; S `packages/core/src/cost/cost.ts:48`, `packages/plugin/src/client/views/economics.tsx:16`, `packages/plugin/src/client/provider.ts:25` | Totals group by raw `agent`, but labels canonicalize it. Merge proven aliases before aggregation; preserve raw identity for provenance. Never merge by display label or reinterpret historical generic aliases using today's model. |
| F2 | P1 | S `packages/plugin/src/client/views/review.tsx:40` | Failed/cancelled runs and any run followed by another become “Returned.” A relaunch does not establish a human rejection. Expose execution outcome separately from human decision and attempt trigger. |
| F3 | P1 | S `review.tsx:81`, `packages/plugin/src/client/insight.ts:188`, `packages/plugin/src/host/actions.ts:402` | Every earlier run may get finish→last acceptance as its human wait; plan wait uses only the latest run per task. Record review intervals and their decision/run association. Union intervals at plan level; do not sum overlapping waits. |
| F4 | P1 | O running zeros; S `packages/core/src/runs/cli-runner.ts:202`, `packages/core/src/runs/cli-backend.ts:80`, `packages/core/src/cost/cost.ts:40` | CLI usage starts at zero and is returned without a pending flag. Zero-initialized state can render as observed usage. Add per-metric availability and observation timestamps; show “Awaiting usage” before the first measurement. A genuinely measured zero remains zero. |
| F5 | P2 | S `review.tsx:16`, `packages/core/src/cost/cost.ts:36` | Active runs lack `durationSec`; tick normalization falls back to one second, clamping later events to 100%. Use start→snapshot time for active elapsed and overview bounds. |
| F6 | P2 | S `packages/plugin/src/client/insight.ts:245`, `packages/plugin/src/client/panel/run-trace-panel.tsx:14` | Cost fetch depends on root/revision, panel trace fetch on selected run; neither guarantees updates during a long run with unchanged plan revision. Poll active usage/ledger or subscribe independently, with stale-data feedback. |
| F7 | P1 | S `packages/plugin/src/client/insight.ts:55`, `:72`; `packages/core/src/cost/cost.ts:39` | Billing is inferred from agent name; quota deltas are rounded and summed by provider. Shared-account concurrent runs and resets can make this misleading. Carry explicit historical billing, account/window identity, precision and attribution quality. |
| F8 | P2 | S `packages/plugin/src/host/actions.ts:401`, `:415`, `:436` | `GET cost` reads events/usage sequentially for every run and builds trajectories; overview stride is lossy and trace is silently sliced. Summary loading scales with historical logs. Cache completed summaries, fetch detail lazily, and report truncation/paging. |

### Information

| ID | Severity | Evidence | Finding and prescribed fix |
| --- | --- | --- | --- |
| I1 | P1 | O mixed Total; S `economics.tsx:24`, `:33`, `:88` | Cash and equivalents are **not arithmetically added** in this code, but coexist in one cell with quota, inviting comparison as a common total. Split cash, quota and API equivalent structurally, including footers. |
| I2 | P2 | S `packages/plugin/src/client/insight.ts:81`, `review.tsx:92` | Slash-separated numbers do not identify input/output/cache; reasoning is omitted. Label token components; expose cache-write and reasoning semantics in detail. Never add reasoning twice when it is an output subset. |
| I3 | P1 | S `economics.tsx:20`, `:62` | “Per task” uses unique tasks touched by that worker, including unsuccessful or shared tasks. It is not cost per successful task. Label the denominator; compare within class, show sample sizes and decision coverage, avoid a universal winner. |
| I4 | P2 | S `packages/plugin/src/host/actions.ts:417`, `review.tsx:91` | “N steps” counts sampled overview marks, not the full ledger. Return total step count plus sampled flag; summaries must not masquerade as complete history. |
| I5 | P2 | S `review.tsx:19`, `packages/core/src/runs/trajectory.ts:104` | Regex-derived “correction/check” can misclassify labels; model spans fill non-tool gaps and may be inferred. Normalize typed categories and expose approximation. Human input currently falls through to a tool-like mark. |
| I6 | P2 | S `review.tsx:59`, `:66`; `cost.ts:51` | Positive-only cash display and optional fields hide known zero versus unavailable versus partial totals. Always show a labeled accounting state and coverage, including pending runs. |
| I7 | P2 | O “Your decision: 33 sec”; S `packages/plugin/src/client/dict/en.ts:374`, `dict/ru.ts:372` | English suggests active deliberation time while Russian describes waiting. Use “Awaiting human review”; this is elapsed waiting, not a measurement of attention or blame. |

### Design, density and language

| ID | Severity | Evidence | Finding and prescribed fix |
| --- | --- | --- | --- |
| D1 | P2 | O run-on summary; S `review.tsx:62`, `:70`, `packages/plugin/src/client/styles.ts:91` | Flex gaps separate styled spans, but all facts have equal emphasis and no textual punctuation between items. Replace with labeled definition-list metrics grouped by question; retain readable separators in text fallback. |
| D2 | P2 | S `styles.ts:652`, `:655` | `.orc-table th,.orc-table td` has higher specificity than `.orc-table__r`; its left alignment defeats intended numeric right alignment. Use a sufficiently specific numeric rule and tabular numerals. This is a CSS deduction, not a measured screenshot. |
| D3 | P2 | S `styles.ts:94`, `:97`, `:281` | At 1440 the run grid retains four columns; an open 360 px task panel further reduces space. Raw agent text shares the title's flex row while only the title ellipsizes. Keep readable identity on two lines and size by actual content width. |
| D4 | P2 | S `styles.ts:101`, `:282` | Exactly 1100 px triggers both a three-column run layout (figures on another line; agent text hidden) and a bottom task panel capped at 48% height. Investigation can lose both table density and ledger height. Use container-aware list layout and main-area expansion at this width. |
| D5 | P2 | S `styles.ts:99`, `review.tsx:91` | Two-pixel color ticks have no visible legend; titles are hover-only and individual marks are not keyboard targets. Use a compact labeled overview with textual counts; detailed steps belong in the ledger. |
| D6 | P2 | S `styles.ts:94`, `:653`; EN/RU dictionaries at review labels | Run text is 12 px and headers 11 px uppercase; Russian labels expand, while raw aliases remain technical. Use 13–14 px body, 12 px metadata, sentence-case headers, wrapping labels in both languages. Contrast and actual truncation still require browser checks. |

### Interaction

| ID | Severity | Evidence | Finding and prescribed fix |
| --- | --- | --- | --- |
| X1 | P1 | O 113 rows; S `review.tsx:54`, `:78` | All runs render newest-first with no controls. Add search, filters, grouping and 50-row pagination; keep query state on navigation. |
| X2 | P1 | S `review.tsx:84`, `packages/plugin/src/client/app.tsx:302`, `panel/task-panel.tsx:357`, `panel/run-trace-panel.tsx:25` | Rows already open task-panel Runs→trace. The existing drill-down is not just a strip, but lacks the requested header/cost detail and task comparison. Make both levels explicit and linkable; reuse the v5 ledger in panel and main area. |
| X3 | P2 | S `review.tsx:88` | Every attempt for the selected task gets `aria-pressed=true`; it does not identify the selected run. Highlight exact `runId`, with a separate task context indicator. |
| X4 | P2 | S `review.tsx:88`, `:91` | Native row buttons support Tab/Enter/Space, a useful baseline; there are no separate task links, sort headers or keyboard tick inspection. Add explicit run/task links and semantic sort/filter controls, without nested interactive elements. |

### Usefulness: space earned

| ID | Severity | Evidence | Decision |
| --- | --- | --- | --- |
| U1 | P2 | S `review.tsx:62` | Keep the summary, but only elapsed/work/wait/progress belong above the fold. Move token inventory into usage detail. |
| U2 | P1 | S `economics.tsx:16` | Worker comparison earns space only with canonical identity, class context and outcome/sample information. Move it below actionable investigations and the run index. |
| U3 | P2 | S `review.tsx:75` | Run index is the evidence backbone; keep it, make it navigable, and lower the prominence of tick decoration. |
| U4 | P1 | S `shared/types.ts:37`, `:47` | Task-level cumulative outcome/cost and progression history are absent from the response. Add task comparison; show current progress now and historical trend only when history exists. |

## 3. Redesign specification

### Shared rules and metric definitions

Order in Review: **A. Progress and time → B. Money and quota → C. Investigate → D. Runs/tasks index → E. Workers by class**. **F. Run and task drill-down** is a first-class navigation surface opened from C/D/E, not another long block appended below the list.

Review defaults to the current plan, all historical runs, no filters, newest start first. Plan metrics A/B/C remain explicitly “Whole plan”; D filters do not silently change them. E has its own visible class selector; clicking its contribution link applies worker+class filters to D. A date-range filter is available in D only, labeled “Runs started in range.” Snapshot timezone is visible near dates; underlying values are UTC.

| Metric | Exact definition |
| --- | --- |
| Plan elapsed | First run start to recorded plan completion, otherwise snapshot time. If no explicit completion exists, use last terminal task decision only when all tasks are terminal; label inferred. Unfinished but idle plans continue elapsed time. |
| Worker time | Sum of each run's elapsed duration, active runs capped at snapshot time. Concurrent runs count separately. Not CPU/model-only time. |
| Review wait, plan | Union of all recorded awaiting-human-review intervals; may overlap worker activity. Never display as a slice in an additive elapsed-time pie. |
| Review wait, task | Union of that task's review intervals. Show active wait separately. |
| Review wait, run | Only intervals explicitly associated with that run; ambiguous legacy intervals stay task-level. |
| Task elapsed | First attempt start to terminal task decision or snapshot time. |
| Attempt work total | Sum of that task's run durations. Do not add task elapsed to worker time. |
| Progress | Accepted with result / current in-scope tasks; separately count negative/disputed closures, superseded tasks, in-review and open tasks. Show denominator and scope exclusions. |
| Returns/relaunches | Recorded decision/launch events, not number of runs minus one. Attempts are unique run IDs. |

Availability is per metric: `known`, `partial`, `pending`, `unavailable`, `notApplicable`. A known zero is `0`; pending is “Awaiting usage”; unavailable is an em dash with an explanation; partial shows “at least” and coverage. A live measurement can be known-so-far without being final. Show snapshot freshness without announcing every timer tick to screen readers.

Use tabular numerals and locale-aware decimal/group separators. USD stays explicitly USD (no automatic ruble conversion); preserve three decimals for the owner's $0.868 example. Quota units are **percentage points (pp / п. п.)**, not relative percent growth. Tiny nonzero deltas display `<0.1 pp` if precision supports that claim; coarse measured zero says “No change detected,” not “free.”

### A. Progress and time

Question: Is work converging, and where did elapsed time go?

```text
Review                                         Whole plan · Updated 14:32
Progress       Accepted with result … / 105     … awaiting review · … open
Plan elapsed       Worker time                 Awaiting human review
24 h 36 min        34 h 42 min                  17 h 33 min
Wall clock         Sum across runs             Overlapping waits counted once
[Progress history]                             [View waiting tasks]
```

Values above are owner-reported examples, not recomputed truths. Use three metric cells, 22–24 px values, 12 px labels, 8 px internal gaps, 16 px outer gaps. The overlap explanation remains visible. Progress history is a collapsed daily table/mini-chart of accepted-with-result count, open count, scope additions/removals and returns; date bins in plan timezone, latest day marked partial. No trend arrow or “converging” verdict from run count alone. Without lifecycle history show current counts and “History unavailable,” not a fabricated flat line.

At 1440: three metric columns. At available content width below 760 px: stacked label/value rows. No runs: “No runs yet,” current task counts, time fields “Not started.” Loading: stable metric skeletons with accessible loading text; failure: section error + Retry, retaining any same-plan stale snapshot with timestamp.

### B. Money and quota

Question: What was charged, what subscription capacity changed, and what is only a benchmark?

```text
Money and quota                                Whole plan
API cash recorded        Subscription quota change       API-price equivalent
USD 0.868                Codex · window …: +… pp          ≈ USD 69.10
… / … API runs covered   Account/window measurement       Estimate, not charged
[Show sources]           [Show measurements]              [Show rates]
```

Three separately titled regions; no grand total across them. Cash means recorded usage charge, not an independently reconciled invoice. Equivalent is secondary/muted, with rate source, model, rate date/version and coverage. Fixed subscription fees are excluded from per-run cash and explicitly described as unallocated. Promotional billing gets its own “Promotional / no per-run charge recorded” status; it is not inferred from missing money.

Quota displays one row per account/provider/window. Deduplicate identical samples and do not sum overlapping before/after observations. Mixed/reset windows stay separate. When exclusive run attribution is impossible say “Shared window; run attribution unavailable.” A run can show both tokens and quota; one must not suppress the other. Unknown values remain visible with reasons. At narrow content width these three regions stack. Loading/error are independent of run-history loading.

### C. Investigate

Question: What needs explanation or attention now?

```text
Investigate
Awaiting review   … tasks    Longest …      [View tasks]
Returned          … runs     … with reason  [View runs]
Failed / stopped  … / … runs                [View runs]
Multiple attempts … tasks                  [Compare tasks]
```

Counts are buttons applying explicit filters to D and moving focus to its heading. Waiting tasks sort by active wait descending. Show up to three longest waits with task links, ready-since timestamp and known currently blocked dependants; link to Graph for dependencies. Do not claim how much earlier the plan would finish without critical-path evidence. Reasons preview only recorded decisions/errors, with source links. Empty means “No recorded issues”; absent history means “Decision history incomplete” plus coverage, not zero. Loading uses four text placeholders. Error does not disable D.

### D. Runs and tasks index

Question: Which execution or task should I inspect?

```text
Runs 113                 [Runs | Tasks]           Search task, worker or run…
[Outcome: All] [Worker: All] [Class: All] [Lane: All] [More filters] [Reset]
Group by: None / Task / Lane / Worker              Sort: Started ↓
Task / attempt       Worker       Outcome        Elapsed    Cash / quota   Open
T-…  Title           Claude Opus 5 Returned       12 min     — / +… pp      Run →
     Attempt 2       started …    reason…        wait …     Usage partial
                     Activity: M 12 · T 8 · ! 1  [optional miniature overview]
1–50 of 113                                      [Previous] 1 2 3 [Next]
```

A semantic table, not a giant button containing other controls. Clicking noninteractive row space opens its run; Run is an actual link with a descriptive accessible name. Task title is a separate link to F2; it must not trigger Run. No nested buttons/links. Focus outline and selected run state are independent of hover. All full titles are accessible on focus; two-line visual truncation with a full-title disclosure if necessary.

Default columns: Task/attempt, Worker/start, Execution+decision, Elapsed/review wait, Accounting summary, Open. Accounting shows labeled cash and quota where applicable; equivalent appears only when enabled in Columns and always labeled. Tokens (three labeled subvalues), lane, class, start date, reason and overview are optional columns/details, not mandatory narrow cells.

Filters: text matches title/task ID/run ID/canonical worker and aliases; execution status; human decision; worker; task class; lane; usage availability; human wait min; duration min; start-date range. Multi-values within a facet OR; facets AND. Defaults are All. Unknown class/lane has an explicit Unclassified/No lane option. Header sorts: start, duration, human wait, cash, equivalent, and quota **within one selected window**; unknown last in either direction; ties use start then run ID. No sort mixing cash/quota/equivalent.

Grouping: None default. Task groups contain all matching attempts, ordered oldest-first within task; group label shows “matching / total attempts” and opens the full task. Lane/worker groups show matching run counts and separate accounting subtotals. Groups order by newest matching start by default; expanded children retain their group's stable order. A labeled Expand control is separate from the task drill-down link.

Tasks mode has one row per task with runs, returns, cumulative worker time, task review wait, separate cumulative cash/quota/equivalent, latest decision and last activity. Default sort last activity descending. Includes tasks with no runs when filters allow. Clicking a task row opens F2. Grouping by worker is unavailable in Tasks mode because a task can use multiple workers; filter by “has a run by worker” remains supported and clearly labeled.

**500-run scaling:** 50 entities per page (25/50/100 selector), stable pagination rather than infinite scroll. At 500 ungrouped runs: 10 pages, max 50 mounted primary rows by default. Group mode pages 25 groups; each expansion shows at most 20 child runs with local paging. Tasks mode pages 50 tasks. Host returns lightweight indexed run summaries; overview/detail fetched only for visible rows or on expansion. Filter/sort/group applies to the full dataset before paging. Totals/counts never refer merely to the page. Cache completed runs; refresh active records every 5 seconds while visible. Hold row order during reading and show “N updates available”; applying updates restores the anchor run. Cancel obsolete requests. Target: cached filter/page changes under 100 ms at 500 summaries; measure this, do not claim achieved performance.

Preserve `{repo, plan, filters, mode, group, expandedGroups, sort, page, scrollAnchor, focusedRunId}` in navigation/session state. Deep links encode repo/plan/task/run IDs and durable filter parameters, not titles. A changed filter resets page to 1 and announces result count once. Empty plan: “No runs yet.” Empty filter: “No matching runs” + Reset filters. Fetch failure: Retry; stale same-plan data remains usable. Never retain a previous repository's rows under a new title.

### E. Workers by task class

Question: What evidence informs a future routing choice?

```text
Workers by task class                         Class: Code ▾
Worker          Tasks touched  Attempts  Accepted / reviewed  Median run time
Claude Opus 5   …              …         … / …                …
                Recorded cash … | Quota … [window] | Equivalent ≈ …
                … tasks shared with other workers · [Inspect contributions]
```

Default class All, visibly labeled “Mixed task classes”; sort tasks touched descending, then canonical worker ID. Allow sorting attempts, median run time, reviewed acceptance rate and each accounting measure separately. Show sample numerator/denominator, incomplete decisions and partial cost coverage. Acceptance rate is reviewed runs accepted with result / runs with an attributable human decision, not all completed runs. Median duration uses finished runs only; running count shown separately. Small samples (<5 reviewed runs) say “Small sample” and carry no ranking badge.

Canonical worker+resolved model+historical billing is the comparison identity. Alias-only variants merge; different resolved models or billing modes remain labeled separately even if today's display name matches. “Cost per task touched” can be expanded; do not label it cost per successful task. Tasks touched overlap across workers and must not be summed into the unique plan task count. Contributions open D filtered by class/worker; task links there open complete task histories including other workers. No runs for a selected class: explanatory empty state and All classes control. Error/loading isolated to the block.

### F. First-class drill-down: run and task

#### F1. Run — task panel, expandable into the main area

Review Run row/link → task panel → Runs tab → selected run inspector. At 1440 the panel is 420–480 px when space allows (minimum remaining Review width 760 px); otherwise use main-area run detail. At 1100, open the run in the main area by default, avoiding the current half-height bottom panel. Expansion replaces Review's main content with the **same v5 ledger component**, not a second trace implementation. No modal nesting.

```text
← Back to Review                Task T-… →        [Expand] [Close]
Run … · Attempt 2               Claude Opus 5 · started …
Execution: Completed            Human decision: Returned
Reason: … [recorded decision]
Elapsed …       Awaiting human review …
Tokens  Input … | Output … | Cache read … | Cache write …
Cash USD …      Quota +… pp [window]      Equivalent ≈ USD …
Usage: Partial · observed …

Step overview  0:00 | M---T-E-C-!--M | 12:40      [Legend]
Ledger         [All steps ▾] [Find step…]         Live / Paused
Time     Duration   Step / result                         Usage
+0:00    …          Model response                        in … out …
+0:12    …          Read file …                           —
+1:03    …          Check … · failed [Expand details]      —

Usage over time  [Cash | Equivalent | Tokens | Quota]
USD ↑      _/___/      [same time range as overview]
    +----------------→ elapsed
[Breakdown table]    Attributed … | Unattributed … | Total …
```

Header is mandatory: run ID/canonical worker/resolved model, attempt index, start/end or Running, elapsed, input/output/cache-read/cache-write tokens, money and/or quota, human wait, execution outcome and human decision/reason. Missing metric labels stay present with availability text. Reasoning tokens appear in expanded usage with “included in output” when applicable. Separate “Awaiting human review” from any permission/input waits inside execution; show the latter only if instrumented.

The **v5 ledger with its overview is the primary content**, readable immediately without clicking ticks. Rows show relative time, duration (approximate mark when inferred), kind icon+text, operation summary, result/error, and any attributable usage. Expand a row for arguments/result/report evidence; long output is collapsed with explicit size and Load more. Search and kind filters apply to all ledger rows, with matching count and retained chronology. Page 100 steps at a time; allow seeking by stable step ID even outside the loaded page. Selecting an overview mark loads/focuses the corresponding ledger step; selecting a ledger row highlights its time interval. Overview is not the sole route to detail.

Legend, shared by D/F: **M Model / Модель; T Tool / Инструмент; E File edit / Изменение файла; C Check / Проверка; ! Problem / Проблема; R Correction / Исправление; H Human input / Ввод человека**. Preserve category colors, but also use icons/letters and visible text. Correction requires an explicit relationship/event; inferred categories are marked approximate. Tick position is elapsed-time position, not token or cost share; widths do not imply duration unless spans have recorded ends. In D, one compact overview has a single accessible textual summary (counts by category, approximation/sampling notice); its marks are not dozens of tab stops. The full ledger supplies keyboard-accessible steps and exact counts. At high density, bucket marks by time with counts, preserve problem markers, and say “Overview sampled.”

Usage breakdown modes are independent units, never a dual-axis cash/quota graph. Attributed leaf usage events are binned by timestamp or step; cumulative line plus accessible table shows increment, cumulative amount and source. Tool rows with no measured charge show “Not reported,” not zero. Parent spans do not add their rolled-up cost to leaf totals. Run total reconciles with attributed + unattributed residual for each additive measure; negative discrepancies show “Does not reconcile,” never a fabricated negative step charge. Quota is discrete account-window samples with reset markers, not a fabricated smooth spend curve. A final-only amount shows a total and “No step-level usage recorded,” with no interpolated distribution. Partial charts show coverage and gaps; no allocation proportional to duration.

Header can load from cached summary while ledger and usage independently load. Error in ledger: “Steps unavailable” + Retry, preserving header and task comparison link. Missing old logs: “Run summary available; step history unavailable.” Running: poll ledger and usage every 5 seconds while visible, clock advances locally from server snapshot; auto-follow only while already at bottom. Moving up pauses follow, exposes Jump to latest. Final run stops polling after usage settles, or shows pending accounting explicitly.

Navigation: opening stores the originating Review anchor and query. Back to Review closes detail and restores exact row/page/filters/scroll/focus. Back from expanded run returns to the panel if expansion came from there. Task link opens F2 and retains run ID as origin; Back to run restores its ledger step/scroll. Browser Back follows the same stack. Close returns to originating surface, not Graph. Escape closes a popover first, then inspector/expanded detail; it must not cancel a run. Task operational actions remain in the task panel; navigating Review never accepts, returns or relaunches anything.

#### F2. Task — full comparison in the main area

Review task title, Tasks-mode row or “Compare all attempts” in F1 → main-area Task history. The task panel may retain compact current task metadata/actions, but is not the home for side-by-side comparison. At both widths, close/collapse that panel by default while comparing to maximize space. Include **all runs**, even those outside originating filters, with an explicit notice and count.

```text
← Back to Review      Task T-… · Title                   [Open task panel]
Current outcome …     Class … · Lane …
Task elapsed …        Total worker time …       Total review wait …
Cumulative cash …     Quota by window …         API equivalent ≈ …
… attempts · … returns · … relaunches             All attempts shown

Metric / event       Attempt 1           Attempt 2           Attempt 3
Trigger              Initial             After return       Relaunch
Worker               …                   …                   …
Execution/decision   Completed/Returned  Failed/No decision  Completed/Accepted
Reason / source      … →                 error … →           decision … →
Start → end          …                   …                   …
Run time / wait      … / …               … / …               … / …
Input/out/cache      …                   …                   …
Cash / quota / equiv separate values     separate values     separate values
                     [Open run]          [Open run]          [Open run]
Cumulative after     cash …; work …       cash …; work …       cash …; work …

Decision history     ready for review → return(reason) → relaunch → acceptance
Usage over time      [Cash | Equivalent | Tokens | Quota]    [Table]
```

All attempt columns chronological by start, tie by run ID; attempt numbering remains stable. Returns are decision events attached to a run, not separate fake runs. Relaunch shows parent run/trigger when recorded; otherwise “Trigger unknown.” Show reason, actor category and timestamp without inventing an actor. Header totals include failed, cancelled and returned attempts; distinguish task elapsed, sum of run times, and union of waits. Cash and equivalent sum independently with coverage. Quota only deduplicated within compatible account/windows; show multiple window rows, never a grand percentage. Cumulative columns sum raw measurements before rounding.

At 1440 aim for a 180 px pinned metric label column plus three 280 px attempt columns. At 1100 show two attempt columns plus labels; the comparison region scrolls horizontally for remaining attempts, with a visible scrollbar and Previous/Next attempt controls. Every attempt remains accessible; an attempt picker can jump directly to any column. Do not silently truncate to the latest three. For many attempts, render a paged comparison window and label “Attempts 1–3 of N”; keep cumulative totals across all attempts. Controls retain keyboard focus and announce the displayed range.

Open run from an attempt opens F1 in the main area with “Back to task history”; returning preserves comparison position. Decision/history links focus the corresponding ledger step when an exact link exists; otherwise open the recorded task note beside the comparison. Task-level usage chart stacks/segments by run ID on absolute time and uses the same measure/provenance rules as F1; missing intervals remain gaps. One run still gets a useful header and one column. No runs: task metadata and “No runs yet,” no fake totals. Deleted/unavailable run logs retain the column summary and reason. Task fetch error provides Retry and Back to Review.

### Layout and keyboard acceptance rules

Use content-container widths, not only window media queries. At 1440 with no panel, A/B may each have three columns; with a panel they collapse according to available width. At 1100, D retains task/worker/outcome/time and moves accounting into a labeled second row; optional tick overview is hidden by default, never the worker identity. Filters wrap to two lines without horizontal page scrolling. Russian labels may wrap; numbers and units stay together. Allow at least 30% label expansion; never reduce type to make translation fit. Task comparison alone may scroll horizontally inside its labeled region.

Use semantic headings, definition lists and tables with captions/scope. Sort buttons expose `aria-sort`; disclosures expose expanded state. Tab reaches filters, task/run links, page controls, legend and ledger disclosure controls. Enter follows links; Space toggles buttons. No required mouse-only action. Focus returns to the exact originating link (or list heading if it disappeared). Announce page/filter changes and failures, not every active timer update. Color is redundant with labels/icons. Verify text contrast and focus contrast in the real theme; this audit has not measured them.

### English / Russian copy contract

Reuse existing correct labels; add these keys or equivalents in both `client/dict/en.ts` and `client/dict/ru.ts`. Use the existing pluralization mechanism for counts.

| Key | English | Russian |
| --- | --- | --- |
| review.scope | Whole plan | Весь план |
| review.updated | Updated {time} | Обновлено {time} |
| review.progress | Progress | Прогресс |
| review.resultAccepted | Accepted with result | Принято с результатом |
| review.elapsed | Plan elapsed | Прошло с начала плана |
| review.workerSum | Worker time · sum across runs | Время воркеров · сумма запусков |
| review.humanWait | Awaiting human review | Ожидание проверки человеком |
| review.overlapNote | Work and review wait can overlap. | Работа и ожидание проверки могут идти одновременно. |
| review.history | Progress history | История прогресса |
| review.noHistory | History unavailable | История недоступна |
| review.accounting | Money and quota | Деньги и квота |
| review.cash | API cash recorded | Учтённые расходы API |
| review.equivalent | API-price equivalent | Эквивалент по тарифам API |
| review.notCharged | Estimate, not charged | Оценка, не списание |
| review.quotaChange | Subscription quota change | Изменение квоты подписки |
| review.sharedQuota | Shared window; run attribution unavailable | Общее окно квоты; расход запуска не выделен |
| review.noChange | No change detected | Изменение не зафиксировано |
| review.coverage | Usage available for {known} of {total} runs | Данные расхода есть для {known} из {total} запусков |
| review.pendingUsage | Awaiting usage | Ожидаются данные расхода |
| review.partial | Partial data | Неполные данные |
| review.unavailable | Unavailable | Недоступно |
| review.notApplicable | Not applicable | Не применимо |
| review.investigate | Investigate | Разобраться |
| review.multipleAttempts | Multiple attempts | Несколько попыток |
| review.search | Search task, worker or run | Поиск задачи, воркера или запуска |
| review.group | Group by | Группировать по |
| review.none | None | Без группировки |
| review.class | Task class | Класс задачи |
| review.lane | Lane | Дорожка |
| review.noLane | No lane | Без дорожки |
| review.unclassified | Unclassified | Без класса |
| review.reset | Reset filters | Сбросить фильтры |
| review.noMatches | No matching runs | Подходящих запусков нет |
| review.loading | Loading Review… | Загружаем итоги… |
| review.retry | Retry | Повторить |
| review.previous | Previous | Назад |
| review.next | Next | Далее |
| review.page | {from}–{to} of {total} | {from}–{to} из {total} |
| review.workersClass | Workers by task class | Воркеры по классам задач |
| review.touched | Tasks touched | Задачи с участием воркера |
| review.smallSample | Small sample | Мало данных |
| review.execution | Execution | Выполнение |
| review.decision | Human decision | Решение человека |
| review.failed | Failed | Ошибка |
| review.cancelled | Cancelled | Остановлен |
| review.noDecision | No recorded decision | Решение не записано |
| review.attempt | Attempt {n} | Попытка {n} |
| review.relaunch | Relaunch | Перезапуск |
| review.triggerUnknown | Trigger unknown | Причина запуска неизвестна |
| review.openRun | Open run | Открыть запуск |
| review.compare | Compare all attempts | Сравнить все попытки |
| review.back | Back to Review | Назад к итогам |
| review.backTask | Back to task history | Назад к истории задачи |
| review.taskHistory | Task history | История задачи |
| review.allAttempts | All attempts shown | Показаны все попытки |
| review.cumulative | Cumulative across attempts | Суммарно по попыткам |
| review.expand | Expand | Развернуть |
| review.legend | Legend | Обозначения |
| review.overview | Step overview | Обзор шагов |
| review.ledger | Step ledger | Журнал шагов |
| review.sampled | Overview sampled | В обзоре показана выборка |
| review.input | Input tokens | Входные токены |
| review.output | Output tokens | Выходные токены |
| review.cacheRead | Cache read | Чтение из кеша |
| review.cacheWrite | Cache write | Запись в кеш |
| review.usageTime | Usage over time | Расход по времени |
| review.breakdown | Breakdown by step | Расход по шагам |
| review.unattributed | Unattributed usage | Расход без привязки к шагу |
| review.noStepUsage | No step-level usage recorded | Расход по шагам не записан |
| review.approximate | Approximate | Приблизительно |
| review.latest | Jump to latest | К последним шагам |
| review.stepsMissing | Run summary available; step history unavailable. | Сводка запуска есть; история шагов недоступна. |

Legend labels are specified in F1. Remaining ordinary controls reuse existing translations (Tasks, Runs, All, Close, Loading); full error explanations must be localized rather than embedding English server text as the only user-facing message.

## 4. Host/core data contracts and files to change later

These are proposed changes only. Preserve existing consumers through additive fields/versioning; do not force old logs into falsely precise new fields.

| Contract | Required fields/behavior | Implementation files |
| --- | --- | --- |
| Identity and billing | Per run `rawAgent`, `canonicalWorkerId`, resolved `model`, provider, billing mode, identity-resolution provenance. Snapshot at launch; legacy resolution confidence. Aggregate by canonical identity/model/billing, preserve aliases. | `packages/core/src/routing/identity.ts`; `core/src/plan/schema.ts`; `core/src/orchestration/launch.ts`; `core/src/cost/cost.ts`; `plugin/src/host/actions.ts`; `plugin/src/shared/types.ts` (all under `packages/`) |
| Metric availability | Per-metric `{value, state, observedAt, source, final}`; token input/output/cacheRead/cacheWrite/reasoning and explicit inclusion semantics. Partial totals include known/eligible/pending counts. | `packages/core/src/backend/types.ts`; `core/src/runs/cli-runner.ts`; `core/src/runs/cli-backend.ts`; `core/src/dsh/backend.ts`; `core/src/cost/run-usage.ts`; `core/src/cost/cost.ts` |
| Cash versus estimate | Distinct cash and API-equivalent fields, currency, price basis/version/model, source record ID; no overloaded `usd` without provenance. Preserve cache-write tokens used in estimated cost. | `packages/core/src/cost/claude-transcripts.ts`; `core/src/cost/dsh-bill.ts`; `core/src/cost/cost.ts`; `core/src/backend/types.ts` |
| Quota measurements | Stable sample ID, account key (non-secret), provider, window ID/start/reset/end, before/after timestamps, raw values/resolution, reset/discontinuity marker, exclusive/shared attribution. Retain raw precision until presentation. | `packages/core/src/cost/codex-quota.ts`; `core/src/cost/claude-limits.ts`; `core/src/plan/schema.ts`; `core/src/cost/cost.ts`; launch/finish paths |
| Decisions and review intervals | Stable event ID, task ID, optional run ID, entered-review time, decision time/kind/verdict/reason/source, association confidence. Keep execution status distinct. Old ambiguous notes remain task-level; missing history is flagged. | `packages/core/src/plan/schema.ts`; `core/src/orchestration/review.ts`; `core/src/orchestration/relaunch.ts`; orchestration finish/reconcile writer; `plugin/src/host/actions.ts` |
| Task summary | Task class/lane/current state, all run IDs and stable attempt indexes, attempt parent/trigger, task elapsed, worker sum, union review wait, separated cumulative accounting and coverage. Use historical class at run time if available; label current-class fallback. | `packages/plugin/src/shared/types.ts`; `plugin/src/host/actions.ts` (`GET cost`/task); `packages/core/src/cost/cost.ts`; proposed `packages/core/src/cost/review-summary.ts` |
| Plan progress | `planId`, `rev`, `generatedAt`, explicit/inferred completion, scope history, acceptance/return lifecycle events with counts and completeness. Distinguish accepted result/negative/disputed/superseded. | `packages/core/src/plan/schema.ts`; plan mutation/lifecycle writers; `packages/plugin/src/host/actions.ts`; shared types; proposed review-summary module |
| Ledger/v5 | Stable step/span ID, parent/turn/run IDs, typed kind, start/end, exact/approximate/open state, summary/result/error, detail availability; explicit total count/cursor/truncation. Overview references step IDs and has bounds, exact counts, sampling metadata. | `packages/core/src/runs/raw-event.ts`; `core/src/runs/normalize.ts`; `core/src/runs/trajectory.ts`; `plugin/src/host/actions.ts` (`GET trace`); shared types |
| Usage events | `{id, runId, at, stepId?, callId?, metric, delta, cumulative?, source, quality}`; distinguish delta from cumulative reports; dedupe by source ID. Do not synthesize historical step costs from total/time. | `packages/core/src/runs/cli-parse.ts`; `core/src/runs/cli-runner.ts`; backend adapters; `core/src/cost/claude-transcripts.ts`; `core/src/cost/dsh-bill.ts`; proposed `core/src/cost/usage-series.ts`; host trace/usage response |
| Efficient summary/detail reads | Summary response contains lightweight runs/task aggregates and coverage, no full event payload. Detail addressed by repo+plan+task+run; validate ownership. Completed-run cache keyed by source revision/fingerprint; active snapshot refresh. Detail cursor/seek APIs and explicit retained-history bounds. | `packages/plugin/src/host/actions.ts`; `plugin/src/shared/types.ts`; `plugin/src/client/api.ts`; core summary/trajectory modules |

Suggested response separation (names illustrative, semantics normative):

```text
GET cost(repo, plan)
  schemaVersion, planId, rev, generatedAt, historyCompleteness
  planMetrics, accountingByKindAndWindow, tasks[], runSummaries[], workerGroups[]
GET trace(repo, plan, task, run, cursor?, seekStepId?)
  header, overview, steps[], totalSteps, nextCursor, retainedRange, completeness
GET run-usage(repo, plan, task, run, cursor?)
  totalsByKind, events[], attributed, unattributed, coverage, nextCursor
GET task-review(repo, plan, task)
  task, allRunSummaries[], decisions[], reviewIntervals[], cumulative, coverage
```

At 500 runs, one cached lightweight summary supports client-side filtering/paging; do not require server paging before it is useful. Detail paging is required to avoid the existing silent `MAX_SPANS` tail cut. If summary payload or latency fails the measured target, introduce server-side filtered pagination with snapshot ID and separate full-result aggregates; do not move filtering to the page only.

Frontend implementation touchpoints: `views/review.tsx`, `views/economics.tsx`, `insight.ts`, `styles.ts`, `app.tsx`, `panel/task-panel.tsx`, `panel/run-trace-panel.tsx`, v5 ledger component, `api.ts`, and both dictionaries. v5 owns step rendering, seeking, overview and step details; Review owns metric header, accounting, task comparison and navigation. Agree stable IDs and usage hooks before either implementation. There was no v5 implementation/spec file found in this checkout's docs; this defines its required integration contract, not a claim that those capabilities already exist.

### Accounting invariants and implementation checks

- Alias fixtures collapse `claude-opus`/`claude/opus` while retaining distinct resolved models and billing modes; run IDs are counted once. Plan/task/worker totals reconcile under explicitly stated overlapping task denominators.
- A running run before first usage displays pending; after a measured zero it displays zero with timestamp. A nonzero live snapshot advances without plan revision change. Switching repo cancels stale reads.
- Failed, cancelled, completed, returned and relaunch remain distinguishable. Final acceptance is never attributed automatically to every prior attempt. Two overlapping waits union correctly; ambiguous legacy waits stay incomplete.
- Parallel runs with the same quota samples count each window observation once. Reset and missing samples do not become a positive “spend.” Cash, equivalent and quota never share an arithmetic total or heterogeneous sort.
- Leaf usage plus residual reconciles to each known run total; parent rollups are not double counted. Final-only usage produces no invented curve. Missing historical steps have a visible explanation.
- Every one of 500 runs is reachable by page, search and keyboard. Group paging and task comparisons retain all attempts; count/aggregate scope remains clear. Exact run and selected step survive Back and refresh.
- Run→task comparison→run→Review works at 1440/1100 in EN/RU; headers contain all mandatory metrics, full errors remain readable, table numbers align, no page-wide horizontal overflow, and full titles are accessible.
- Visual verification still needed on the authorized stand: screenshots for all four width/language combinations, panel open/closed, run expanded, task comparison, empty/partial/pending states; record viewport height, font/zoom, overflow bounds, row heights, keyboard focus and performance. None is reported as passed by this audit.

## 5. Comparisons and what is borrowed

**Local Cost/Economics:** `packages/plugin/src/client/views/economics.tsx:119` separates budget and time into question-oriented blocks; `:125` uses a sentence answer; `:171` links to the timeline. Borrow the explanation-before-table pattern and explicit accounting distinction. Do not borrow forecast spend as a budget limit or inherit the raw-agent aggregation defect. These are source comparisons of the repository's retained implementation, not proof that old tabs remain mounted in v4 (`app.tsx:300` mounts Graph/Work/Review).

**Local Trajectory/Timeline:** `views/timeline.tsx:49` has an axis and task-relative run/review/dependency segments; `panel/trace.tsx:146` exposes step details and approximation. Borrow chronological context and drill-through, but use v5's readable ledger as the primary run view. Do not reuse inferred dependency wait as a measured cause of total delay, or silently truncate history.

**LangSmith:** borrow typed filter chips and explicit trace/run scope from its [official filtering guide](https://docs.langchain.com/langsmith/filter-traces-in-application). Review maps scope to Tasks/Runs and offers duration/status/class filters rather than asking people to scan every row. Do not expose a query language in the first version.

**Braintrust run tables:** borrow table→detail navigation, task metadata grouping, and selectable table density/columns from [View your logs](https://www.braintrust.dev/docs/observe/view-logs). In this product the natural group is a task with multiple attempts; group identity must survive filtering.

**Braintrust trace detail:** borrow right-panel detail with main-area expansion, chronological and hierarchical views, and inline duration/token/cost metrics from [Examine traces](https://www.braintrust.dev/docs/observe/examine-traces). Its documented token breakdown includes cache reads/writes; Review should preserve these dimensions too. Adapt the metric view to this product's cash-versus-subscription accounting; never imply that estimated LLM cost is a cash invoice.

## 6. Leave out

- A single grand “total cost”: cash, API equivalence and quota have different meanings and units.
- A “best worker” leaderboard across task classes, routing difficulty or tiny samples: observational results cannot establish general superiority.
- An automatic finish-date forecast or blame score for the owner: missing lifecycle and dependency-critical-path evidence cannot support either.
- A second full trace implementation in Review: v5 supplies the ledger in both panel and main area.
- Full prompts, raw events and hundreds of ticks in every index row: noise, payload and keyboard burden; load on demand in the ledger.
- Synthetic per-step dollars or token estimates proportional to duration: they look precise without supporting measurements.
- Sum of provider quota percentages across accounts/windows or overlapping attempts: no meaningful common denominator.
- Fixed subscription fee allocation per task without an explicit allocation policy: false marginal costs.
- Infinite scroll, arbitrary custom dashboards and SQL/query-language controls in this iteration: 50-row pages, facets and two drill-down levels meet the 500-run requirement with clearer navigation.
- Accept/return/relaunch bulk actions in Review: keep operational controls in Work/task panel; this redesign is for explanation and inspection.
- A convergence chart for legacy plans with no scope/decision history: show current progress and a clear history limitation instead.

## Recommended implementation order

1. Correct identity, availability, outcome and human-wait contracts before using them to guide decisions.
2. Separate recorded cash, API-price equivalents and attributable quota throughout the UI.
3. Deliver the two detailed destinations: run header + v5 ledger/usage breakdown, and task comparison across every attempt.
4. Replace the unbounded list with a filterable, grouped, paginated evidence index that preserves navigation state.
5. Rebuild summary hierarchy and class-based worker comparison, then perform the blocked EN/RU × 1440/1100 visual checks.
