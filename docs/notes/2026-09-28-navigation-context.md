# Safe project navigation and remembered context (navigation-context-28)

**Result:** received. The safe browsing/action half of the approved multi-project experience is complete on top
of the merged foundation and UI stage: a selected plan is read **read-only**, every task consumer captures its
own `root`+`plan`, and the reader's place — tab, run, reading position, camera, Work filter, family copy,
drafts — is remembered in window memory (drafts and positions only there) and restored exactly. This note is
the handoff; the parent runs the canonical gates and the final browser proof.

## What landed

### Read-only plan binding — no `plan-use` on ordinary navigation

- `store.applyRoute` no longer posts `plan-use`. An explicitly selected plan is fetched with
  `shared.planState` and held as `state.browse` (`{ root, plan, version, snapshot }`). `plan-use` remains only
  where it always was — inside the host's own `openPlan`/`setPlanView` semantics, never on a browse.
- The pending selection is published synchronously, so `shownRepo` shows **nothing** of the served current plan
  while the answer is in flight (no silent fallback). A same-scope re-read keeps the previous snapshot visible.
- The response guard captures the requested `root`+`plan` and a monotonic sequence (`browseSeq`), and compares
  against them, never against the mutable current selection or the response's own generation. A host refresh
  that lands while the answer is built triggers exactly one re-read for the selected plan
  (`version = generation:plan.rev`), never a scan of every plan.
- A plan the repository lists is a valid selection; a plan it does not list fails closed with `bad_plan`
  (`browse.error`) and leaves `current` untouched. An explicit route a legacy host cannot validate degrades to
  its current plan (compatibility), never to a different valid plan.

### Every task consumer captures `root`+`plan`

All browser task reads and mutations pass the captured plan: `shared.task`/`taskReload`/`taskVersion`,
`TaskPanel` (accept, run, steer, stop, relaunch, run-checks, merge, mark-merged, send back, drop), `TaskMenu`,
`WorkView`, `DecisionBrief`, `AcceptBatch`, `ReviewQueue`, `right-panel`, `console`, `FilePreview`, `tabs`,
`trace`, `trace-ledger`, `run-trace-panel`, `review-detail`, `review-parts`, `insight.usePlanCost`, and the
graph's run/accept. The same task id in two plans is two resources end to end; cross-project queue rows use
their own coordinates; no mutable global current-plan pointer is injected or swapped.

### Window-session memory (never localStorage)

A shared map in `store.ts` (the module the main client and every lazy screen share; the build test now asserts
the `__orchShared/store` boundary) holds:

- keyed by physical `root`+`plan`+`task`: the panel tab and selected older run, the composer's unsent text and
  its delivery receipt, and the feed reading position.
- keyed by physical `root`+`plan`: the graph camera pose (restored only on a return) and the Work filter/done
  expansion.

Drafts are private window memory. A refused/failed steer keeps its text; only an accepted write clears the
exact submitted revision, so a newer draft typed before the answer survives. A corrected relaunch uses the
captured receipt text when the draft is empty and never sends an empty note. A restored `sending` receipt that
outlived `SENDING_TTL_MS` reads as the client state **unconfirmed** — elapsed time is never called a failure.

### Feed reading position — exact anchor, offset within it, per run

The previous shape (a bare `turn.ts` anchor restored with `offsetTop`) lost the place halfway through a tall
message, could select the wrong row when two turns shared a timestamp, and trusted an `offsetTop` whose
`offsetParent` may differ. The contract now is:

- **Deterministic anchor identity.** `feed-window.turnAnchors` builds each rendered turn's anchor from its
  first event signature (`kind|ts`) plus an ordinal for turns that still share a timestamp, and `Conversation`
  writes it as `data-event-anchor`. It is independent of the React key (which resets on a remount) and safe as
  a DOM attribute/selector.
- **Offset within the anchor.** `LiveActivity` measures with `getBoundingClientRect`: the topmost turn whose
  bottom is below the scroll viewport's top, and the viewport's signed position relative to that turn's top.
  Restore moves `scrollTop` by how far the anchor's top drifted from where it was saved, so the same reading
  alignment inside a long public message or an open technical group is kept. `offsetTop` is never trusted.
- **Bounded fallback.** When the anchor is no longer in the bounded history, the saved raw offset is applied,
  clamped to the scroll content.
- **Per run.** The position is stored with the captured run (`feedRun`). `store.feedPositionOf` returns it only
  for that same run; a new run gets `undefined` and starts fresh at the live end. `LiveActivity` is keyed by
  `root:plan:task:run`, not `runId` alone.
- **Unmount inside the throttle.** Geometry is captured synchronously on every scroll into a ref; only the
  write-back is throttled. The passive cleanup flushes that captured snapshot, so leaving a task for another
  project inside the 120 ms window keeps the latest offset instead of reading a scroll container React has
  already detached.

The canonical fixed tab bar stays outside `.orc-panel__scroll`, so the reading viewport is the tab body only.

### Return vs explicit jump

`applyRoute` carries an `explicitFocus` flag. A project return (`openRemembered`, boot restore) restores the
camera and adopts a remembered selection; an explicit row/link/lane jump (`openPlan`, `openWaiting`,
`selectIn`, a hash deep link) focuses it. The graph is keyed by `root`+`plan` so a camera cannot leak across
plans, and a lane the reader just picked (`LaneFocus.explicit`) wins over restored camera memory.

### Family remembered copy and ambiguous labels

`store` remembers the exact physical copy the reader last used within a family (`root` → `familyId`). A project
click in the compact switcher — the same one above a plan and above the global «Now» — reopens that copy, not
the one that merely looks busiest this poll. When a family offers several relevant copies the switcher names the
chosen copy on the control, so the family label alone is not ambiguous. A remembered copy that currently carries
no plan stays selectable.

### One global chrome (final visual correction)

The wide-screen proof showed two overlapping project pickers and a plan-scoped header over the global screen.
Now there is **one** compact `ProjectSwitcher` above the content in both modes, and `NowView` no longer renders
its own unbounded Projects/copy block (the duplicate markup and its dead styles are gone). While global, the App
header reads **All projects / Now** and hides the plan-scoped view tabs, view menu, progress strip, preset picker
and status/lens/queue chips; the rail, the switcher and the build/connection statuses stay, so the remembered
plan is one click away. A Now row is a single button: bounded muted plan/copy metadata, a prominent title, and a
compact stage/worker/age cluster with a chevron and an accessible `Open: <title>` name — no standalone «Open»
text to wrap onto a second line. Scope, memory and decision guards are unchanged.

### Selected plan is never buried in a fold

The narrow proof showed a selected finished `step5` hidden under the collapsed «3 finished plans» row while
only live `step4` was visible. `sidebar.groupRow` now promotes the **selected** plan (the shown `root`+`plan`,
so a non-CLI-current explicit browse counts) out of the finished/archive fold when it is genuinely finished or
archived. It renders as a foreground row marked selected (the row's selected state now reads the shown
`planId`, not only the plan's own `current` flag) and carries a quiet, truthful **finished** / **archived**
note; the fold labels and counts are computed after the row leaves, so the other finished plans keep folding
and nothing is listed or counted twice. The promoted row is not draggable, so the live reorder list and the
manual order are untouched.

### Tree/lane folds and Work filter

The tree's manual folds are already persisted by the UI stage (`crewboard:side-folds`, keyed by row, so plan
and lane). The Work done filter and its expansion are window-session memory per `root`+`plan`. The inbox
«more» reveal remains a transient per-poll reveal, not a durable preference.

### Agent projection

`host/tools.ts planAnswer` strips the UI-only repository `generation` and the per-plan `progress.items` arrays
from `orchestra_plan`, keeping the concise `progress.coverage` (an unreadable plan still reads `unknown`) and
every task fact. The richer served snapshot is not mutated.

## Boundaries deliberately kept (not claimed)

- The inbox «more» reveal is not persisted.
- The camera is restored on a return only; a refresh keeps the live graph where the reader left the DOM.
- The canonical `pnpm --filter dsh-crewboard test` was **NOT RUN** here: `crewboard slot` cannot write its
  machine lock under `~/.config/crewboard` in this workspace-write sandbox (`No permission to write …lock`;
  `ps` is also denied, which the vitest global teardown reports). The parent runs the full gate.

## Checks run (development)

- `pnpm --filter dsh-crewboard typecheck` — passes.
- Focused direct vitest (no broad suite): `live-activity`, `session-memory`, `project-switcher`,
  `activity-chat`, `remembered-state`, `panel-feed`, `feed-notes-lang`, `navigation-context`,
  `context-roundtrip`, `route-store` — all pass (including the new duplicate-timestamp, midway-in-tall-message,
  window-shift, expired-anchor, new-run-fresh, family-copy and unmount-before-throttle lifecycle cases).
  Every invocation's exit code is 1 only from the sandbox `ps EPERM` in global teardown, not from a failure.
- Relaunch (visual correction) focused direct vitest: `now-view`, `now-store`, `project-switcher`,
  `navigation-context`, `task-panel-launch`, `navigation-scope`, `remembered-state`, `sidebar`,
  `plans-list`, `repo-list`, `sidebar-lanes`, `newcomer-entry`, `where-it-waits`, `reveal-task`,
  `right-pane`, `root-work` — all pass (the new `now-store` case proves the switcher is above Now, the header
  reads «All projects» and the plan-scoped view tabs/progress/preset are hidden, and returning restores them;
  the new `now-view` case proves a row is one button with an accessible `Open: <title>` name and no second
  project/copy block; the new `sidebar` cases prove a selected finished plan and a selected archived plan stay
  foreground, selected and truthfully labelled while the other finished/archived plans stay folded and the
  counts are not doubled). Same `ps EPERM` teardown caveat.
- `node scripts/check-docs.mjs --strict`, `node scripts/lint-i18n.mjs`,
  `node scripts/lint-dsh-boundary.mjs`, `git diff --check` — pass.
- `build.test.ts` gained a `__orchShared/store` / `__orchShared/api` boundary assertion; it was verified against
  the built `lib/` artifacts by inspection, not re-run as a suite (parent canonical gate).

## Parent source review

The deferred task-menu trace result is also bound to the captured navigation
intent sequence, not only root and plan. An A→B→A round trip, another task choice
or the global Now screen cannot resurrect the earlier trace request.

The browser caught the unvisited-family fallback using an unbound `this` in
`openRemembered`. The parent bound that fallback to the actual store and added
a real App/project-switcher click regression with no saved route.

Final browser integration also corrected repository search/rail project clicks to
restore the remembered route and copy. A selected family marks only its selected
physical copy as current, keeping planless siblings out of the compact selector.

The final live snapshot exposed three backlog decisions in Now although they
were not actionable. The parent changed the stage projection to the canonical
`waitsForHuman` predicate and added backlog/blocked/terminal/preparation cases;
no task status, decision answer or approval gate is changed.

A cold reload of `#orchestra/now` keeps the saved per-repository route. Back to
plan now reads that route rather than choosing the served CLI current plan.
Private drafts/positions still intentionally do not survive page reload.
