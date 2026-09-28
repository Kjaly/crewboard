Result: received — independent live-browser pass against the real built plugin stand at `http://127.0.0.1:4642` (build `mulga8od-r0utyo`), session `crewboard-nav-evidence-28`, viewports 1440×900 and 1000×800. Baseline left workspace column: `/tmp/nav28-shots/01b-wide-1440.png` (1440×900; rail = 248 px, 13 project groups, 2 of them duplicate `repo · missing`); the collapsed live tree is `/tmp/nav28-shots/11-collapsed-all.png`, and the shipped capture `docs/assets/sidebar-needs-you.png` (496×1800 = 248 CSS px @2x) is the only artifact showing the same rail inside the real dsh left workspace column (its 2 mocked projects, not the 13 live groups). Everything below is either a source citation (`file:line`) or a reproducible browser observation with the artifact named. No user interviews were performed and none are implied; persona cases in §2.9 are explicitly simulated.

# Navigation evidence audit — Assessment B (2026-09-28)

## 0. Scope and method

- **Owned file:** this document only. Source read-only; no plan JSON, settings, product code, or agent messages were written. The live browser pass changed one shared pointer as a side effect of the required navigation test and that pointer was restored (§2.7).
- **Independent of Assessment A:** I did not read its files, events, or report. Detector findings stay in this report (§4).
- **Targets read:** `packages/plugin/src/client/sidebar.tsx`, `sidebar-model.ts`, `sidebar-lanes.tsx`, `lane-tree.ts`, `store.ts`, `app.tsx`, `route.ts`, `api.ts`, `process-status.tsx`, `waiting.ts`, `summary.ts`; `packages/core/src/orchestration/snapshot.ts`, `needs-you.ts`; `packages/core/src/plan/graph.ts`, `plans.ts`, `schema.ts`; `packages/plugin/src/host/service.ts`, `actions.ts`, `routes.ts`, `packages/plugin/scripts/stand.mjs`; shipped screenshot `docs/assets/sidebar-needs-you.png`.
- **Not a full-pipeline run:** the requested checks are docs checks only (§7); no build/test suite was run, and no product source was modified.
- **No extra dependencies** were installed for this audit.

## 1. Runtime under audit and what the stand does *not* represent

The stand (`packages/plugin/scripts/stand.mjs:1-111`) runs the **real host** (`lib/index.js`) against the owner's real repositories, serves the routes it registers with a plain HTTP server, and mounts the **real built client** (`lib/client.js`) in a page that plays the shell.

Browser pass facts:

| Fact | Value |
|---|---|
| URL | `http://127.0.0.1:4642/` |
| Served bundle | `/stand/client.js`, 359 267 bytes |
| Host build id | `mulga8od-r0utyo` (`OrchestraSnapshot.build`) |
| Sample snapshot | `2026-09-28T16:32:46.748Z`, 51 `repos`, 23 plans, 34 workers |
| Server working dir | `/Users/kjaly/WebstormProjects/dsh-orchestra` (root worktree; server belongs to root and was left running/untouched) |
| My worktree HEAD | `093bcc49…` — identical to the server checkout's HEAD; `sidebar.tsx`, `sidebar-model.ts`, `store.ts`, `app.tsx`, `snapshot.ts` byte-identical between the two |
| Browser sessions | only `crewboard-nav-evidence-28`; closed at the end (`No active sessions`) |

**Sandbox limitation (exact):** the first launches failed with `Socket directory '/Users/kjaly/.agent-browser' is not writable: Operation not permitted (os error 1)`; the one-shot escalation to `danger-full-access` was rejected. The audit then proceeded inside the allowed sandbox using only documented runtime variables — `AGENT_BROWSER_SOCKET_DIR=/tmp/nav28-ab/sock`, `--profile /tmp/nav28-ab/profile`, `--args --no-sandbox` — with **no HOME override** in the sanctioned pass. (The very first baseline `01-wide-1440.png` was captured before this correction using a temporary `HOME`; it is superseded by `01b-wide-1440.png` from the sanctioned session and is not cited as evidence.)

**What the stand cannot represent (so no claim below depends on it):**

- The dsh shell itself: no left "Workspaces" cell, no dsh title bar, no dsh command palette, no dsh tab host, no dsh Settings dialog. The shipped screenshot `docs/assets/sidebar-needs-you.png` is the only artifact that shows the plugin inside the **actual dsh left workspace column**; the stand shows the same rail content in an otherwise empty page.
- React is loaded from a CDN (`stand.mjs:61-62`) instead of the shipped bundler, so dev-only warnings differ.
- Host side effects are neutered: `native.confirm` always refuses (`stand.mjs:50-53`), `notify` is a no-op, `tools.register`/`systemPrompt.section` are no-ops (`stand.mjs:47-48`), and `sessionController.modelCatalog` exists only if `--dsh-catalog` was passed (`stand.mjs:45`). So the stand can never accept/merge, and worker-sign-in states are not exercised.
- The live snapshot contains **0 example plans** (`.value.repos[].plans[] | select(.example)` = 0), so the tour/example divider, the example inbox row and `welcome` example flow were **not** live-exercised; only the shipped screenshot shows them.
- The host refreshes every repository on an interval (`service.ts:262`), so the data is live and time-stamped; every observation below names its artifact.

## 2. Browser evidence (viewports, screenshots, exact bounded reproduction)

### 2.1 Three-project navigation (wide 1440×900)

**Repro:** open `/` at 1440×900; the rail renders 13 groups, of which 3 real repositories are expanded by default (`dsh-orchestra`, `gaalo-studio-backend`, `cabinet-planner`) plus `gaalo-studio-frontend`/`gaalo-harness`/`newsroom-guard` collapsed and 7 `· missing` scratch folders.

- Observed groups and their live plans: `dsh-orchestra` (1 plan, `2 running`), `gaalo-studio-backend` (3 live plans, each marked `· worktree`, plus `3 finished plans` and `Archive · 1`), `cabinet-planner` (current plan expanded into lanes `Now · 1` / `History · 90`, plus 2 more plans and `2 finished plans`).
- Default expansion rule is `defaultGroupOpen` = current folder OR `waiting > 0` OR `running > 0` (`sidebar-model.ts:198-199`, used at `sidebar.tsx:1028`). That is why exactly those three are open in the baseline.
- Artifacts: `/tmp/nav28-shots/01b-wide-1440.png`, `/tmp/nav28-shots/10-frontend-expanded.png`, a11y tree of `.orc-plans` (icons `◌`/`▣`/`◇`, `treeitem` levels 1-3).
- Native cross-check: `docs/assets/sidebar-needs-you.png` shows the same rail/row shape inside real dsh for its 2 mocked repositories plus one example plan (`acme-api`, `acme-web`).

### 2.2 Expanded trees and folds

**Repro:** click a collapsed group row (fold-only; see §2.3) — e.g. `gaalo-studio-frontend` — and inspect.

- Expanded `gaalo-studio-frontend` renders 3 plan rows (all `· worktree`), `1 finished plan`, `Archive · 1`; the two plans from the *same* worktree copy `harness-step4-fe` render as separate rows with distinct goals.
- Collapsing all 13 groups shows every group as a single row (`/tmp/nav28-shots/11-collapsed-all.png`); inner folds (`3 finished plans`, `Archive · 1`, `Now · 1`, `History · 90`) are `role=treeitem` with `aria-expanded` (`sidebar.tsx:997-1022`).
- A11y: the tree is `role="tree"` with nested `role="treeitem"` rows; the browser computes levels 1-3 from nesting. Rows do **not** set `aria-level`/`aria-setsize`/`aria-posinset` explicitly (measured `aria-level` is absent); screen readers that do not infer from nesting lose position-in-set.

### 2.3 Active vs inactive projects

**Repro:** at 1440×900 keep `gaalo-harness` current, then collapse its group.

- The **current plan row** carries `aria-current="true"` and the selected row style (`sidebar.tsx:948-952`; measured `[aria-current=true]` on the cabinet current plan / `/tmp/nav28-shots/01b-wide-1440.png`).
- The **collapsed current project has no in-tree marker**. Measured on collapsed `gaalo-harness`: group glyph class is `orc-srow__slot orc-srow__glyph` (no `--active`), the group row has no `aria-current`, and the only current marker is the slim-rail badge (`orc-plans__badge--current`, `aria-current="true"`) which is hidden whenever the wide rail is open. `orc-srow__glyph--active` is gated on `open && isCurrentGroup` (`sidebar.tsx:1073`). So "you are here" disappears when you collapse the project you are in.
- **Inactive groups** expose only their aggregated status: `agg = !open || plans.length === 0 ? statusLabel(groupCounts(group)) : ''` (`sidebar.tsx:1039`), so a collapsed group with running/failed work still shows one mark; an inactive one shows none. Measured: `hasMark` true for `dsh-orchestra`, `gaalo-studio-backend`, `cabinet-planner`; false for `gaalo-harness`, `gaalo-studio-frontend`, all missing folders.
- Collapsed groups with no plans and no work show no mark; missing folders show `· missing` inline (`sidebar.tsx:1081`, `isQuietRepo` keeps them visible — `sidebar-model.ts:48-53`).

### 2.4 Missing, duplicate and test-repo noise

**Repro:** at 1440×900, collapse all groups; read the `Repositories` tree.

- 7 of 51 repos are `missing: true`; all 7 render as tree rows with `· missing`: `dsh-smoke-repo`, `cl2-smoke`, `testrepo`, `repo`, `repo`, `tarball-repo`, `harness-panel` (`/tmp/nav28-shots/11-collapsed-all.png`, measured `missingMarkers: 7`).
- **Two adjacent rows are byte-identical in their visible label: `repo · missing`.** Their only difference is the `title` tooltip, which carries the full path (measured):
  - `/private/tmp/claude-501/-Users-kjaly-WebstormProjects-dsh-orchestra-orch-rp1/…/scratchpad/repo`
  - `/private/tmp/claude-501/-Users-kjaly-WebstormProjects-dsh-orchestra-orch-sz1/…/scratchpad/smoke/repo`
  - The name comes from `groupRepos` (`sidebar-model.ts:181`): `first.repo.family?.name ?? displayName(first.repo)`, and for a missing path the host sets `family.name = basename(root)` (`service.ts:190`) = `repo`. Nothing appends a path suffix on collision.
- No aggregation counts these: they are excluded from every inbox/`waitingCounts` path (`needs-you.ts:112` skips `hidden` only; a missing repo has `tasks: []` so it simply never contributes). Missing is *explicit per row* but never *counted anywhere*, so an overview cannot say "7 listed folders are gone".

### 2.5 Name alignment

**Repro:** at 1440×900 measure `getBoundingClientRect().left` of every `.orc-srow__name`.

- Repo names, plan names and fold labels all start at **x = 43 px** (rail 248 px). Lanes indent: `Now · 1` at 59 px, `FULL-CYCLE` at 77 px. This matches the native screenshot (`acme-api`/`acme-web` labels and their plan labels share the same x; cropped: `/tmp/nav28-shots/native-repos-zoom.png` vs `/tmp/nav28-shots/stand-tree-zoom.png`).
- Consequence: the plan row's leading empty slot and the group row's glyph+chevron slots are laid out so names align; there is no misalignment defect here. The only alignment-looking risk is truncation: long goals ellipsize (`text-overflow`) and lose the distinguishing tail, while the repo label does not truncate at this width.

### 2.6 Per-plan identity with the same IDs

**Repro:** at 1440×900 press `⌘K`, type `main`; then inspect the live snapshot.

- 15 plans across the installation share id **`main`**, including **7 in the `gaalo-studio-backend` family group** (`ap-a`, `ap-b`, `ap-int`, `assistant-slots`, `format-access`, `harness-step4`, `model-pipelines`) and **4 in the `gaalo-studio-frontend` group** (`.worktrees/ap-fe`, `ap-fe-p3`, `formats-p1`, `harness-step4-fe`). No two plans in one family share a goal, so goals disambiguate today by accident of content, not by identity.
- Search hit keys/labels use only `plan.id` + `plan.goal`, and the hint is `displayName(repo)` (`sidebar-model.ts:338`). For worktree copies that resolves to the copy basename (measured hints `harness-step4`, `formats-p1`, `model-pipelines`, …), which *does* disambiguate copies in search. But the tree row itself shows only `plan.goal` + `· worktree` (`sidebar.tsx:959,965-969`); the copy path lives only in the tooltip. Two worktree copies with the same goal would be visually identical.
- **Search truncates silently at 10.** `SEARCH_LIMIT = 10` (`sidebar-model.ts:324`, applied `:347`); the `main` query matches 15 plans but renders exactly 10 rows and no “N more”, so 5 same-id plans are unreachable from global search (`/tmp/nav28-shots/03-search-main.png`).
- Keyboard proof of identity/selection: `ArrowDown`×2 moved the active hit to index 2, `Enter` opened it; URL became `#orchestra/…/gaalo-harness/main/graph` and the breadcrumb updated (`/tmp/nav28-shots/04-search-enter.png`).

### 2.7 Keyboard, search (⌘K), and memory restoration

**⌘K:** with the wide rail *closed*, pressing `Meta+k` set `orc-root--rail-open` and focused `.orc-side__search` (measured `document.activeElement.className === "orc-side__search"`, `/tmp/nav28-shots/02-cmdk-open.png`). Handler: `app.tsx:234-241`. On narrow it reopens the overlay and focuses the field identically (`/tmp/nav28-shots/13-narrow-cmdk.png`). Outside-click on narrow closes it (measured class back to `orc-root--rail-shut`), and `Escape` closes it when focus is not in the search input (`sidebar.tsx:798-817`).

**Memory restoration (reload):** set `Detailed` density, selected graph task `h2`, collapsed the `gaalo-harness` group; reloaded; all three survived plus the route and rail state:

| Persisted key (measured after reload) | Value |
|---|---|
| `crewboard:route:/Users/kjaly/WebstormProjects/gaalo-harness` | `#orchestra/…/gaalo-harness/main/graph/h2` |
| `crewboard:repo` | `/Users/kjaly/WebstormProjects/gaalo-harness` |
| `crewboard:density:<root>:main` | `detail` |
| `crewboard:task:<root>:main` | `h2` |
| `crewboard:side-folds` | `{"grp:/Users/kjaly/WebstormProjects/gaalo-harness":false}` |
| `crewboard:plans-open` | `1` |

After reload: `aria-pressed="true"` on task `h2`, `Detailed aria-checked="true"`, group `aria-expanded="false"` (`/tmp/nav28-shots/05-before-reload.png`, `06-after-reload.png`, `07-task-selected.png`, `08-task-restored.png`). Keys/line refs: `store.ts:72,94-103`; per-plan maps `store.ts:52-57`; folds `sidebar-model.ts:237-253`; rail `app.tsx:43-57`.

**Navigation side effect (important):** `Enter` on a plan search hit calls `goHit → orchestraStore.openPlan` (`sidebar.tsx:789-794`, `store.ts:496-503`), whose `applyRoute` POSTs `/crewboard/api/plan-use` whenever `repo.planId !== route.plan` (`store.ts:289-296`). My `main` test therefore changed `gaalo-harness`'s shared current pointer from `step5` to `main` (verified: `.../gaalo-harness  main`). I restored it to `step5` with the same endpoint and re-verified (`/crewboard/api/state` → `step5`). This is exactly the class of write a global project switcher must avoid (§5.2). Same path is taken by `pickPlan` (`sidebar.tsx:769-775`) and by every inbox row via `openWaiting` (`store.ts:563-584`).

**Current-plan-only search:** with `gaalo-harness` current on `step5`, searching a task title that belongs to the background `main` plan (`хранилище`) returned **no task hit** (`[]`), because `searchSnapshot` only walks `repo.tasks` — the current plan's tasks (`sidebar-model.ts:340-342`; `RepoSnapshot.tasks` is the current plan only). So background-plan tasks are invisible to global search by construction.

**Console:** `agent-browser console` and `agent-browser errors` were empty after the whole pass (no runtime errors, no unhandled rejections).

### 2.8 Narrow viewport (1000×800)

**Repro:** set viewport 1000×800.

- `matchMedia('(max-width: 1100px)')` is true; the slim rail is 44 px and `.orc-plans__wide` is `position: absolute` overlaying content with no scrim (`/tmp/nav28-shots/12-narrow-1000.png`, full-height `12b-narrow-full.png`). The slim rail shows the project initials column (`C G C G N C T R R T H`), matching the design intent of `sidebar.tsx:1215-1237`.
- The overlay covers the task panel rather than pushing it; opening it via a row click is closed automatically on narrow (`pickPlan` → `onToggle`, `sidebar.tsx:774`). `⌘K` and outside-click behave as in §2.7.

### 2.9 Simulated persona cases (clearly labelled — no interviews)

These are **simulated** readings of the live tree, not user research. Each has the exact repro above; no quotes, no invented users.

- **P1 “Three live projects” (simulated):** operator with `dsh-orchestra`, `gaalo-studio-backend`, `cabinet-planner` open. They can see three expanded trees at once and their per-project status marks; they cannot see, without expanding, which of the 7 `gaalo-studio-backend` worktree copies owns a given `main` plan.
- **P2 “Scratch-repo noise” (simulated):** operator with 7 dead `/private/tmp/**` folders listed. They can identify each as `missing` but cannot tell the two `repo · missing` rows apart without hovering, and no overview tells them 7 folders are gone.
- **P3 “Returning after a reload” (simulated):** operator returns to the same repo/plan/task/density/fold; all are restored exactly (§2.7). What is *not* restored: graph pan/zoom (§3.6) and scroll positions.
- **P4 “Background plan needs me” (simulated):** operator working on one plan while another project's background plan finishes. The inbox correctly reports background-plan waits as summary rows (`needs-you.ts:158-181`), but a background plan that is only *being orchestrator-checked* is reported as nothing (it is filtered out of `waitingHuman` by `waitsForHuman`), and there is no “checking” count for it anywhere in the sidebar.

## 3. Technical inventory (source-backed)

### 3.1 Snapshot and `PlanSummary` fields

`RepoSnapshot` (`packages/core/src/orchestration/snapshot.ts:98-138`) carries `root`, `goal`, `title?`, `hasPlan?`, `planId?`, `archived?`, `plans?: PlanSummary[]`, `rev`, `updatedAt`, `lastActivityAt?`, `tasks[]` (current plan only), `ready`, `criticalPath`, `attention[]`, `degraded`, `error?`, `errorCode?`, `example?`, `orchestratorCheck?`, `defaultBase?`, `partial?`, `draftsStamp?`.

`PlanSummary` (`snapshot.ts:140-153`) = `PlanInfo` (`plan/plans.ts:5`: `id, goal, archived, current, rev, updatedAt, taskCount, example?`) **plus** `running`, `inReview`, `waitingHuman`, `decisions?`, `ready`, `accepted`, `closed?`, `unmerged?`, `attention[]`. The plugin adds `chat?`, `suggestion?`, `effectiveRouting?` (`shared/types.ts:38`) and `RepoSnapshot` adds `effectiveRouting?`, `family?`, `pinned?`, `hidden?`, `sources?`, `worktreeOf?`, `missing?` (`shared/types.ts:39-53`).

Every field is already computed for **all** plans on every refresh: `summarizePlans` loops `listPlans(root)` and syncs each non-archived non-current plan (`snapshot.ts:156-187`).

### 3.2 `running` / check-pending / checking / finalizing / human attention — where each truly lives

- **running:** `PlanSummary.running` = tasks with `ViewStatus 'running'` (`snapshot.ts:184`); the current plan also has `TaskSnapshot.status`. The “Work progress” strip counts `repo.tasks` with `status === 'running'` (`process-status.tsx:23`).
- **check pending / checking:** **not in `PlanSummary`.** They exist only on the current plan's `TaskSnapshot.check` (`CheckState = 'pending'|'checking'|'checked'`, `plan/schema.ts:281-282`) and are derived for the strip as `status === 'in_review' && (check === 'pending' || 'checking')` (`process-status.tsx:24`). The label is “Awaiting check” when none is actively checking and “Orchestrator check” when at least one is (`process-status.tsx:59-62`; `dict/en.ts:670-671`).
- **finalizing:** **not a stored state at all.** The strip's `close` stage is derived as `orchestratorMerging(task) || orchestratorClosing(task)` where both require the plan chat awake, `check === 'checked'`, and a positive non-caution verdict (`process-status.tsx:10-18,21-27`); label `process.close` = “Finalizing” (`dict/en.ts:672`).
- **human attention:** `PlanSummary.waitingHuman` = `waitsForHuman(...)` over derived views (`snapshot.ts:183`), where `waitsForHuman` is `in_review` and not checking/checked, or a `ready` decision that is not `preparing` (`plan/graph.ts:54-63`). `decisions?` is the decision subset. `attention[]` is `gatherAttention` where eligible.
- The live baseline showed the strip as `Running 0 · Orchestrator check 1 · Finalizing 0` for `cabinet-planner` (`/tmp/nav28-shots/01b-wide-1440.png`), which is the only true, derived-from-data rendering of those words.

### 3.3 Current vs non-current plan visibility

- Only the **current** plan's `tasks[]`, `ready`, `criticalPath`, `attention[]`, `orchestratorCheck`, `defaultBase`, `draftsStamp` and `check` states are in the snapshot; background plans are `PlanSummary` rows only.
- The UI only unfolds lanes for the current plan: `laneChild = current && props.lanes ? firstLaneGroupKey(repo) : undefined` (`sidebar.tsx:936`), so a background plan can never show lanes or task-level check states.
- The inbox reports a background plan as **one** summary row keyed by counts (`needs-you.ts:158-181`), and `waitingCounts` weights it by the tasks it stands for (`needs-you.ts:223-233`).
- Search covers background plans as plan rows but only the current plan's tasks (`sidebar-model.ts:336-342`).

### 3.4 Is there a read-only explicit plan snapshot API?

**No.** The full-state read is `GET /crewboard/api/state` (`host/routes.ts:40-44`) plus the SSE stream `GET /crewboard/api/events` (`host/routes.ts:54-71`). All other GETs are keyed by repo/task/run (`host/actions.ts: get(...)` list: `task`, `task-review`, `cost`, `trace`, `runs`, `diff`, `file`, …) and read the repository's current plan. The only way to get another plan's task-level data is `POST /crewboard/api/plan-use` (`actions.ts:1387-1390` → core `openPlan`), which **mutates the shared current-plan pointer** for non-archived plans (`plan/plans.ts:setCurrentPlan`). There is no `plan-state`/`plan-snapshot` endpoint. Client mirror: `api.state()` (`api.ts:70`), `api.planUse()` (`api.ts:120`), no per-plan read.

### 3.5 Physical worktree family grouping and canonical naming

- The host resolves a family per root (`service.ts:227-231`), canonicalizing the main checkout's spelling so `/tmp` vs `/private/tmp` line up; `missing` roots get `family = { root, name: basename(root) }` (`service.ts:190`).
- The sidebar groups by `family?.root ?? root` and names the group `family?.name ?? displayName(first.repo)` (`sidebar-model.ts:166,181`). Worktree copies are **not** a level of their own; each plan row is tagged `· worktree` when `worktreeOf` exists or `family.root !== root` (`sidebar.tsx:201,968`), and the copy path is in the row tooltip (`sidebar.tsx:959`).
- Live proof: 7 backend copies and 4 frontend copies merged into one row each (`/tmp/nav28-shots/10-frontend-expanded.png`, `/tmp/nav28-shots/01b-wide-1440.png`).

### 3.6 Persisted memory inventory, and the gaps

| Concern | Persisted? | Where |
|---|---|---|
| Repo | yes | `crewboard:repo` (`store.ts:102,204`) |
| Route per repo (view/task/tab/run/step/draft/lens/lane) | yes | `crewboard:route:<root>`, `formatRoute`/`parseRoute` (`route.ts:23-52`; `store.ts:103`) |
| View per plan | yes | `crewboard:view:<root>:<plan>` (`store.ts:94`) |
| Density per plan | yes | `crewboard:density:<scope>` (`store.ts:95`) |
| Task selection per plan | yes | `crewboard:task:<scope>` (`store.ts:96`) |
| Lens per plan | yes | `crewboard:lens:<scope>` (`store.ts:97`) |
| Sidebar folds | yes | `crewboard:side-folds` (`sidebar-model.ts:237-253`) |
| Rail open/closed | yes | `crewboard:plans-open` (`app.tsx:43`) |
| Sidebar row order | host-side | `snapshot.order` + `api.sideOrder` (`sidebar.tsx:487-495`) |
| **Graph camera pan/zoom** | **no** | entirely in-memory `createCamera()` (`views/graph/camera.ts:67-380`); no storage call, no `pose` persistence; `pose()/restore()` only serves lens toggling |
| **Scroll positions** | **no** | Review list scroll is a ref (`app.tsx:76,196-197`), graph/tree scroll not stored |
| **Drafts** | partial | selected draft is in the route (`draft` param) but there is no per-plan draft memory; drafts are re-fetched by `draftsStamp` (`app.tsx:138-150`) |

### 3.7 Authoritative states vs data unavailable

- Authoritative and already global: per-plan `running`, `waitingHuman`, `decisions`, `ready`, `accepted`, `closed`, `unmerged`, `attention[]`, `archived`, `current`, `example`, `taskCount`, `updatedAt`.
- **Unavailable for a background plan:** task-level `check` (`pending`/`checking`/`checked`), `preparing`, `unmerged` per task, `stalledMin`/`runningMin`/`command`, verdict briefs, conflicts, `byOrchestrator`. Any global “Now” that needs those must either (a) accept “unavailable” for background plans, or (b) add a read-only per-plan read (which is not free — §6).
- **Absent concepts:** there is no `finalizing` field, no orchestrator heartbeat, and no external-chat liveness signal. The only freshness signals are `snapshot.generatedAt`, the SSE push, and `connection` (`store.ts:14,35,670`). A global aggregator must not synthesize an “orchestrator alive” pulse from anything else.
- **Explicitly not zero:** missing folders are shown per row but never counted; a background plan that is only under check contributes nothing to `waitingHuman`; a plan whose summary read failed has `running/ready/... = 0` (`snapshot.ts:178-180` catch leaves `views` undefined and counts 0) — indistinguishable from a genuinely empty plan unless the reader treats “not observed” as distinct. `ReviewCoverage.known === 0` documents exactly this discipline for Review (`shared/types.ts:79-81`); the sidebar has no equivalent flag.

## 4. Detector (impeccable)

Run exactly once as instructed:

```
/Users/kjaly/.codex/skills/impeccable/scripts/impeccable detect --json packages/plugin/src/client/sidebar.tsx
exit=0, stdout=[]  (no findings)
```

No detector findings to report.

## 5. Recommendations — global Now and the project switcher

Constraints honoured: no background `plan-use`/current-plan change in the *recommended* design, no N+1 heavy polling, no new dependencies, no continuous transcript collection.

### 5.1 Global Now as a pure client-side projection over the existing `plans[]`

- **Module:** new `packages/plugin/src/client/global-now.ts` (pure, browser-safe, no host calls), exporting `globalNow(snapshot: OrchestraSnapshot)` and `planStage(repo, plan)`.
- **Input:** the existing `snapshot.repos[].plans[]`. It already covers *all* non-archived real plans for every served repo (`snapshot.ts:156-187`) and excludes example rows from counts. No host refresh change, no new endpoint, no polling: the SSE stream (`host/routes.ts:54-71`) already pushes every refresh.
- **Coverage rules (encode explicitly, with tests):**
  1. Include every plan where `!plan.archived` and `!plan.example` (21 real-active plans in the live sample).
  2. Human gates = `plan.waitingHuman` (already excludes `pending`/`checking`, `graph.ts:54-63`) + `plan.unmerged ?? 0` + eligible `attention` via `countsAsAttention` (`needs-you.ts:75-78`).
  3. Terminal-negative = `plan.closed ?? 0` — reported, never counted as open.
  4. “Waiting for the orchestrator” is **not** the person's turn: for the open plan derive it from `repo.tasks[].check` (`processStages`, `process-status.tsx:21-27`); for background plans mark it `unavailable`, never 0.
  5. “Finalizing” only from `orchestratorClosing`/`orchestratorMerging` on the open plan (`process-status.tsx:10-18`); background finalizing is `unavailable`.
  6. Repos with `missing: true` produce an explicit `missing: n` bucket, not silence.
- **Tests:** `packages/plugin/test/global-now.test.ts` (pure fixtures): example plan excluded; archived excluded; a plan with only `check:'pending'` counts in “checking/unavailable”, not in “needs you”; a background plan never yields 0 for a field it cannot know; `closed` excluded from open. Reuse the patterns in the existing `needs-you` tests, no new deps.
- **Privacy/cost:** the projection reads only counts and `lastActivityAt`/`step`-level strings already in the snapshot. Rich Activity (transcripts, run traces) stays behind the on-demand `GET /trace`/`/task-review` reads (`api.ts:79-80`) and is never copied into the aggregated overview or an orchestrator prompt.

### 5.2 Project switcher without changing the shared current plan

- **Problem:** today any plan/row/inbox click routes through `openPlan`/`openWaiting`, which POST `/plan-use` and move the pointer the CLI and agents read (`store.ts:289-296,563-584`; `sidebar.tsx:769-775,789-793`).
- **Fix (client, smallest):** add `orchestraStore.viewPlan(root, planId)` that sets `repoRoot`, writes the route and opens the plan **without** `api.planUse`; use it in `pickPlan`/`goHit`. Keep an explicit “Make current” menu action for when the person really means it. Test: navigate to a non-current plan and assert the host still reports the same `.orchestration/current` (read `/crewboard/api/state` before/after).
- **Fix (host, if task-level detail is required read-only):** add `GET /crewboard/api/plan-state?repo&plan` handled like the other GETs (`actions.ts` `get(...)`, but note GET handlers do **not** call `service.refresh`), building the plan with `syncPlan(root, backends, now, undefined, planId, { readOnly: true })` + `deriveViews` (`snapshot.ts:175-177`) and returning summary/task fields for that plan only. It must **not** call `openPlan`/`setCurrentPlan`. Test: GET it, then assert `.orchestration/current` is unchanged and the response is `partial`-free/`readOnly`.
- **Avoid the trap:** do not implement the switcher by reusing `applyRoute` (`store.ts:279-316`) as-is — it is the write path.

### 5.3 Other precise fixes

- **Search truncation:** `sidebar-model.ts:324` `SEARCH_LIMIT = 10` has no “N more”. Return a total (or per-kind page) so 15×`main` is discoverable; test the 15-plan case. (`/tmp/nav28-shots/03-search-main.png`.)
- **Duplicate group names:** in `groupRepos` (`sidebar-model.ts:181`), when two groups in one section share `name`, append the shortest distinguishing path suffix (e.g. parent dir) instead of relying on the tooltip. Test the two `repo · missing` rows.
- **Current marker when collapsed:** give the group row an `aria-current`/visual cue when it contains the open plan (today only `open && isCurrentGroup`, `sidebar.tsx:1073`). Test `aria-current` while collapsed.
- **ARIA tree position:** set `aria-level`/`aria-setsize`/`aria-posinset` on treeitems (or document the nesting contract) so the tree is navigable beyond browsers that infer levels.
- **Camera memory:** if pan/zoom should survive reload, persist `camera.pose()` per plan under a new `crewboard:camera:<scope>` key next to view/density (`store.ts:94-103`); otherwise state the reset as intended. Test reload.
- **Scroll memory:** route carries `tab`/`run`/`step`/`draft` but not scroll; add per-scope scroll like `reviewScroll` if the requirement is “return where I was”.
- **New labels:** any new UI string needs both `packages/plugin/src/client/dict/en.ts` and `ru.ts`; the repo enforces parity (`pnpm lint:i18n`).

## 6. API constraints and build/budget risks

- **The snapshot is expensive and global.** `service.refreshNow()` with no root rebuilds **all 51 served repos** on every `config.refreshMs` tick (`service.ts:154-179`, interval `:262`); each repo runs `buildRepoSnapshot` → `summarizePlans` → `syncPlan` per non-archived plan (21 plans), `gatherAttention`, git family resolution and `gcRecheckAccepted` (`service.ts:181-245`). A global-Now feature that adds per-plan reads multiplies this. Reuse `plans[]`; do not add a second traversal.
- **Every POST refreshes.** `post()` calls `await deps.service.refresh(root || undefined)` after the action (`actions.ts:585-587`), so the existing `plan-use` switcher also triggers a full repo re-sync. GETs do not refresh — keep read-only reads on GET.
- **The client does not own the clock.** Uplink is SSE (`host-events.ts`; `routes.ts:54-71`) with `retry: 2000` and a 20 s ping; the store only falls back to a one-shot `GET /state` (`store.ts:351-359`) and shows `stalled` after `STALL_MS = 10_000` (`store.ts:76,343-348`). A global overview should read the pushed snapshot, not start its own poll.
- **Build/serve skew risk:** the audited bundle is root's build (`/Users/kjaly/WebstormProjects/dsh-orchestra/packages/plugin/lib/client.js`, mtime 18:17) served from the root worktree; my worktree is the same commit `093bcc4` and the target files are identical, but if root rebuilds mid-review the served bytes change under other assessors. Evidence is time-stamped in §1.
- **No extra dependencies:** the recommendations need none; tests use the existing `vitest` + `@testing-library` dev deps already in `packages/plugin/package.json`.

## 7. Checks

```
$ node scripts/check-docs.mjs --strict
docs: 51 files checked, 7 guides in each language        # exit 0

$ git diff --check
                                                          # exit 0
$ git diff --check --no-index /dev/null docs/notes/2026-09-28-navigation-evidence-audit.md
                                                          # no whitespace errors reported
```

The new document is untracked, so `git diff --check` does not scan it; the `--no-index` form above checks it directly and reports nothing (no trailing whitespace, tabs or conflict markers).

## 8. Evidence artifact index

All screenshots live in `/tmp/nav28-shots/` (outside the repo, because this task owns only this document). Referenced in prose as code spans so the docs link checker does not treat them as relative links.

| Artifact | What it shows |
|---|---|
| `01b-wide-1440.png` | Baseline at 1440×900: 13 groups, 3 expanded, review queue, process strip `Running 0 · Orchestrator check 1 · Finalizing 0` |
| `02-cmdk-open.png` | ⌘K opened the closed rail and focused search |
| `03-search-main.png` | `main` query → exactly 10 plan hits (15 exist), no “more” |
| `04-search-enter.png` | ArrowDown×2 + Enter opened `gaalo-harness/main`; breadcrumb/URL updated |
| `05-before-reload.png`, `06-after-reload.png` | Density/view/task/fold/route restoration across reload |
| `07-task-selected.png`, `08-task-restored.png` | Task `h2` selected and restored; cross-repo review-queue row visible |
| `09-missing-dupes.png`, `09b-missing-dupes.png` | Sidebar with the missing rows in view (groups still expanded) |
| `11-collapsed-all.png` | All 13 groups collapsed, incl. the two adjacent identical `repo · missing` rows |
| `10-frontend-expanded.png` | Worktree family expanded: 3 `· worktree` plans + folds |
| `12-narrow-1000.png`, `12b-narrow-full.png`, `13-narrow-cmdk.png` | 1000×800 overlay rail, slim initials column, ⌘K |
| `native-repos-zoom.png`, `stand-tree-zoom.png` | Native dsh column vs stand, name-alignment comparison |
| `docs/assets/sidebar-needs-you.png` | Shipped capture of the real dsh left workspace column (read-only source) |

## 9. Final checks and closing notes

- Browser session `crewboard-nav-evidence-28` closed (`No active sessions`); the root-owned stand was left running (HTTP 200).
- The only host state touched by the pass (`gaalo-harness` current plan) was restored from `main` back to `step5` and re-verified.
- Scope limits: no example plan exists in the live snapshot, so the tour/example divider was not live-tested; no dsh shell chrome exists in the stand, so shell-level claims rest on the shipped screenshot only; the stand cannot mutate repos (native confirm refuses), so accept/merge/welcome flows were not exercised.
