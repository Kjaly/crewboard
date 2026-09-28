# Live Activity: a truthful interactive conversation

**Result:** the design and implementation note for the task panel's Activity tab (the "orchestra" panel in
`packages/plugin`). It records the conversation composition, the truth rules for the «Now» region and the
composer, the streaming and budget bounds, and the motion decisions. Product code follows this note.

## Problem

Activity was a timestamp-and-glyph list. Every row began with a left time column and a glyph, long commands were
ellipsized into one line, a running worker defaulted to «Waiting for updates» between every tool call, and a
direction with no recorded author was labelled «You». A person watching a run could not tell what the agent
thought or did right now, read a full public explanation, or write back without hunting for a form.

## Reading topology

The feed is a conversation, not a journal. Each turn spans the panel and carries its actor and time **inline and
subdued above the prose** — there is no left time/glyph column and no uppercase actor grid.

1. **Public prose is primary.** A worker `message`/`final` and a human/runner `steer` render at body size, full
   panel width, with paragraph breaks preserved. Only a short actor label and time sit above the text.
2. **Technical steps fold.** Every consecutive `action`/`file` — and any tool error between them — collapses
   into one `<details>` whose summary names the step count, the actual latest step and any tool problem, and
   whose body lists every step with its known operation and target. A single long shell command is a
   disclosure too, never an oversized code block between prose.
3. **Risk stays visible.** A tool error is a problem marker on that technical summary and an error-coloured
   step in its details; a run-level problem (permission, interruption, limit) is its own turn. Neither turns the
   whole task into a failed verdict.
4. **Exact chronology.** Turns keep the normalized event order; `groupEvents` and its trace consumers are
   unchanged, and the Activity projection (`conversationTurns`) is a separate helper.

## Truth rules

The persistent **Now** region reports only what the run actually reported.

| State | What it says |
| --- | --- |
| Open tool (`open` set by the backend's `callId` pairing) | *Working* + a known operation and target from tool metadata |
| Live, between steps | *Active* + **Last step:** the last finished step and the last-update age |
| Live, no events yet | *Starting* |
| Last event is a run-level problem | that problem, in the reader's language |
| Finished | the run's own outcome, with **Open report** |
| An alert from core (stalled, worker gone) | the alert's own words |

- An in-flight command is not «thinking», and a finished tool is the **last step**, never presented as now
  executing. There is no fabricated chain of thought or percentage.
- A known operation comes only from a recognized backend tool name (`read`, `write`/`edit`/`patch`, `bash`/
  `exec`). An unknown tool or a backend without metadata stays a generic reported step — a file name is never
  read as proof of a write.
- A steer with no author metadata is a neutral **Direction**; a runner note is a **Notice**. Neither is ever
  attributed to the viewer.
- The age of a streaming message comes from the last real chunk time (`updatedAt`), never from the first chunk
  or the poll fetch.

## Public text and bounds

Core keeps the legacy 200-character, single-line `text` for every consumer. It adds an optional `display` for
public `message`/`final` events only: line breaks preserved, **UTF-8 byte** bounds of 8 KiB per message and
32 KiB for the whole feed, spent from the newest event backwards so the latest intent is never clipped by an
ancient transcript. A bound reached sets `truncated: true`; a display dropped by the aggregate budget is
marked truncated too, so the compact 200-character summary is never presented as the whole answer. Non-string
result payloads contribute only a recognized public `answer`/`result`/`text` field — never a reasoning, usage
or unknown structure as JSON chat. A literal JSON string the worker wrote stays its own words.

The enrichment is browser-only. Machine surfaces — `crewboard task show --json`, `orchestra_task` and
`orchestra_events` — project through the shared `compactNormEvents` helper and keep the legacy event shape
(`ts`, `kind`, `text`, `reason`, `note`, `open`), so bounded `display` text and duplicated tool targets never
ride into every orchestrator call. The browser's `GET /api/task` still returns the rich `getTaskDetail` events.

## Composer

The latest live run has a real composer docked at the bottom of the panel (it survives polling, tab changes and
send failures because the draft lives in the panel, not the feed).

- Plain Enter is a newline; Ctrl/⌘+Enter sends; empty and pending drafts are disabled; a delivered text is not
  resent.
- The status line shows the API's own queued/delivered/refused/abandoned state. The machine `steerId` is a
  diagnostic `title`, not the human line. When the host already reported the steer record, its current state
  wins over the initial receipt; otherwise the receipt is labelled *at request time*.
- Feedback is keyed to the exact submitted text, so an older response never overwrites or falsely disables a
  newer draft.
- If the run finishes mid-request, the composer stays as a read-only record: an unsent draft is preserved with
  a copy affordance and the existing explicit relaunch path; a delivered text is never called unsent. Nothing
  auto-resends or auto-relaunches.
- **Give direction** always returns to the latest active conversation and focuses that composer, even from an
  older-run or trace view, so a person never types into a form pointed at a run they are not looking at.
- **Ask for progress** only prefills `Briefly: what is done, current step and next step?` into an empty draft
  and focuses it; it never sends and never replaces an existing draft.

## Following and motion

Motion carries state and continuity only.

| Moment | Purpose | Tool | Properties | Curve / duration |
| --- | --- | --- | --- | --- |
| A new turn or technical step | state indication | CSS animation | `opacity`, `translateY(3px)` | `160ms cubic-bezier(.23, 1, .32, 1)` |
| Live status changes | state indication | CSS transition | `opacity`, `color` | `160ms cubic-bezier(.23, 1, .32, 1)` |
| Live dot while working | state indication | CSS animation | `opacity`, `scale` | `1.6s ease-in-out` loop |
| Panel / tab switch | continuity | none | — | instant |

Only appended turns and steps animate; retained history does not replay on load, refresh or tab switch. A live
run opens on its latest activity once. Scrolling follows new events and a growing `display` **only** when the
viewer was already at the bottom; scrolling up pauses following, keeps the reader's place, and reveals a
catch-up control that counts an in-place growth once, never one line per token. Stable keys, expanded
disclosures and the composer draft survive polls and transient errors. `prefers-reduced-motion: reduce` drops
the translate and the pulse and keeps a short opacity change.

## Layout

Activity uses the existing `.orc-panel__scroll` for the feed and the panel's flex column for the composer, so
there is no second viewport. The Now strip is sticky to the top of the scroll area and the new-activity control
to its bottom; both are one compact line. The composer is a read-only or editable row below the scroll area.

## Known limits

- **Startup baseline waits are invisible before the run exists.** A launch is accepted before the host records a
  run and before the first normalized event; the Now region can say *Starting* but cannot show baseline
  progress without a core pending-launch event. This note records the gap; no core scope was expanded here.
- The feed is the normalized `detail.events` of the latest run. An older run still opens the trace-backed
  `OlderRunActivity`; the two are intentionally different sources.
- A backend that never pairs a tool start with its result (Devin) never marks a step open, so the Now region
  says *Active* with the last step rather than guessing that a command is still running.

## Files

- `packages/core/src/runs/normalize.ts` — bounded public `display`, `truncated`, `updatedAt`, typed tool
  metadata and problem origin; legacy `text` unchanged.
- `packages/plugin/src/client/panel/feed-window.ts` — rolling-window overlap, stable keys, display growth.
- `packages/plugin/src/client/panel/conversation.tsx` — conversation projection and rendering.
- `packages/plugin/src/client/panel/live-activity.tsx` — phase helper, Now strip, follow behaviour.
- `packages/plugin/src/client/panel/activity-composer.tsx` — the docked steer composer.
- `packages/plugin/src/client/panel/task-panel.tsx` — default-tab policy, pinned choice, scroll and composer wiring.
- `packages/plugin/src/client/panel/tabs.tsx` — `FeedTab` delegates to the conversation; `groupEvents` kept.
- `packages/plugin/src/client/styles.ts` — scoped Activity styling.

## Independent integration review — 2026-09-28

The orchestrator reproduced tool ID reuse across CLI turns: an earlier completed item could hide a
new open call with the same ID. Matching now scopes IDs to the recorded turn; completion-before-start
ordering within a turn remains supported. Added direct regressions. Snapshot latestRunId also guards
cached older-run liveness and pending-message feedback while initial details load. A stale response
does not project another task's delivery error into the selected task.

Only the affected CLI main bundle ceiling was measured and rebaselined: 620.2 KiB to 624 KiB for
bounded public display/progress and compact machine projections. Other ceilings remain unchanged.
This is code-size and response-shape control, not a provider cache or token-savings measurement.
