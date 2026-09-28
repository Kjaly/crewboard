# Live Activity interaction and motion

**Result:** a work-in-progress design and implementation note for the task panel's Activity tab (the "orchestra"
panel in `packages/plugin`). It records the interaction contract, the motion decisions, and the limits left in core.
Product code follows this note; no branding, no whole-panel redesign, no core or protocol change.

## Problem

Activity was a timestamp-and-glyph list that only appeared if a person found the tab. A running task opened
Overview, so the one screen that shows live worker work was hidden behind a click. The feed truncated commands to
one ellipsized line, gave no true status, and did not follow new events, so a person watching a run could not tell
"working on a step" from "waiting for the next update".

## Interaction contract

1. **Opening policy.** A selected task opens Activity while its latest run is live (ordinary worker task,
   `kind` not `root`/`decision`), and Overview otherwise. A ready task that the person starts opens Activity as
   soon as the launch is accepted. A task/plan switch reapplies this policy; a snapshot for the *same* task never
   re-applies it, so a person reading Overview is not thrown back.
2. **Explicit choice wins.** Clicking a tab, a URL/deep link, a queue choice, the task menu, the run trace, or
   opening a previous run pins the tab. A pinned tab survives snapshots and completion. Requests carry their
   `repo`/`task`, so a lingering request for another task cannot apply to the task now on screen.
3. **Completion keeps Activity.** When a run ends, the tab stays; the status strip moves to the true final run
   outcome (completed / failed / stopped) and offers **Open report** when a report exists. There is no automatic
   jump to Overview while the person is reading.
4. **Reading order.** The feed keeps the normalized event order. Worker messages are plain readable prose; a
   human direction stays visually distinct; commands and changed files stay compact and expandable. Long text
   wraps instead of truncating; long commands scroll inside their row. Problems and final reports stay in place.
   No internal chain of thought is shown as chat — only the events Crewboard already records.
5. **True status.** The strip says *working* with the current reported step when the run's last event is still open,
   *waiting for updates* when it is between steps, and the run's own outcome when it is finished. A tool failure
   is a `problem` line, not a task failure. Only the latest, unfinished, running run shows a live indicator;
   older, cancelled, failed, or completed runs never look alive.

## Motion decisions

Motion carries state and continuity only.

| Moment | Purpose | Tool | Properties | Curve / duration |
| --- | --- | --- | --- | --- |
| A new feed line arrives | state indication | CSS animation | `opacity`, `translateY(3px)` | `160ms cubic-bezier(.23, 1, .32, 1)` |
| Live status changes | state indication | CSS transition | `opacity`, `color` | `160ms cubic-bezier(.23, 1, .32, 1)` |
| Live dot while working | state indication | CSS animation | `opacity`, `scale` | `1.6s ease-in-out` loop |
| Panel / tab switch | continuity | none | — | instant |

The feed is read while it moves, so **only appended lines animate**; history does not replay on first load, on a
detail refresh, or on a tab switch. A live run opens on its latest line once, on mount and without animation; a run
that finishes while the person is reading above keeps their place. The run detail is kept across a poll, a transient
read failure, and completion, so groups and expanded tools are not remounted. Scrolling follows new activity only
when the viewer was already at the bottom; scrolling up pauses following and reveals a sticky **new activity**
button that catches up on demand. The status strip stays one bounded line and the live dot's loop pauses while the
page is hidden. `prefers-reduced-motion: reduce` drops the translate and the dot pulse and keeps a short opacity
change; the new items and the status word remain readable without motion.

## Layout

Activity uses the existing scroll container, `.orc-panel__scroll`, so there is no second feed viewport fighting the
panel. The panel header stays in `.orc-panel__fixed` (max-height 55%); Activity owns the remaining height. The
status strip is sticky to the top of the scroll area and the new-activity button is sticky to its bottom; both are
one compact line each and never push the reading offscreen. The run selector and the run-ledger link keep their
place above the feed.

## Known limits

- **Startup baseline waits are invisible before the run exists.** A launch is accepted before the host records a
  run, and baseline/setup work happens before the first normalized event. The panel can show that the launch was
  accepted, but it cannot show baseline progress without a core pending-launch event. This note records the gap;
  no ready task is presented as running and no core scope was expanded here.
- The feed is the normalized `detail.events` of the latest run. An older run still opens the trace-backed
  `OlderRunActivity`; the two are intentionally different sources.

## Files

- `packages/plugin/src/client/panel/live-activity.tsx` — phase helper, follow behaviour, status strip, feed.
- `packages/plugin/src/client/panel/tabs.tsx` — conversation-style `FeedTab` and grouping (kept exported).
- `packages/plugin/src/client/panel/task-panel.tsx` — default-tab policy, pinned choice, scroll wiring.
- `packages/plugin/src/client/app.tsx` — tab requests scoped to `repo` + `task`.
- `packages/plugin/src/client/styles.ts` — scoped Activity styling.
