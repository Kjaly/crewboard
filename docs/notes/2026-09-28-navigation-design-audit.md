# Navigation design audit (Assessment A) — 2026-09-28

**Result:** received — the current navigation has the raw material for the approved direction (family grouping, per-plan memory, lane tree, one waiting model), but the tree cannot answer «what is actually happening, in which project, and whose move is it»; the highest-value fix is one shared stage vocabulary rendered consistently in the tree, the overview and the switcher, followed by a family/copy identity pass, a default-collapsed Missing category with reconnect, and stable ordering.

This is an independent design-specificity, Nielsen-heuristics and cognitive-load review. It does not read the separate `navigation-evidence-28` assessment, its events, or any detector output. It owns only this file; no product code, plans, settings or stores were changed.

## 1. Scope, method and evidence

**Observed directly (live, read-only).** The built plugin stand was running at `http://127.0.0.1:4642`; I opened it in a named session, took one snapshot and one screenshot, and read the host's own `GET /crewboard/api/state` (the real snapshot JSON, 51 repositories). All interaction was view-only: open, snapshot, screenshot, HTTP GET. No accept, run, send, remove, reorder or cleanup was performed.

**Observed in source (read).** `sidebar.tsx`, `sidebar-model.ts`, `sidebar-lanes.tsx`, `lane-tree.ts`, `store.ts`, `route.ts`, `routing.ts`, `app.tsx`, `index.tsx`, `layout.ts`, `process-status.tsx`, `attention.ts`, `waiting.ts`, `lens.ts`, `plans.tsx`, `panel/task-panel.tsx`, `views/work.tsx`, `views/board.tsx`, `host/service.ts`, `host/routes.ts`, `core/src/plan/graph.ts`, `core/src/orchestration/needs-you.ts`, `core/src/orchestration/snapshot.ts`, `core/src/worktree/family.ts`, `core/src/workspaces/registry.ts`, `core/src/workspaces/workspaces.ts`.

**Read as prior evidence in this repository.** `docs/notes/2026-09-22-sidebar-badge.md` (dsh sidebar slot contracts), `docs/notes/2026-09-28-live-activity.md`, `docs/en/plugin-setup.md`, `README.md`, and the committed screenshots under `docs/assets/`.

**Not observed.** The real dsh shell with both navigation columns side by side (the stand mounts only the plugin's main panel, so it shows one column). The user's description of two adjacent columns is treated as reported; the slot contracts that explain it come from `2026-09-22-sidebar-badge.md`. Also not observed: any live accept/approval flow — the stand's native dialogs answer «no», so no decision was exercised. Wherever a claim is derived from source rather than seen live, it is labelled **Inferred**.

**Browser limitation (reported for the parent).** After the instruction to stop overriding `HOME`, the browser is not launchable in this sandbox through documented options alone: `agent-browser --namespace crewboard-nav-design-28 --session crewboard-nav-design-28 close` fails with `Failed to create socket directory: Operation not permitted`, and the plain session fails with `Socket directory '/Users/kjaly/.agent-browser' is not writable: Operation not permitted (os error 1)`. The evidence in §2 was collected before that instruction; the session opened under an OS temporary directory was not touched again and no other agent's browser or process was killed.

## 2. Observed baseline (what the tree actually contains)

At capture time the host served **51 repositories**. Reproducing the sidebar's own rules against that snapshot gives:

- **13 visible top-level groups**, holding **23 plan rows**; **36 of the 51 members carry no plan** (mostly task-copy worktrees under `gaalo-studio-backend/.worktrees/*-orch-*`).
- **0 pinned, 0 quiet, 0 hidden.** Every group therefore lands in the single `Repositories` section; the Quiet and Hidden buckets are empty and untested by live data.
- **7 of the 13 top-level groups are `missing` scratch folders**: `dsh-smoke-repo`, `harness-panel`, `repo` (two distinct paths, same label), `cl2-smoke`, `tarball-repo`, `testrepo`. They are interleaved in the main list, not folded into a Missing category.
- **Family merge is real and useful**: `gaalo-studio-backend` is one group with 35 members whose plans come from `.worktrees/model-pipelines`, `.worktrees/ap-int`, `.worktrees/ap-b`, `.worktrees/assistant-slots`, `.worktrees/format-access` and `.worktrees/ap-a`. `gaalo-studio-frontend` is one group with 5 members. All those plans have the id `main`; only the goal text and a hover tooltip distinguish them.
- **Live activity spans four families**, which is exactly the cross-project scan problem:
  - `dsh-orchestra` / main: `running: 2` (`navigation-audit-28`, `navigation-evidence-28`).
  - `gaalo-studio-backend` (via `.worktrees/model-pipelines`) / main: `running: 1` (`m7b-input-assets`).
  - `cabinet-planner` / `3d-editor-completion`: `running: 0`, `inReview: 1`, `waitingHuman: 0`; the one `in_review` task `fp-cycle31-kitchen-item-review-package` has `check: "checking"`. The process strip says **«Orchestrator check 1»**; the `FULL-CYCLE` lane in the tree shows **`●1`**, i.e. the running mark.
  - `gaalo-studio-frontend` (via `harness-step4-fe`) / main: `inReview: 1`, `waitingHuman: 0` — a second background check with no human need.

That contrast — one checking task rendered as «running» in the lane, as nothing on its plan and group rows, and as «Orchestrator check» in the strip — is the audit's anchor observation.

## 3. High-priority issues

### A1 — Orchestrator «checking» is invisible in the tree and mislabelled as running (High)

**Observed.** In `cabinet-planner` the only non-terminal task is `in_review` with `check: "checking"`. The Work-progress strip correctly separates it («Orchestrator check 1»), but:

- the plan row's mark comes from `planCounts` (`packages/plugin/src/client/sidebar-model.ts:149`), which reads `running: plan.running`, `waiting: plan.waitingHuman`, `failed: plan.attention.length`. `PlanSummary.running` counts status `running` only (`packages/core/src/orchestration/snapshot.ts:184`), and `waitingHuman` excludes a check in progress (`packages/core/src/plan/graph.ts` `waitsForHuman`, `isChecking`). So the plan row renders **no** status mark.
- the group row aggregates the same numbers (`sidebar-model.ts:157`), so the whole family shows nothing.
- the lane row counts a checking task as running (`packages/plugin/src/client/lane-tree.ts:29`, `(task.status === 'in_review' && isChecking(task.check))` → `counts.running`), so `FULL-CYCLE` shows `●1`.
- `gaalo-studio-frontend` / `harness-step4-fe` shows the same: a background check (`inReview:1`, `waitingHuman:0`) is not visible at group or plan level.

**Impact.** The at-a-glance question «is a worker running, is the orchestrator checking, or does this need me?» cannot be answered from the tree. A background plan the orchestrator is checking is effectively silent unless the user opens that project, and the lane mark actively contradicts the strip. This is the core of Nielsen's *visibility of system status*, *match between system and the real world*, and *consistency and standards*.

### A2 — Orchestrator «finalizing» and «accepted, not merged» are filed on the wrong side of the human boundary (High)

**Inferred from source; the live snapshot contains no `checked`+`finalizing` example.** The one observed `in_review` task is still `checking`, so it does not currently produce the false signal described here.

Two derived states cross the human/orchestrator boundary:

- **Finalizing.** `orchestratorClosing` and `orchestratorMerging` (`packages/plugin/src/client/process-status.tsx:10-18`) describe work the orchestrator's chat is closing or merging; the process strip labels it «Finalizing». But `waitsForHuman` returns true for `in_review` with `check: "checked"` unless the orchestrator is still checking (`packages/core/src/plan/graph.ts:60-63`). That value feeds `waitingHuman` (`core/src/orchestration/snapshot.ts:184`), the «Needs you» set (`core/src/orchestration/needs-you.ts:136-156`), the Work board's `needsYou` column (`packages/plugin/src/client/views/work.tsx:18`) and the lane's `review` count (`lane-tree.ts:27`). The same task is therefore simultaneously «the orchestrator's move» (strip) and «your review» (chip, inbox, lane, board).
- **Accepted, not merged.** `unmerged` accepted work is explicitly a person's merge move (`needs-you.ts:130-135`, reason `unmerged`), yet `isFinished` counts any `accepted` task as finished (`lane-tree.ts:14-15`), so a lane whose only remaining work is that merge is filed under **History**, which reads as done.

**Impact.** Two contradictory signals for one task; a routine orchestrator close can pull a person into a review that is already being handled, and a pending merge can hide under History. This is the same heuristic cluster as A1 (*consistency*, *error prevention*, *match to the real world*) and directly undermines the requested separation of human needs from work alerts/stages.

### A3 — Family canonical name hides the physical copy; a missing copy becomes a second standalone project (High)

**Observed.** The family grouping itself works: `gaalo-studio-backend` is the canonical group, and its plans come from four different `.worktrees` copies. But the copy identity exists only in the row's `title` tooltip and a generic suffix:

- the plan row's title is `${plan.goal}\n${repoName(root)} — ${root}...` plus `side.worktreeHint` (`packages/plugin/src/client/sidebar.tsx:959`), and the visible row adds only `· worktree` (`sidebar.tsx:968`) — never the copy name. Four distinct copies with plan id `main` read as four goal lines under one name.
- `harness-panel` — a **missing** worktree at `gaalo-studio-frontend/.worktrees/harness-panel` — is a **separate top-level group**, because a missing snapshot is stored with `family: { root, name: basename(root) }` and git is never asked (`packages/plugin/src/host/service.ts:190`; `core/src/worktree/family.ts:15-24`). So the same physical family appears as `gaalo-studio-frontend` and `harness-panel`, and the user's «gaalo-studio-backend vs model-pipelines» naming collision is reproduced here as «gaalo-studio-frontend vs harness-panel».
- `isTaskWorktree` only recognises copies named `<main>-orch-<task>` next to the main checkout (`core/src/workspaces/registry.ts:78-79`). Copies created inside `.worktrees/` as `<hub>-orch-<task>` are not recognised, so 36 planless copy repos enter the snapshot as full members.

**Impact.** The same physical work carries two names across the adjacent native column and the Crewboard rail, and duplicate/missing scratch groups inflate the tree. This is *match to the real world*, *recognition rather than recall*, and *consistency*: the user must hover and remember paths to know which copy a row belongs to.

### A4 — Missing is not a collapsed category, and a moved folder cannot be reconnected (Medium-High)

**Observed.** Seven missing groups sit in the main `Repositories` section. `isQuietRepo` returns false for any `missing` repository (`sidebar-model.ts:49`), so they never fall into the Quiet bucket; `sidebar.tsx:1357-1360` renders only Pinned, the rest, Quiet and Hidden — there is no Missing bucket. Two of the seven share the label `repo`. The row menu offers pin, hide and «Remove from list», but no «Locate»/reconnect; when the folder's `sources` do not include `crewboard`, even Remove is disabled with a hint (`sidebar.tsx:740-762`). Finished plans and Archive *are* default-collapsed (`sidebar.tsx:1095-1096`), so the collapse pattern already exists for two of the three categories.

**Impact.** Nearly half of the visible groups are dead scratch folders, at the cost of *aesthetic and minimalist design* and scan speed; a folder that moved can only be forgotten and re-added, at the cost of *user control* and *error recovery*, and the re-add may not restore its prior preferences (keyed by root).

### A5 — Ordering moves on its own and the same state is counted and named many times (Medium)

**Observed / inferred from source.**

- **Plan order is not saved.** The live `order` object carries `repos` only, no `plans`. Plan rows are rebuilt with `byPlanActivity` on every snapshot (`sidebar-model.ts:87,176`): a plan that gains a waiting task, a running worker or an alert jumps above the rest. Repo order is stable because all 13 groups happen to be in the saved `repos` list; the moment a new family appears it is appended and sorted by need/activity.
- **Groups auto-fold.** An untouched group's open state is the fallback `defaultGroupOpen` (`sidebar-model.ts:198`), which is `waiting > 0 || running > 0 || current`. Since `isOpen = folds[key] ?? fallback` (`sidebar.tsx:1028-1029`), a group the user never touched opens when work starts and collapses when it clears; only an explicit fold is sticky.
- **Duplicate counters and one overloaded name.** The same states are counted in the process strip (Running / Orchestrator check / Finalizing), the header chips (attention / running / ready), the plan row peek (`accepted/taskCount`), the lane marks (`●◐○·✓`), the inbox heading scope, the queue chip and the collapsed-rail badge. Six surfaces share the label «Review queue» in different senses (`side.inbox`, `panel.app.queueEmpty/queueTitle/queueCount`, `queue.title`, `work.reviewQueue`, `review.needs.title`, `packages/plugin/src/client/dict/en.ts:235,384,524,651,654,667,1496`), while `README.md:37` and the committed `docs/assets/sidebar-needs-you.png` still call the human queue **«Needs you»**.

**Impact.** Rows move under the user as work changes (*user control*, *consistency*), and several counters with the same meaning but different scopes raise scan cost (*cognitive load*). The «Review queue» rename also erases the distinction the approved direction asks for: the human queue, the queue panel and the Review view now sound like the same thing.

## 4. Key jobs — current support and gap

| Requested job | Supported today | Gap |
| --- | --- | --- |
| See all actual activity at a glance | Per-plan running mark; per-plan lane tree for the open plan; repo-level process strip | No cross-project stage overview; checking/finalizing absent from tree aggregates; background checks silent (A1, A2) |
| Distinguish worker / check / finalize / human | Process strip separates Running, Orchestrator check, Finalizing (`process-status.tsx:21-27`); task panel distinguishes `reviewCheck` states | The tree, lanes and Work board collapse these differently (A1, A2); no single vocabulary |
| Switch to the exact task Activity | Plan row → task; `?tab=activity` route; `taskDefaultTab` opens Activity for a live worker (`task-panel.tsx:52-54`); `shared.task` route rebuilds the run | No stage-aware jump from an overview; the Activity tab is not stored per task |
| Return to the same place | Per-plan `view`, `task`, `lens`, `density` (`store.ts:94-97`); per-repo route with `task`/`tab`/`run`/`lane` (`store.ts:103`); sidebar folds (`sidebar-model.ts:237`); lane group open state (`lane-tree.ts:102`); repo order on the host | Panel scroll, graph camera pose, composer draft, lane «show more», Work-board done filter/open, inbox «show more», `multiIds` are not persisted (A6) |
| Inactive project stays accessible | Groups sort by activity and are never dropped for inactivity; Quiet is only a display bucket; explicit Hide exists | Missing groups can be hidden but not reconnected (A4); two groups can share a label (A3) |

### A6 — Persistence inventory (do not claim all state is lost)

**Remembered per plan (scope `root:planId`):** view (`crewboard:view:<scope>`), selected task (`crewboard:task:<scope>`), lens (`crewboard:lens:<scope>`), density (`crewboard:density:<scope>`, with legacy fallbacks). **Remembered per repository:** the hash route (`crewboard:route:<root>`), which carries `view`, `task`, `tab`, `run`, `step` and `lane`; **remembered on the host:** sidebar `order` (`repos` and, when set, per-group `plans`). **Remembered per viewer:** sidebar folds (`crewboard:side-folds`), lane-group folds (`crewboard:lane-tree:<root>:<planId>`), rail open (`crewboard:plans-open`).

**Not remembered:** graph camera pan/zoom/`touched` (the `Pose` in `views/graph/camera.ts` lives in memory and is used for lens restore only); any panel scroll offset (the live feed deliberately follows the bottom and `live-activity.tsx:139-180` writes `scrollTop`, but no offset is stored; Review keeps a list offset in a ref for the drill-down round trip only); composer draft text and `multiIds` (plain component/store state); the Work board's `doneOpen`/`filter`; the lane «show more» beyond `HISTORY_SHOWN` (local `showAll`, `sidebar-lanes.tsx:48`); inbox group «more» expansions; and the active tab as a per-task choice (the tab is route-carried, and `task-panel.tsx:248-266` resets it to the default policy on a fresh task unless a `tabRequest` pins it).

So the correct statement is: **view, task, lens, density and lane focus already persist per plan/repo; tab, draft, scroll and camera are the gaps.**

## 5. Recommended navigation model

### 5.1 One stage model, rendered everywhere (fixes A1, A2)

Derive each task's stage once, in core, next to `deriveViews`, and render that same value in the tree, the lanes, the Work board, the overview and the task panel:

| Stage | Derivation (existing facts) | Whose move | Tree mark (distinct) |
| --- | --- | --- | --- |
| `worker` | `status === 'running'` with an active run | orchestrator | moving dot |
| `check` | `in_review` and `isChecking(check)` | orchestrator | hollow/eye mark |
| `finalize` | `orchestratorClosing`/`orchestratorMerging` (chat awake, checked, result) | orchestrator | closing mark |
| `own` | `byOrchestrator` root task, or `preparing` decision | orchestrator | own-work mark |
| `human` | `waitsForHuman` and not `finalize` | **you** | attention mark |
| `unmerged` | `unmerged` | **you** | merge mark |
| `alert` | `countsAsAttention` failure/stall/worker-gone | orthogonal | error mark, own axis |

The rule is «whose move is next»: `finalize` must not appear in the Needs-you inbox, board `needsYou` column or lane `review` count; `unmerged` must never move to History. `alert` is a second axis, not a stage, so a stalled worker can carry both an alert mark and the orchestrator-stage mark.

### 5.2 Tree behaviour

- **Three levels, canonical first:** Family (canonical git family name) → plan row, tagged with an explicit **copy chip** (the worktree folder, or «main») → lanes, expanded **only** for the selected plan. If a family has several copies with plans, the chip is always visible; the path stays in the tooltip for power use.
- **Sections, in order:** `Needs you` (human moves only, cross-project, with failed/stalled alerts in a visually separate `Work alerts` subgroup) → `Pinned` → `Projects` → default-collapsed `Missing · N`, `Quiet · N`, `Hidden · N`. Finished plans and Archive stay default-collapsed inside a group, where Restore/Remove are already reachable.
- **Active / pinned / current:** current keeps the single selected style; pinned and live groups get a persisted mark, not only a section position; a pinned group never disappears because it has no current activity.
- **Stable order:** persist plan order alongside repo order (the host already stores `SidebarOrder`; `api.sideOrder` already accepts both). Automatic need/activity sort becomes an explicit, default-off toggle. A group whose fallback opened it must not auto-collapse after the user has interacted with it; once a fold is recorded it wins.
- **Missing rows:** one collapsed bucket, each row disambiguated by path, with **Locate folder…** (update the stored root, keep plans/history) and **Forget** (today's Remove). Reconnect must never run git on a missing folder; a recorded last-known family or the `.worktrees/<name>` path pattern supplies the family label until the folder is found.
- **No third column, no card grid:** keep the rail as a tree; the overview is a screen, not another permanent column.

### 5.3 `globalNow` overview and switcher

A compact, non-card **Now** screen, reachable from the rail and from ⌘K, ordered by a stable project order and then by stage urgency:

- one line per active item: project (canonical family + copy chip) → plan → task title → stage word (from §5.1) → age → one primary jump («Open Activity»).
- a leading **Needs you** block (human moves: review, decision, unmerged, blocked-worker), then **Work in progress** (worker, check, finalize, own), then **Work alerts** (failed/stalled/worker-gone). This is the separation the brief asks for; do not merge alerts into the human block.
- each block states its own count once. Do not repeat the running/ready/review counts as chips elsewhere on the same screen.
- the switcher itself is the existing ⌘K search (`sidebar-model.ts:327-349`) extended to match copy names and stage words, plus a small «Recent projects» list. Selecting a project restores its persisted plan state; it never hides or drops an inactive project.

### 5.4 Return-to-place contract

- Already persisted: view, task, lens, density per plan; route (task/tab/lane) per repo; folds; order.
- Add: camera pose per plan (store the `Pose`), the task-panel scroll offset per task, the composer draft per task, and the Work-board `doneOpen`/`filter` per plan. On return, restore camera only when the user had claimed it (`touched`), otherwise re-run the stored framing; restore scroll only for the same task identity.
- Keep the current rule that a same-scope poll never remounts the feed (`task-panel.tsx:317-322`); the additions must be reads/writes around that, not a remount.

## 6. How native dsh navigation coexists (outside plugin ownership)

The plugin owns exactly two shell anchors: a global `sidebar.panellist` entry and the `main` panel (`packages/plugin/src/client/index.tsx:75-77`). The native workspaces/session list is the single `sidebar.workspaces` slot, rendered by dsh's own `WorkspaceBrowser`; the slot contract exposes no per-session-row decoration, and replacing it would mean reimplementing its search, grouping and actions (`docs/notes/2026-09-22-sidebar-badge.md`, §1). Therefore:

- the two columns coexist by design and the plugin cannot rename, merge or decorate the native rows; the user's «gaalo-studio-backend vs model-pipelines» mismatch is structural, not a bug the plugin can fix in place;
- the honest design move is to make Crewboard self-explanatory (canonical family + visible copy chip, §5.2) and to give an explicit bridge from a native session to the Crewboard plan — the plan row's **Open chat** and **Copy agent handoff** already exist (`sidebar.tsx:694-708`), and they are the right place to strengthen;
- the Crewboard rail must not become a second workspace browser. It is the orchestration/tree view; project discovery stays with the native list and Crewboard's own `+`/reconnect.

## 7. First cohesive implementation scope and acceptance criteria

**Scope 1 — one stage model (largest leverage, smallest surface).** Add a derived task stage in core next to `deriveViews`; consume it in `planCounts`/`groupCounts`, `laneTree`, `processStages`, `needsYou`/`workColumns`. Acceptance:

1. In the live stand, `cabinet-planner`'s `fp-cycle31…` produces a distinct **check** mark on its plan row, its family group and its `FULL-CYCLE` lane; the lane no longer shows `●`.
2. The process strip and the tree agree on the same stage for every non-terminal task in the snapshot.
3. A synthetic `in_review` + `check: checked` + chat-awake task is **not** in the Needs-you inbox, chip count, Work `needsYou` column or lane `review` count.
4. An `accepted` + `unmerged` task stays in `Now`/Needs-you and never appears under History.

**Scope 2 — family/copy identity, Missing bucket, stable order.** Acceptance:

1. Every plan row whose repository is not the family's main checkout shows its copy name without hover.
2. A missing path that was previously seen inside a family is labelled with that family (or lands in the collapsed `Missing · N` bucket), not as a new project; the two `repo` rows remain distinguishable by path.
3. The seven missing groups collapse to one `Missing · N` row by default; **Locate folder…** re-points a moved folder while keeping plans; **Forget** keeps today's behaviour.
4. With three consecutive polls in which a plan starts and stops running, a manually ordered plan list does not reorder, and a manually folded group does not reopen or collapse.

**Scope 3 — `globalNow` + switcher + return-to-place.** Acceptance:

1. From any open project, one action opens the exact Activity of any project's live/checking/human task.
2. Returning to the previous project restores view, task, tab, lane, scroll, camera and expansions; an unsent composer draft survives leaving and returning.
3. The overview shows the human queue and the work stages as separate blocks, each state counted once; no card grid.

Scopes 1–3 are independently shippable; Scope 1 should land first because Scopes 2–3 depend on the same vocabulary.

## 8. Open decisions (material only; recommended default in each)

1. **Stage priority when several apply** (e.g. a finalizing task that also has a failed prior run). Default: `alert` and stage are orthogonal marks; within the stage axis, `unmerged`/`human` outrank `finalize`, which outranks `check`, which outranks `worker`/`own`.
2. **What auto-opens a group.** Current behaviour auto-opens any group with `running`/`waiting`. Default for the new tree: only the current project opens on first sight; nothing auto-opens or auto-collapses after the user has expressed a fold; a background group shows its stage summary without expanding.
3. **Missing-family inference.** Default: persist the resolved family at add/last-seen time and fall back to the `.worktrees/<name>` path pattern; show the row as `Missing` (collapsed) until Locate confirms; never run git on a missing path.
4. **`globalNow` placement.** Default: a complete screen reachable from the rail and ⌘K (not a fourth permanent column, not a new dashboard tab), so the two-column shell stays two columns.
5. **Naming.** Default: `Needs you` for the human queue everywhere (matching `README.md`, the core module and the Work column), with `Work alerts` as the separate failed/stalled block; reserve `Review` for the acceptance/review flow only. This is the one rename with user-visible documentation impact.

## 9. Non-goals and preservation

- No automatic removal or hiding of repositories, plans, tasks, runs or history. Quiet/Hidden/Missing are display categories with an explicit way back; the host already never drops a folder because it is missing (`docs/en/plugin-setup.md`, «Connect repositories»).
- No automatic deletion or «cleanup» of task-copy worktrees as part of this design; `isTaskWorktree` recognition is a classification fix, not a delete.
- No promise that plan context is already complete: §A6 states exactly what persists. No new API is assumed; the recommendations use existing snapshot fields, `SidebarOrder`, the route and `localStorage` keys.
- No provenance or model-attribution claims, and no statement that a zero counter means a project is idle; a stage is shown only from the documented task facts above.

## 10. Evidence index

- Tree/status derivation: `packages/plugin/src/client/sidebar-model.ts:48-53,63-64,86-87,98-110,138-161,176,198-199,214-233,237-253,327-349`.
- Lanes: `packages/plugin/src/client/lane-tree.ts:14-15,24-35,44-62,101-121`; `packages/plugin/src/client/sidebar-lanes.tsx:44-74,127-174`.
- Tree rendering, missing/remove/folds: `packages/plugin/src/client/sidebar.tsx:740-762,936-984,1025-1091,1095-1096,1298-1316,1318-1361`.
- Stages/strip: `packages/plugin/src/client/process-status.tsx:10-27,34-67`.
- Store/persistence: `packages/plugin/src/client/store.ts:71-103,459-462,496-560`; `packages/plugin/src/client/app.tsx:43-57,106-134,413-427`; `packages/plugin/src/client/panel/task-panel.tsx:52-54,248-266,303-322`.
- Core derivation: `packages/core/src/plan/graph.ts:54,60-63`; `packages/core/src/orchestration/needs-you.ts:80-84,103-114,122-189`; `packages/core/src/orchestration/snapshot.ts:184`; `packages/core/src/worktree/family.ts:8-24`; `packages/core/src/workspaces/registry.ts:78-79,96-111`; `packages/core/src/workspaces/workspaces.ts:59-77`.
- Host family/missing: `packages/plugin/src/host/service.ts:181-237`.
- Native-slot evidence: `docs/notes/2026-09-22-sidebar-badge.md` §1–2; `packages/plugin/src/client/index.tsx:67-83`; `docs/en/plugin-setup.md` «Connect repositories»; `README.md:37`.
- Live data: `GET http://127.0.0.1:4642/crewboard/api/state` at capture time (51 repositories; the counts quoted in §2).

## Parent synthesis rubric — 2026-09-28

Qualitative heuristic scores (0 poor,4 strong), added by the orchestrator after independently reading
Assessment A and before reading Assessment B detector output; not interview statistics:
visibility1, real-worldmatch2, usercontrol2, consistency1, errorprevention2, recognition2,
efficiency2, minimalism1, errorrecovery2, help2. Existing strengths are family grouping, scoped
view/task/lens/density persistence, and conservative retention of missing/history data.
Cognitive-load anchor:13visiblegroups,7missing, layered plan/Now/History/lane expansion and repeated
scope counters. Emotional valley is losing “where the work is” and “where I was” during switching.

Implementation qualifications: a checked bound-chat task alone does not prove automatic-close
eligibility or an active merge. Explicit human_review/root/decision gates and actual receipt/Git
guards remain authoritative. Checking readiness and actual execution must be named separately.
Missing-folder reconnect with history/path migration is deferred; folding missing rows with existing
Remove/Add actions is safe without inventing data migration. Native dsh sidebar remains outside scope.
Questions skipped: user approved the overall approach and asked implementation plus tree audit.
