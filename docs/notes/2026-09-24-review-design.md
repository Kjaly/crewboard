# rv5 · Review design proposal

**Result:** [Open the offline prototype](assets/review-prototype.html). It is a design artifact; no product code is changed. The [embedded JSON snapshot](assets/review-snapshot.json) was exported at **2026-09-24 00:01:50 UTC** from the sibling source repository's `.orchestration/plan.json` (revision **787**, updated 2026-09-23 23:59:13.632 UTC) and raw `runs/*/{state.json,events.jsonl}`. It contains 158 tasks, 142 runs, and a sampled ledger for eleven recent runs. The HTML embeds the same JSON, so `file://` needs no fetch, server, or network.

## Why the current screen reads flat

- **Hierarchy.** The current source renders Progress → Money and quota → Investigate → Runs as four consecutive `orc-block` sections. Progress and money each repeat three equal cards (`review.tsx`, `styles.ts` around `.orc-review__metrics` and `.orc-review__money`). An urgent decision competes with secondary accounting; every block asks for the same attention.
- **Colour.** The shell already has a semantic status vocabulary, but Review uses mostly `--orc-layer1` and hairlines. Its coloured step marks are a small optional overview in a run row and the strong ledger lives behind a run link. A person scanning the list cannot see the colourful path they remember. See `styles.ts` status tones and `panel/trace-ledger.tsx`.
- **Density.** A large metrics grid, long progress sentence, detailed accounting sources, filters, and a many-column run table consume the first screen. Repeated `—`, full IDs, and timezone strings carry more ink than the questions people came to answer. The independent [Review audit](2026-09-23-review-view-audit.md) and [rv4 check](2026-09-23-review-view-check.md) also call out missing-value semantics, table density, keyboard trace reachability, and incomplete historical verdicts.
- **Empty states.** “Not started” and “—” have the same large numeric styling as measured values. No-run, no-decision, unknown-cost, and filtered-to-zero situations mean different things; they need distinct sentences and next actions.

## Information order and visual treatment

1. **Needs you** is a full-width band immediately below the title. It shows the exact number awaiting a human decision and up to two task names when present. Amber is reserved for a decision waiting on the person. At zero, use a quiet green-tinted sentence and point to active work. Failed work remains red and gets a separate follow-up count; never imply it is ready to accept.
2. **Plan progress** is a compact, labelled distribution: accepted / running / ready / backlog / follow-up. Show the denominator and exclude superseded work. Accepted is green, but a small line below separates *result verified*, *disputed*, *negative*, and *legacy untyped* verdicts. The real snapshot illustrates why: 143 tasks are accepted, but only 14 carry an explicit `result` verdict, 37 `disputed`, two `negative`, and 90 untyped. “143 successful” would be false.
3. **Where time and money went** uses three small, differently shaped visual cues rather than another three huge metric cards: elapsed plus two independent thin bars for worker time and review wait; subscription quota movement with its account-window caveat; observed USD estimate and API cash availability. Do not make an additive time pie or a money-plus-quota total. A measured zero must differ from unavailable. The snapshot has +39 percentage points of legacy before/after quota deltas and USD 2.468604 in one raw run usage observation. It does **not** establish API cash from the raw run files. DSH billing is held separately; the prototype says “Not observed,” not USD 0. A later product implementation should use the `/api/cost` provenance and coverage contract.
4. **Runs to inspect** is a scan-friendly list. Task title, short worker/time, status, then a coloured step strip are the default row. Search is visible; the many facets, grouping, source IDs, token inventory, rates and quota windows move to a disclosure or detail. Every row is an actual control to the exact run, and selection is distinct from task context.
5. **Run detail** opens beside the list at 1440 and replaces the list at 1100. It repeats the strip above the shared step ledger, with a Back control at 1100. The ledger is the destination for an individual step; the strip is an overview and a route into it. Product implementation should reuse `LedgerView`, not duplicate its data or interaction model.

## Geometry

| Viewport | Main geometry | Detail behaviour |
| --- | --- | --- |
| 1440 px | Existing 248 px repository rail leaves about 1192 px. Main content has 34 px gutters; first band spans the content. Progress and time split approximately 60/40. Three compact resource cells follow. Runs use a flexible list and a 39% (at least 330 px) detail. | Open detail stays visible with selected row and ledger; both remain scannable. |
| 1100 px | Rail collapses to the existing 44 px form, leaving about 1056 px. Main content has 24 px gutters. Top band and progress remain readable; the resources still fit three cells. | Choosing a run gives detail the full main width, with Back to list. The same ledger content is used. |
| Narrow fallback | Single column progress/resources and 44 px rail. | Full-width run detail, no nested modal. |

The prototype toolbar lets the reviewer switch 1440/1100 without changing browser window size. Both modes can also adapt to a genuinely narrower window.

## Shared status and trace language

| Meaning | Token | Visible language | Where it agrees |
| --- | --- | --- | --- |
| Running | `--orc-accent-strong` / blue | solid dot + “Running / Выполняется” | Graph strip, Work, sidebar status dot |
| Waiting for you | `--orc-warn` / amber | dot or ◆ + “Waiting for you / Ждёт вас” | Graph review outline, Work acceptance, sidebar inbox |
| Failed | `--orc-error` / red | dot + “Failed / Ошибка” | shell failure and problem states |
| Accepted | `--orc-ok` / green | dot + “Accepted / Принято” | `statusTone`, Graph/Work completion |
| Idle/open | `--orc-fg3` / grey | word plus neutral dot | ready/backlog and unknown |

Status colour always appears with a word or glyph. The trace colours indicate *what happened*, never worker identity: **M** model blue (`--orc-k-model`), **T** tools purple (`--orc-k-cmd`), **E** edits amber (`--orc-k-edit`), **C** checks teal (`--orc-k-read`), **R** steers white (`--orc-k-input`), **!** problems red (`--orc-k-problem`), and **H** human input white. The prototype has a visible legend and a larger 9–12 px strip on every run. The product should use normalized `LedgerRecord.kind` from `packages/core/src/runs/ledger.ts`, collapse dense marks into buckets, preserve problems, and announce sample/completeness. The prototype's tool subtype is inferred from event labels and explicitly marked approximate. Strip position is sequence order in this static snapshot, not measured duration or cost share; in product it should use recorded elapsed positions with that distinction visible. The ledger uses selectable rows with letter, type, timestamp, and detail; no colour-only navigation.

## States to design and validate

| State | Treatment |
| --- | --- |
| Current real plan | Zero pending decisions is a calm sentence. 143 accepted of 157 in-scope tasks is shown alongside two running attempts and the typed-verdict caveat. Resource coverage and “Not observed” remain explicit. |
| Example plan | Prototype toolbar's **Example state / Пример состояния** switches to an illustrative 23-task plan with two waiting decisions. It is clearly labelled illustrative and demonstrates the amber top band; it does not overwrite the real JSON. |
| No tasks / no runs | “No runs yet” with an agent-start explanation. Progress shows the task count or a plain “No plan tasks yet,” not large “Not started” cards. Costs show “No measurements yet.” |
| No matches | Keep search text and show “No matching runs” plus Clear search. Do not replace it with “No runs yet.” |
| Loading, stale, unavailable | Keep the last verified snapshot labelled with its time; show update/retry separately. Unknown and pending measurement states retain their names; never convert to zero. |

## Fold or remove

- Fold token totals, accounting source IDs, rate provenance, quota windows, class/lane/worker filters, group/sort options, and extended run metadata into detail or “More filters.” Keep search and one high-value status filter in the list.
- Remove the inert progress-history disclosure until there is actual event history. Do not draw a trend from a single snapshot.
- Remove repeated full run IDs and timezone from every row. Show the ID in detail and expose a copyable deep link there.
- Replace the four equal grey blocks and the default plain table with one urgent band, one compact plan explanation, small resource visuals, then evidence-first run rows.
- Keep exact provenance and accounting semantics: subscription equivalent is an estimate, quota is an account-window measure, and cash is reported only when observed. Preserve the audit's caveats about historic terminal reconciliation and decision attribution.

## Implementation tasks

| Size | Files | Work and risk |
| --- | --- | --- |
| M | `views/review.tsx`, `styles.ts`, EN/RU dictionaries | Reshape the top into Needs you, progress distribution, and compact resources. Risk: overlapping running/ready counts and verdict semantics; derive mutually exclusive task buckets and keep disputed/untyped separate. |
| M | `views/review.tsx`, `views/review-index.ts`, `styles.ts` | Replace default table rows with accessible run rows and a visible strip/legend; keep current search, paging, route and filters behind disclosure. Risk: dense traces and large plans; use sampled overview with total/completeness. |
| M | `views/review-detail.tsx`, `panel/trace-ledger.tsx`, `app.tsx`, route/store code | Use one detail/ledger path at 1440 and full main area at 1100; restore focus and exact run/step when going back. Risk: durable navigation and keyboard seek. |
| S | `shared/types.ts`, cost/host projection, `insight.ts` | Expose explicit measurement coverage and timestamp for the small visuals. Risk: cash vs subscription equivalent and shared quota cannot be silently summed. |
| S | Review component tests, EN/RU layout and keyboard checks | Validate zero/unknown, example-like waiting/failed fixtures, list→detail→step→back, 1440/1100, and no overflow. Risk: long Russian labels and strips with many steps. |

No external references were used. Source basis: the files linked above, `packages/plugin/src/client/styles.ts`, `packages/plugin/src/client/views/review-detail.tsx`, `packages/plugin/src/client/panel/trace-ledger.tsx`, the two local Review reports, and the timestamped local orchestration snapshot.

## Prototype checks and limit

Static checks passed: the HTML embeds the exported JSON exactly; it contains no HTTP assets or fetches; the JavaScript passes `node --check`; the snapshot totals reconcile to 158 tasks and 142 runs; EN/RU, 1440/1100, example-state, run-row, and ledger-step handlers are present. `git diff --check` passed. Chrome's browser security policy rejected the local `file://` URL and explicitly prohibited alternate browser routes for the same page. Consequently actual browser rendering, clicks, visual overflow, and console behaviour at both widths and languages remain **unverified** here. The prototype is intended to open directly from the file system, but that specific check needs to be performed in an allowed browser session.
