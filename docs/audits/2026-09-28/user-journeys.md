# Crewboard through users' eyes — simulated journeys and UX audit

**Date:** 2026-09-28
**Scope:** research only. No product code, plan JSON, task status or other people's work was changed.
**Deliverable path:** `docs/audits/2026-09-28/user-journeys.md`

> This document walks three **simulated** people — not real humans — through real scenarios. Nothing here is a real interview: it is a structured reading of the code, the CLI, the checked-in screenshots, the tests and the shipped docs, plus one firsthand local CLI run and one live-stand sighting supplied by the orchestrator. Every claim is labelled **OBS** (observed in code/text/CLI/screenshot) or **HYP** (hypothesis that needs a real user to confirm). Real interviews and usability testing are still required (see §9).

---

## 0. Method, evidence and limits

| Evidence | What was used |
| --- | --- |
| CLI (real, v0.4.0) | Firsthand first-run in a throwaway `/tmp` git repo (`init`, `status`, `task add --template`, `run`, `accept`, `merge`, `attention`, `task show`); plus an isolated CLI audit with ~80 commands and exit codes. Binary `crewboard` 0.4.0 at the same commit as this worktree. |
| CLI help | `crewboard --help`, `crewboard help all`, plus the RU equivalents. |
| Screen code | `packages/plugin/src/client/*` (views, sidebar, panel, dicts), `packages/plugin/src/host/*`, shared core state derivation. |
| Checked-in screenshots | `docs/assets/{hero-graph,review,sidebar-needs-you,task-panel,work,run-ledger,settings}.png` — real captures, but of the **example/tour fixture** where actions are disabled (`welcome.exampleReadOnly`, `dict/en.ts`). |
| Tests | `packages/plugin/test/client/*` and `packages/cli/test/*` (they encode the intended behaviour and some intended wording). |
| Docs | `README.md`/`README.ru.md`, `docs/en|ru/*`, `docs/architecture.md`. |
| Prior research | `docs/notes/*` (synthesised separately; used to avoid reporting fixed things as new). |

**Limits, stated plainly.**

- CLI probes ran inside the worker sandbox. Registry-write and preflight permission failures establish behavior in a restricted agent environment, not a failure of ordinary desktop onboarding; Q1 and Q4 must be interpreted with that scope.
- **The browser stand is NOT RUN here.** `agent-browser` could not write its socket directory under the sandbox, and Chrome's CDP channel closed under the sandbox; direct headless Chrome was aborted by the operator. No screenshots were captured by this audit. **A missing browser is not an interface test**, so no claim below rests on "it renders fine".
- **One live sighting was supplied by the orchestrator**, who opened a small local stand separately (RU, `dsh-orchestra/main`, Work view). It is attributed as such in §4.5 and is the only real rendered observation in this document.
- The checked-in screenshots show the **example plan** ("Explore a plan in action"), where actions are disabled (`welcome.exampleReadOnly`). They prove the layout and copy, not the live action flow.
- Prior audits (`docs/notes/review-view-audit.md`, `2026-09-23-review-view-check.md`, `2026-09-23-review-design.md`, `2026-09-24-release-research.md`) all record the browser/stand as **blocked**. That evidence gap is still open.
- No external users are cited anywhere in the repo. Prior notes call their own findings "supplied observations, not independently measured totals".

**Read this as:** a map of where a user is likely to get stuck, with the exact control/state and a file:line you can check. It is not a sign-off.

---

## 1. The three simulated people

| Persona | Who | Setup | What they optimise for |
| --- | --- | --- | --- |
| **P1 — Ника, «новичок»** | Product engineer, first week with coding agents. | One git repo, `crewboard` installed, **no dsh chat**, no workers registered yet. Reads the README and the CLI. | "Get one task from zero to a merged result without breaking anything." |
| **P2 — Олег, «активный владелец»** | Runs 3 repositories with agents. | dsh `web` with the plugin, several workers, a plan per repo. Checks the board twice a day, mostly from the screen. | "See who needs me across repos and clear the queue in minutes." |
| **P3 — Ада, «опытный оркестратор»** | Drives a dsh chat that runs the plan; comfortable with `verify`, `attest`, `--auto`, worktrees. | A plan with a bound chat, orchestrator checking on, several completed runs. | "Let routine work close itself; spend my attention only where judgement is real." |

The scenarios below are grouped so the reader can follow one person start to finish; the question bank in §3 and the cross-cutting lists in §4 reuse the same observations.

---

## 2. Scenarios

### P1 — новичок

#### S1. First open (first run, no chat)
**Expected:** type a goal, get a plan, see what to do next.
**Actual (firsthand):**
```text
$ crewboard init --goal "Split the API into modules"
Plan created: /private/tmp/cb-ux-…/.orchestration/plan.json
Added to the Crewboard list, the screen shows it: /private/tmp/cb-ux-…
$ crewboard status
Split the API into modules · rev 0

Preset: Default: workers that pass checks (source: builtin)
0 of 0 open

Ready to start: —
Critical path: —
```
**What works:** `status` is short, names the preset, and uses `—` for "nothing yet". `task add --template` points at the exact contract file. The README's five-command short help (`help.short`, `packages/cli/src/i18n.ts:502`) is a good first screen.
**Friction (OBS):** `init` silently writes the machine-wide registry `~/.config/crewboard/repos.json` in addition to the plan; the help line only says "create the plan". In a read-only home this prints a raw filesystem error and exits `1` **after** the plan was created (`Plan created: …` then `No permission to write …/repos.json.tmp-…`). A newcomer reads "failed" for a half-success. Source: registry write in `packages/core/src/workspaces/registry.ts`; the partial-success ordering is observable in the CLI. See Q1.
**HYP:** a first-run user who only wants the CLI is surprised that a plan touches a global registry and a `plan.json.prev` sibling.

On the screen path (no repository listed yet), the welcome card says exactly what to do: `welcome.noRepos` "Type the path to a Git repository on this machine. In a terminal, `crewboard repo add` inside the repository does the same." with **Add** (`dict/en.ts:1336`, `welcome.tsx:95`). The minimum happy path is **4 clicks + 2 typed strings**: Orchestration icon → Add repository → Create plan → Create task (`welcome.tsx`; `app.tsx:293-303`). Three first-open frictions:
- **Raw, untranslated error on the teaching screen (High).** The Welcome add-path renders `result.message ?? result.error ?? t('welcome.error')` (`welcome.tsx:41-46`) while the host sends a raw code string such as `not_git: /path` (`core/src/workspaces/registry.ts:121`, `host/actions.ts:640-651`). The sidebar's own **+** maps the same codes to localized `side.addRepo.error.*` (`client/actions.ts:23-28`). A Russian newcomer meets `not_git: /Users/…` exactly where the product should be teaching. See Q21.
- **The plan-goal field is mislabelled (Medium).** The Welcome input's accessible name is the section fragment **"Or an empty plan"** (`welcome.emptyPlan`, `dict/en.ts:1331`; `welcome.tsx:91`), while the right-pane tab labels the same thing **"Plan goal"** (`panel.side.goalAria`, `dict/en.ts:691`). Screen-reader and automation users get the wrong name. See Q22.
- **A dead-end button (Low) and an unbounded spinner (Low).** On the zero-repo screen the worker-settings banner's **"Open worker settings"** sets state that the `if (!repo)` branch never renders (`app.tsx:293-300` vs `:457`; `worker-settings-banner.tsx:17`). If the onboarding-worker probe fails, `welcome.tsx:34-35` swallows it and the row stays **"Checking…"** forever (`welcome.checking`, `dict/en.ts:1297`).
The setup checklist shows `welcome.progress` "{count} of 3" for **Workers found / Preset chosen / Repository check** (`welcome.tsx:57-58`); the third one only fills in when a recipe is detected or saved (`welcome.tsx:37-40`), so a repo with no detected recipe can sit at "2 of 3" indefinitely with no explanation. **HYP** (self-explanatory? unknown without users). See Q2.
**Docs vs product (Medium):** README "Quick start A" step 2 says "With no plan yet, choose **From chat**", but with zero repositories the screen renders only the add-repository card; **From chat** exists only after a repo is connected (`README.md:79-80` vs `welcome.tsx:82-83,95-99`; the connect step is documented later at `README.md:67`). A brand-new user following the README top-down hits an instruction that is not on screen.

#### S2. First worker run (the contract wall)
**Expected:** `crewboard run api` starts the worker.
**Actual (firsthand):**
```text
$ crewboard task add api --title "Extract the API" --class code --template
+ api
  contract: .orchestration/contracts/main/api.md — fill in the result and the checks, then crewboard run api
$ crewboard run api
The contract of api is still the template skeleton, or its Result or Checks section is empty: fill in the contract first: .orchestration/contracts/main/api.md. To start it as is: crewboard run api --force.
[exit 1]
```
The message is good: it names the file and the escape hatch. **Friction (OBS):** the escape hatch `--force` is **not** in `crewboard help all` (the `Runs` section lists `-a`, `--scope`, `--contract`, `--skip-preflight`, `--allow-unmerged`, `--base`), only in the built-in usage string `runs.usageRun` (`packages/cli/src/i18n.ts:225`). A user who reads help to learn `--force` cannot find it. See Q3.

When the contract is filled and no worker is logged in, the run stops at preflight:
```text
✗ profile: Node.js v24.16.0 → dsh --profile acp --dump-config
Preflight for dsh/deepseek-flash failed — the launch is cancelled.
[exit 1]
```
The only human sentence names the worker and the cancellation, but the failing line is a raw command probe. Compare the auth case, which prints a fix (`✗ auth: not logged in → claude auth login`). **OBS**, cause hypothesis: the probe's stdout is surfaced where a diagnosis is expected. See Q4.

#### S3. A task that never ran reads "disputed"
**Expected:** no verdict until there is a run.
**Actual (firsthand, `task show` on a fresh task):**
```text
Last run
  no runs yet
Report
  no report yet
Verdict
  disputed — the report makes no explicit result claim
```
`verdict.ts:317-324` only exempts `decision`/`root` from the "no claim" mismatch; an `implement` task with `runs.length === 0` falls through to `mismatch = 'claim_missing'` and renders as **disputed** (`task-show.ts:105-107`). This is a **false alarm** on the very first task a newcomer inspects. Severity high. See Q5.

#### S4. blocked / unfinished — what does "nothing is happening" look like?
- A task waiting on a dependency shows `panel.status.blocked` "waiting" and `panel.now.blocked` "Waiting on: {tasks}." (`dict/en.ts:128,153`), with a **What is blocking this?** button (`panel.task.blocker`, `dict/en.ts:907`).
- An unfinished run shows `attempt.outcome.incomplete` "Ended unfinished" and offers **Continue** (`last-attempt.tsx:49`; `panel.task.incomplete*`).
**Friction (OBS):** if the blocking dependency was **dropped / superseded / closed negative**, `blockedBy` still lists it (`plan/graph.ts:157-163` requires `status === 'accepted'`), and the blocker button jumps to a task that says `panel.task.noAction` "Closed — nothing left to do." (`dict/en.ts:908`). The only way out is the task menu → **Close as not needed…**. The board warns (`board.negativeDep`, `dict/en.ts:173`) but offers no action. Soft **dead end**. See Q6.
**Friction (OBS):** a **cancelled** run produces no Needs-you row at all (`evaluateRun` returns `[]` for `cancelled`, `watch/rules.ts:111`); the user must remember to open the task. See Q7.

#### S5. First accept and merge
**Expected:** accept, then the work is in the base.
**Actual (firsthand, no TTY):**
```text
$ crewboard accept api
This command needs a person: if you are a person, run it in a terminal.
[exit 1]
```
The design (human-only acceptance) is deliberate and correct. **Friction (OBS):** the same sentence is returned for **any** state, including "nothing to accept", because the human gate is checked after the detail is computed but before it is printed (`packages/cli/src/commands/plan.ts:381-395`). An agent or a user piping output cannot learn *why*. And after a real acceptance the work is **not** merged: the task stays in the queue as **Accepted, not merged** and dependents wait (`needs-you.ts:129-135`; `docs/en/review.md:230-241`). The README explains this at step 6, but the accept confirmation itself says only "Changes are considered reviewed." (`host/i18n.ts`, `actions.accept.normal`). A newcomer is likely to think "accept" means "done". See Q8.

#### S6. Returning to the plan the next day
`crewboard status` gives a compact picture; `crewboard attention` gives the human queue:
```text
$ crewboard attention
All clear.
```
With a prepared decision it instead prints `Waiting on you: in this plan 1 · in this repository 1 — 1 decision` and the row (isolated CLI audit). The scopes are documented and consistent (`docs/en/review.md:13-15`).
**Friction (OBS):** `crewboard wait --for decision` does **not** return when a decision is already waiting; it waits for the *next* change, so a user who already has a decision pending times out unless they add `--tasks <id>` (source: `help.body` "waits for the next change; with `--tasks` …"). A literal reading of `--for decision` is "a decision is waiting". See Q9.

---

### P2 — активный владелец (multi-repo)

#### S7. First open of the screen across repos
The sidebar heading counts and scopes the human queue: `t('side.inbox')` + `scopeText(waiting)` (`sidebar.tsx:1298-1301`), rendering e.g. "Review queue · in this plan 1 · all 3". Repositories and their plans sit below (`side.repos`, `side.title`).
**Friction (OBS, label drift):** the shipped docs and the checked-in screenshots call this heading **"Needs you"** (`README.md:37`, `docs/en/review.md:13,17`, `docs/en/getting-started.md:152-154`) and the chip **"Waiting for you"** (`docs/en/review.md:13`). Current code renders **"Review queue"** for both the sidebar heading (`side.inbox`, `dict/en.ts:384`; asserted in `sidebar.test.tsx:107,124,150`) and the chip (`panel.app.queueCount`/`queueEmpty`, `dict/en.ts:651,667`; `app.tsx:437`). The key `review.yourWait` = "Waiting for you" / «Ожидание вас» (`dict/en.ts:614`, `dict/ru.ts:612`) is **referenced nowhere in `src`** — a dead label. A user reading the docs goes looking for a heading that no longer exists. See Q10.

#### S8. Triage the queue
The sidebar inbox groups by repository/plan and tags each row with its reason (`waiting.tag.*`): review / check off / blocked / decision / failed / may be stuck / worker gone / not merged (`dict/en.ts:403-410`). Hover / `side.inboxHint` explains the whole queue.
**Friction (OBS, false expectation):** in the checked-in screenshots the example plan shows **"1 review without the orchestrator check"** in its own Review band and a **"NEEDS YOU 1"** Work column, while the top chip and the sidebar both read **"in this plan 0 · all 3"**. That is by design — example rows are listed but never counted (`needs-you.ts:191-192`, `docs/en/review.md:13` "the example plan is listed while you look at it but never counted") — but nothing at the point of confusion says so, and the `welcome.syntheticData` banner is about money, not the count. See Q11.
**Friction (OBS):** the tag **"check off"** (`waiting.tag.checkOff`, `dict/en.ts:406`) is internal jargon; the long form is "1 review without the orchestrator check" (`waiting.reason.checkOff`). A user seeing the chip "check off" next to a task is unlikely to parse it. See Q12.

#### S9. Review + independent attestation
For a normal review the panel shows the verdict immediately before the action. The strongest labels are on the attestation side: **"Crewboard receipts (actual commands)"** vs **"Worker-reported check claims … (not receipts)"** (`dict/en.ts:73-74`) and "apart from the worker's report. The verdict is not changed." (`dict/en.ts:1569`). This is a genuine strength.
**Friction (OBS):** `attestation.current` / `attestation.historical` interpolate the **raw enum**: EN "Independent result attestation is current" / "Recorded result result was accepted…" — and RU «Независимая аттестация «result» актуальна» (`dict/en.ts:66-67`, `dict/ru.ts:65-66`; `task-panel.tsx:446-448`). The feed localises the same verdict (`note-text.ts:24`), so the panel is the odd one out. See Q13.
**Friction (OBS):** `verify --attest` prints a hard-coded English line with the raw verdict in both languages: `result attestation recorded for run… at …` (`packages/cli/src/commands/verify.ts:89`), and `task show` never prints the attestation record even though `--json` carries it (`task-show.ts:105-113`). A CLI user is told an attestation exists but cannot read it back except as JSON. See Q14.

#### S10. Decision in chat, then accept/merge
A decision task is prepared by the orchestrator, then waits for the person. The queue shows **Open decision** instead of Accept (`queue.tsx:103-107`). Three different names exist for closing it:
- task menu: **Accept…** (`menu.accept`, `dict/en.ts:4`);
- task panel button: **Confirm decision** (`panel.task.acceptDecision`, `dict/en.ts:905`);
- native dialog title: **"Close decision {task}? …"** (`host/i18n.ts`, `actions.accept.decision`).
**Friction (OBS, false expectation):** the panel help says **"Confirm decision — records this answer as yours and unblocks what waits on it."** (`dict/en.ts:912`, RU `dict/ru.ts:907`). The screen path calls `acceptTask` → `recordAcceptance`, which writes `{kind:'accepted'}` **without any answer text** (`review.ts:42-52`); only `crewboard decision answer` stores `answer`+`basis` (`review.ts:60-90`). So the panel promises a recorded answer it does not record. See Q15.
**Repeated clicks (OBS):** closing a decision and then merging accepted work are two separate native confirmations; **Accept in batch** never includes decisions (`review.ts:182`; `docs/en/review.md:47`). An owner clearing 8 reviews performs 1 batch confirm + up to 8 merges.

#### S11. Return to the plan after a week
The screen auto-refreshes: a full refresh every `refreshMs` (default **30 s**, min 5 s — `host/config.ts:8-9`, `service.ts:262`) plus an `fs.watch` on `.orchestration` with a 300 ms debounce (`service.ts:16-24,275`). Merge detection, run-finish bookkeeping, `check = pending` and `check_due` notes are all written by that background sync (`sync.ts:80,104-152`). **OBS:** none of this is surfaced; merges are detected and dependents released with no click. See §4.4.

---

### P3 — опытный оркестратор

#### S12. The routine "done without a human" path
For a routine positive result the code path is precise (`auto-close.ts:35-48`): completed (or recovered handoff) run + matching check by the **orchestrator** + positive verdict with no caution/warn facts + no `<human_review>` + no conflicts + clean copy + all required receipts green. Then `orchestra_close` / `accept --auto` + `merge --auto` accepts and merges with no click (`host/tools.ts:607-630`; `cli/commands/plan.ts:394`).
**Friction (OBS, high):** the panel says `check.pending` "Orchestrator will check this result, then close routine work automatically" (`dict/en.ts:1150-1151`). But the gate requires `check.by === 'orchestrator'` (`auto-close.ts:37`). A **person** who helps with `verify --done` in a TTY writes `by: 'person'` (`verify.ts:78` via `callerOf`, `authority.ts:23-25`), which silently **disables** the automatic close with no on-screen notice. See Q16.

#### S13. Independent attestation and freshness
`verify --attest --verdict result|negative|disputed --report <file> --note "…"` records an orchestrator judgement beside — not instead of — the worker report (`review.md:78-90`). Stale reasons are complete and mirrored EN/RU: `proof_missing`, `proof_changed`, `run_changed`, `head_changed`, `contract_changed`, `worktree_dirty`, `receipts_missing`, `receipts_changed`, `receipts_failed` (`dict/en.ts:80-88`, `dict/ru.ts:79-87`; `attestation.ts:28-49`). Acceptance and merge recheck freshness (`review.ts:24-30`, `merge-task.ts:117-119`).
**Friction (OBS):** for an experience level where "worker claim vs Crewboard receipt" matters, the panel framing "Independent {verdict} attestation" does not say the attestation is a second **authored document** by the orchestrator; combined with the raw-enum bug (Q13) the concept is harder to read than the receipts table below it. **HYP:** attestation may be under-used because its vocabulary is not explained at the point of use.

#### S14. Unfinished run → Continue / takeover
An incomplete run (`no_report`, `no_claim`, `left_uncommitted`) is not review and not a crash: the task stays ready, the panel offers **Continue**, and the hint is `crewboard continue <id>` (`watch/rules.ts:112-120`, `last-attempt.tsx:49`). `--takeover` preserves a copy without a rerun (`review.md:48,177`).
**Friction (OBS):** a **legacy / unreadable** run with no `finishedAt` becomes `history_unavailable` (`legacy-runs.ts:48`) but is shown as **running** (`graph.ts:168`) and then falls into the "May be stuck: quiet N min" branch (`watch/rules.ts:150-160`) because it has no events and an old start. The real condition is never named, and `Stop` is refused read-only (`actions.legacyReadOnly`, `client/actions.ts:20`). See Q17.

#### S15. Batch acceptance and the second move
**Accept in batch · N** pre-selects only clean work and groups at-risk items under **Open first** (`accept-batch.tsx`; `review.md:171-173`). Root tasks the orchestrator has not checked are named before asking.
**Friction (OBS):** the CLI has **no batch accept at all** (`docs/en/cli.md`: "There is no batch accept in the CLI"); an owner who works from the terminal accepts tasks one by one. **Friction (OBS):** the batch sheet keeps its ticks across snapshot refreshes, while the route refuses the **whole** batch if any id is no longer reviewable (`host/actions.ts:1228-1232`; `accept-batch.tsx:105-119`) — the user re-presses Accept and is refused with no per-row explanation. See Q18.
**Invisible work (OBS):** `automaticAcceptance` reads `checks.json` receipts silently (`auto-close.ts:41-47`), so a person cannot tell "blocked on a missing receipt" from "blocked on a conflict". See Q19.

---

## 3. Question bank (24 questions)

Each row: the exact screen/step, what the person would ask, what they expect, what Crewboard actually says, evidence, severity, and **OBS/HYP**.

| # | Persona / step | The question at the moment of work | Expected action | What Crewboard actually says | Evidence | Sev | OBS/HYP |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Q1 | P1, first `init` | "Did my plan get created?" | One success line; the plan exists. | `Plan created: …` **then** a raw `No permission to write …/repos.json.tmp-…` and `exit 1`. | Firsthand CLI; `workspaces/registry.ts` | med | OBS |
| Q2 | P1, welcome screen | "It says 2 of 3 — what is missing?" | Name the missing setup item. | `welcome.progress` "{count} of 3"; third item = a detected/saved recipe (`welcome.tsx:37-40,57-58`), otherwise unexplained. | `welcome.tsx`, dict | low | HYP |
| Q3 | P1, `run` on a template | "How do I start it anyway?" | The refusal names the exact flag. | Names `--force`, but `help all` never lists `--force` (`i18n.ts:225` vs `i18n.ts:264`). | Firsthand; CLI audit F3 | med | OBS |
| Q4 | P1, preflight failure | "What do I fix?" | A fix hint, like the auth case. | `✗ profile: Node.js v24.16.0 → dsh --profile acp --dump-config` + "the launch is cancelled". No fix. | CLI audit F14 | low | HYP |
| Q5 | P1, `task show` before any run | "Why is my brand-new task disputed?" | "No run yet" / no verdict. | `Verdict: disputed — the report makes no explicit result claim`. | Firsthand; `verdict.ts:317-324`, `task-show.ts:105-107` | **high** | OBS |
| Q6 | P1, blocked task | "The thing it waits on is closed — now what?" | Offer send-back/re-plan/drop. | Blocker button leads to `Closed — nothing left to do.`; only the task menu offers Drop. | `plan/graph.ts:157-163`; `dict/en.ts:907-908` | med | OBS |
| Q7 | P1, a stopped run | "Where did my cancelled run go?" | A queue row or a badge. | No attention row (`watch/rules.ts:111`); only the task's "Last attempt". | `watch/rules.ts:111` | med | OBS |
| Q8 | P1, first accept | "Accept = merged?" | State the merge step before confirming. | Accept dialog: "Changes are considered reviewed." Only afterwards: **Accepted, not merged**, dependents wait. | `host/i18n.ts`; `needs-you.ts:129-135`; `review.md:230-241` | med | OBS |
| Q9 | P1, `wait --for decision` | "A decision is already pending — why does wait time out?" | Return immediately, or explain the flag. | `Timed out waiting for task transitions` (`exit 2`); needs `--tasks <id>`. | CLI audit F12; `help.body` | med | OBS |
| Q10 | P2, first screen open | "Where is **Needs you**?" | The heading the docs name. | Sidebar heading is **Review queue** (`side.inbox`), chip is **Review queue · …**; docs/screenshots say **Needs you** / **Waiting for you**. | `dict/en.ts:384,651,667`; `sidebar.tsx:1298-1301`; `app.tsx:437`; `docs/en/review.md:13`; `docs/assets/*.png` | med | OBS |
| Q11 | P2, example plan | "It says 1 needs me but the counter says 0 — is it broken?" | Say examples are not counted where the 1 appears. | Nothing local explains it; only `needs-you.ts:191-192` / `review.md:13`. | checked-in `review.png`/`work.png`; code | med | OBS |
| Q12 | P2, triage row | "What does **check off** mean?" | Plain words. | Raw tag `check off` (`waiting.tag.checkOff`). | `dict/en.ts:406`; `sidebar-needs-you.png` | low | OBS |
| Q13 | P2/P3, attestation | "What is 'Independent **result** attestation'?" | Localised verdict + "a second, authored review". | Raw enum in EN and RU: "attestation «result»". | `dict/en.ts:66-67`, `dict/ru.ts:65-66`; `task-panel.tsx:446-448` | med | OBS |
| Q14 | P3, CLI attest | "Show me the attestation I just recorded." | A section in `task show`, localised. | `verify --attest` prints hard-coded EN + raw enum; `task show` omits it (JSON-only). | `cli/commands/verify.ts:89`; `task-show.ts:105-113` | med | OBS |
| Q15 | P2/P3, decision | "Where did my answer go?" | The recorded answer + basis. | Panel says it "records this answer as yours"; the screen path stores no answer (`review.ts:42-52`). | `dict/en.ts:912`; `review.ts:42-52` | **high** | OBS |
| Q16 | P3, auto-close | "Why didn't it close itself after I helped check it?" | Say that a person's check disables auto-close. | No notice; gate silently requires `check.by === 'orchestrator'`. | `dict/en.ts:1150-1151`; `auto-close.ts:37`; `verify.ts:78` | **high** | OBS |
| Q17 | P3, legacy run | "Why is this old run 'may be stuck' forever?" | Name `history_unavailable`; offer a new run. | "May be stuck: quiet N min"; Stop is refused read-only. | `legacy-runs.ts:48`; `graph.ts:168`; `watch/rules.ts:150-160` | med | OBS |
| Q18 | P2/P3, batch accept | "I ticked 6, why did the whole batch fail?" | Per-row reason / re-validate ticks. | Whole batch refused if one id is no longer reviewable (`host/actions.ts:1228-1232`). | `host/actions.ts`; `accept-batch.tsx:105-119` | low | OBS |
| Q19 | P3, routine close | "What exactly is it waiting on — checks or a conflict?" | Show the failing gate. | `automaticAcceptance` reads receipts silently; no reason is surfaced. | `auto-close.ts:41-47` | med | HYP |
| Q20 | P2/P3, Work board | "A task running a command for 1 minute is already 'needs attention' in **To review** — do I need to do something?" | Keep running tasks in **Running** until the documented 30-min threshold. | Work board moves it to **To review**/«На разборе» with a `!` "needs attention" and "Command running 1 min", while the top counter says 0. | Orchestrator sighting §4.5; `work.tsx:18`; `needs-you.ts:91-93`; `watch/rules.ts:156-158`; `docs/en/troubleshooting.md:59` | **high** | OBS (sighting) / cause OBS (code) |
| Q21 | P1, Welcome add repository | "I pasted a path and got `not_git: /Users/…` — what did I do wrong?" | The same localized message the sidebar's **+** shows. | Raw host code string; the sidebar maps it to `side.addRepo.error.*` but the Welcome does not. | `welcome.tsx:41-46`; `core/src/workspaces/registry.ts:121`; `host/actions.ts:640-651`; `client/actions.ts:23-28` | **high** | OBS |
| Q22 | P1, Welcome "Or an empty plan" field | "What is this field called?" (screen reader / automation) | "Plan goal". | Accessible name is the section fragment **"Or an empty plan"**; the right-pane twin is **"Plan goal"**. | `welcome.tsx:91`; `dict/en.ts:1331,1332,691`; `right-panel.tsx:98-108` | med | OBS |
| Q23 | P2, multi-repo navigation | "I clicked a plan to look at it — why did a task open?" | A click on the plan row switches plan. | With hidden `waitingHuman > 0`, the same click also selects the first waiting task (`openWaiting`); the icon opens the review centre. | `sidebar.tsx:769-782`; `store.ts:563-583`; `panel.tsx:10` | low-med | OBS |
| Q24 | P1, no-repo screen | "I clicked **Open worker settings** and nothing happened." | A settings screen opens, or the button is absent. | The `if (!repo)` branch sets `settingsOpen`, which only the main branch renders; a failed onboarding-worker probe also leaves **"Checking…"** forever. | `app.tsx:293-300,457`; `worker-settings-banner.tsx:17`; `welcome.tsx:34-35` | low | OBS |

---

## 4. Cross-cutting findings

### 4.1 Repeated clicks and extra steps
1. **Accept then merge** are two confirmations and two states; on the screen each is a native macOS dialog, and the work is not in the base until the second one (Q8; `review.md:230-241`). An owner clearing the queue does 1 confirm per review + 1 per merge.
2. **Batch accept still needs per-task merges** and never includes decisions (`review.ts:182`).
3. **No batch accept in the CLI**, by design (`docs/en/cli.md`), so terminal-first users repeat `accept` and `merge` per task.
4. **`send back` + rerun** is one confirmation (`--rerun`), which is a good consolidation, but plain **Send back** then leaving the review queue requires re-opening the task to see the reply (`review.md:57`).
5. **Duplicated acceptance surfaces** with inconsistent affordances: panel **Accept** (no ellipsis) vs menu **Accept…** vs queue **Accept** vs **Accept in batch** vs menu **Accept selected…** (`task-menu.tsx`; `queue.tsx`; `accept-batch.tsx`). The panel's Accept opens a modal without the "…" cue.
6. **Decision closing is named three ways** (Accept… / Confirm decision / Close decision) (Q15).
7. **`run` on a template costs a round trip** to read `--force` from the error because help omits it (Q3).
8. **Adding a repository exists twice** with different labels and different error handling: Welcome **Add a repository** (`welcome.tsx:95`) vs sidebar **Add repository** (`sidebar.tsx:1324`); only the sidebar localizes failures (Q21). Below 1100 px the rail is collapsed by default (`app.tsx:47-57`), so a second repo costs open-rail + **+** instead of the Welcome's one click.
9. **Starting a plan exists twice** with different labels and different error handling: Welcome **"Or an empty plan" / Create plan** (`welcome.tsx:91`) vs the right-pane **"Plan goal" / Start a plan** (`right-panel.tsx:98-108`).

### 4.2 False expectations
1. **"Needs you" / "Waiting for you"** in docs vs **"Review queue"** in code (Q10).
2. **"Accept" reads as "done"** but leaves **Accepted, not merged** (Q8).
3. **"Orchestrator will … close routine work automatically"** is skipped when a person records the check (Q16).
4. **"Confirm decision — records this answer as yours"** does not record an answer on the screen path (Q15).
5. **"Result received"** can read as a verified state; the qualifier ("reported as run") lives in the facts below (`verdict.result`, `dict/en.ts:65` vs `verdict.fact.checks_run`).
6. **The tour tells you to accept**, but the example it runs on disables actions: `welcome.tour3` "…then accept or send back the task" vs `welcome.exampleReadOnly` "Example only · actions are disabled" (`dict/en.ts:1382,1396`).
7. **RU CLI help says `accept` is terminal-only and omits `--auto`/`--into`**, while the built-in usage and the RU docs document them (§6.2; `dict-ru.ts:270` vs `i18n.ts:264`, `docs/ru/cli.md:111-112`).
8. **`task show` shows a verdict before any run** and says "disputed" (Q5).
9. **`wait --for decision`** sounds like "is a decision waiting?" but means "the next transition" (Q9).
10. **`workers` lists 2 eligible workers for `code`** while the refusal accepts 10 (fallback included), and `task set --worker claude/opus` then succeeds (CLI audit F7; `authority.ts:37-45,107-109`).
11. **README "Quick start A" step 2** tells a zero-repo user to "choose **From chat**", but **From chat** only exists after a repository is connected (`README.md:79-80` vs `welcome.tsx:82-83,95-99`). The connect step is documented later (`README.md:67`).
12. **The Welcome goal field is labelled "Or an empty plan"**, not "Plan goal" (`welcome.tsx:91`; `dict/en.ts:1331,1332`), and the right-pane twin uses the correct name (`dict/en.ts:691`).
13. **Clicking a plan can open a task instead.** With hidden `waitingHuman > 0`, the plan-row click also selects the first waiting task (`sidebar.tsx:769-775`; `store.ts:563-583`), and the Orchestration icon opens the review centre (`panel.tsx:10`). The same gesture means two different things depending on an invisible count.
14. **Dead ends on the first-open screen:** **Open worker settings** sets state nothing renders (`app.tsx:293-300,457`), and a failed onboarding-worker probe leaves **"Checking…"** forever (`welcome.tsx:34-35`; `dict/en.ts:1297`).

### 4.3 Outdated / confusing labels
1. **Needs you → Review queue** and **Waiting for you → Review queue**: code renamed, docs and screenshots not (Q10); `review.yourWait` is a dead key.
2. **Work column** is **"To review"** (`work.needsYou`, `dict/en.ts:522`) while the checked-in `docs/assets/work.png` shows **"NEEDS YOU"**.
3. **`check off`** tag is jargon (Q12).
4. **RU "review" has four renderings**: «Итоги» (Review screen), «На разборе» (review status), «ждёт приёмки» (in review), «ждёт ревью» (waiting reason); docs say «Приёмка». EN keeps review/acceptance distinct.
5. **`status` line "orchestrator is checking"** vs the dedicated `check.state.checking` "The orchestrator is checking" — same concept, two strings (`dict/en.ts:1149` vs `1537`).
6. **`process.check` RU** drops "orchestrator" («Проверка»), colliding with contract checks and `verify --run-checks`.
7. **"Accepted, not merged"** appears as `panel.essence.unmerged` "accepted, not merged" and `waiting.reason.unmerged` "accepted, not merged" — consistent, but the Review band's "Accepted with result" numerator counts disputed/legacy runs as success in some views (prior notes rv4 I3; verify before treating as current).
8. **Run-ledger step kinds** render as single letters `H/M/T/E/C/I/R` with a legend (`panel.ledger.kind.*`, `run-ledger.png`); the legend exists but is easy to miss.
9. **`settings.png` shows a Russian disable-reason chip** «временно: беречь лимиты подписки Claude» inside an otherwise English UI. This is user-authored data deliberately left untranslated (`architecture.md`: "User-authored names, contracts, and reports remain unchanged"), but visually it reads as a missing translation. **OBS**, not a bug.
10. **`panel.task.blocker` RU** «Что блокирует» lost the question mark EN has (`dict/en.ts:907`).
11. **Dead strings that still ship:** `review.yourWait` "Waiting for you" (`dict/en.ts:614`) and `panel.app.noRepos` "No repositories connected. Add a path in the plugin settings (repos) or set CREWBOARD_REPOS." (`dict/en.ts:660`) are referenced **nowhere** in `src`/`test`; the shipped zero-repo state is the Welcome form.
12. **The left rail is named three ways:** nav `aria-label` **"Repositories"** (`side.title`), visible heading **"Orchestration"** (`panel.tab`, `sidebar.tsx:1242`), tree section **"Repositories"** (`side.repos`) — tests address it as the navigation named "Repositories".
13. **RU header chip contradicts its own tooltip:** visible label "Очередь разбора · {count}" (`panel.app.queueCount`, `ru.ts:665`) vs tooltip "Очередь приёмки" (`panel.app.queueTitle`, `ru.ts:652`); the Review panel says "Очередь приёмки" (`queue.title`) while the sidebar says "Очередь разбора" (`side.inbox`).
14. **EN mixes "awaiting review" and "waiting for acceptance"** for one state: `panel.status.inReview`/`side.badge.review`/`board.review` vs `notify.ready`/`notify.planWaiting`/`notify.waitingCount` (both asserted in tests).
15. **RU register splits «ты/вы»:** `side.addRepo.hint` and `side.missingHint` use «ты» («Вставь», «Убери») while `welcome.*` uses «вы» («Введите», «Попросите»).

### 4.4 Invisible background work
All from the background-work inventory; each is something the person cannot see happen.

| What | Trigger / interval | User-visible trace | Effect |
| --- | --- | --- | --- |
| Full repo refresh (sync, merges, evidence, checks-due, quota) | `setInterval` **30 s** default, min 5 s (`service.ts:262`, `config.ts:8-9`) | none (SSE re-render) | writes merges, run finishes, `check=pending`, quota-after (`sync.ts:80,104-152`) |
| `.orchestration` watcher | `fs.watch` recursive, 300 ms debounce (`service.ts:16-24,275`) | none | same, on any external write |
| Automatic worktree cleanup | every refresh, at most once per 5 min; default policy «после приёмки» (`gc.ts:269,281-291`) | only a feed note (`feed.note.worktree.removed`) | deletes accepted+merged+clean copies beyond the 3 newest (`gc.ts:25,213-216`) |
| Merge detection | every sync (`merged.ts:229-266`) | only a note for content matches | sets merged, releases dependents silently |
| Orchestrator chat waker | 5 s window (`chat.ts:299,326`) | a chat turn | can accept+merge via `orchestra_close` with no screen badge |
| Orphaned worker recovery | on orphan detection | "Worker gone" while pending | Crewboard SIGTERM/SIGKILLs the run itself (`cli-backend.ts:39-41,146`) |
| Preflight cache | TTL 5 min (`preflight/cache.ts:7,22`) | none | a stale green can mask an expired login for 5 min |
| Notification presence heartbeat | client every 10 s, host TTL 30 s (`attention.ts:482,505`; `presence.ts:17`) | none | decides whether the macOS fallback fires |
| Live detail polling | task panel 2 s, review detail 5 s | data updates in place | no "live" marker |

### 4.5 The live-stand sighting (orchestrator, attributed)
The orchestrator opened a real local stand separately (RU, `dsh-orchestra/main`, Work view) and observed:

> The process header said «В работе 3». One DeepSeek audit was still executing a `Read detail.ts` command for about a minute. The Work board had moved that task into **«НА РАЗБОРЕ 1»** («To review») with **«требует внимания»** and the message **«Команда выполняется 1 мин»**, while the top Review-queue chip correctly said **«в этом плане 0»**. The other two active audits stayed under **«ИДЁТ 2»**.

This is a real, rendered inconsistency between two counts on the same screen. It is a **sighting**, not a process failure: the task was running normally.

**Cause (OBS, code):** the Work board decides its columns with a *different* attention filter than the canonical counter.

- `workColumns` puts a task in the first column if it has **any** attention entry: `attention.has(task.id)` (`work.tsx:18`), where `attentionByTask` keeps every entry regardless of severity (`board.tsx:26-30`).
- The canonical count filters through `countsAsAttention`, which for `kind === 'running'` requires `severity === 'alert'` (`needs-you.ts:91-93`).
- The watcher raises `kind: 'running'` at **warn** as soon as a command is in flight, and only at **alert** after `commandStuckSec = 1800` s (30 min) (`watch/rules.ts:14,20-27,156-158`).
- Therefore a 1-minute command (warn) is shown in **«На разборе»/To review** with a `!` "needs attention" and the text "Command running 1 min" (`board.tsx:53-55,71-75`), while `waitingCounts` correctly excludes it (`needs-you.ts:223-233`).
- This contradicts the documented intent in `docs/en/troubleshooting.md:59`: "**Needs you** lists a running task only once a command outlasts 30 minutes or a quiet spell outlasts 20…".

**Consequence:** a running task can be pulled out of the **Running** column into **To review** merely because it has been executing a command for a minute, and the two numbers on screen disagree. The question "does this need me or only the orchestrator?" has no unambiguous answer. See Q20 and R1.

---

## 5. Done without a human, and genuinely human

### 5.1 Three paths that can finish with no human click (code-supported)
1. **Routine checked worker result.** Completed run + orchestrator check + positive clean verdict + no `<human_review>` + no conflicts + clean copy + all required receipts green → `orchestra_close` / `accept --auto` accepts and `merge --auto` merges (`auto-close.ts:35-48,52-62`; `tools.ts:607-630`; `cli/commands/plan.ts:394`). A **current positive attestation** can substitute for the check state in the accept gate (`auto-close.ts:37`).
2. **Recovered incomplete run.** `left_uncommitted`/`no_claim` with an orchestrator `--report` bound to the checked commit and green receipts auto-closes (`auto-close.ts:29-30,43-47`; `cli-auto-close.test.ts`).
3. **Merge detection.** On every sync, ancestry/squash/content detection sets the task merged and releases dependents with no click (`merged.ts:124-148,229-266`). Also, `decision answer` closes a chat-given decision with no terminal (`review.ts:60-90`), and `decision prepare` returns one to preparation (`review.ts:98-118`).

### 5.2 Three paths where a human decision is genuinely required (code-supported)
1. **A decision task.** A new decision answer or a panel confirm is the person's; `answerDecision` is idempotent but a new answer needs the person (`review.ts:60-90`; `host/actions.ts:1174-1196`).
2. **Negative / disputed / deviation / `<human_review>` work.** Auto-close requires `kind === 'result' && !caution` and no warn/bad facts (`auto-close.ts:38-39`); the panel makes **Send back** primary (`review.md:146-147`).
3. **Conflicts, dirty base/copy, wrong branch, and the merge itself without `--auto`.** `merge-tree` refusal keeps it for a person (`merge-task.ts:96-130`; `merge.ts:28`); also `reject`, `drop`, `supersede`, `mark-merged` are human-only, and turning the check off needs a terminal confirm (`verify.ts:160-161`).

A useful mental model to surface in the product: **the only click the design is trying to save is "routine accepted work"**; everything judgement-shaped is correctly human.

---

## 6. EN/RU availability and clarity

### 6.1 Availability (set difference and fallbacks)
- **Client dicts:** EN and RU differ by **exactly one key**: `internal.testFallback` (`dict/en.ts:115`) exists only in EN, a deliberate test seam; **no RU-only key** (independent counts: 1719/1718 occurrences, 1644/1643 line-leading). Host dict (`host/i18n.ts`) and core message dict (`orchestration/messages.ts`) are key-for-key equal.
- **CLI dicts:** no EN-only key; 14 RU-only plural forms (`.few`/`.many`) that fall back to `.other` correctly.
- **Shape asymmetry (works, but inconsistent):** five keys are plain strings in EN and plural objects in RU (`side.badge.review`, `side.badge.failed`, `side.lanes.count.review`, `side.lanes.count.ready`, `side.lanes.count.accepted`).
- **Hard-coded English that bypasses the guard:** CLI `'Example plans cannot be watched'` (`cli/commands/runs.ts:120`); core `review.ts:32`, `auto-close.ts:48,66`, `backends.ts:111,150`. The i18n guard only scans plugin client/host for **Cyrillic** (`scripts/lint-i18n.mjs:20,36`), so English-only strings anywhere and all CLI/core strings are invisible to it.
- **CLI locale selection** reads `LC_ALL || LANG` only (`cli/i18n.ts:530`); `LANGUAGE` and `LC_MESSAGES` are ignored, and `LC_ALL=C` silently suppresses `LANG=ru` (CLI audit F9).

### 6.2 Clarity (same concept, different words)
| Concept | EN in code | RU in code | Docs | Problem |
| --- | --- | --- | --- | --- |
| The human queue | `side.inbox` "Review queue"; chip "Review queue" | «Очередь разбора» | "Needs you" / "Waiting for you" (README, review.md, getting-started) | code ≠ docs ≠ screenshots (Q10) |
| Work column | `work.needsYou` "To review" | «На разборе» | "Needs you" | three names (Q20) |
| Review / acceptance | `review.title` "Review"; `panel.status.inReview` "awaiting review"; `queue.title` "Review queue" | «Итоги»; «ждёт приёмки»; «Очередь приёмки» | «Приёмка» | RU mixes «Итоги», «разбор», «приёмка», «ревью» |
| Attestation verdict | "Independent **result** attestation" (raw enum) | «аттестация «result»» | "positive attestation" | raw protocol value in both (Q13) |
| Orchestrator check | `process.check` "Orchestrator check" | `process.check` "Проверка" | "orchestrator's check" | RU drops "orchestrator" |
| Accept/merge hints | `accept [--auto]`, `merge … [--auto] [--into branch]` | `accept <id>` (terminal-only), no `--into` | RU docs do list them | RU help contradicts behaviour |
| Built-in preset | "Default: workers that pass checks" | `dict-ru.ts:60` "Все воркеры" vs `authority.ts:50` "По умолчанию: воркеры, прошедшие проверку" | same | two RU names in one product |
| Dropped / superseded | dropped / superseded | «закрыта как ненужная» / «вытеснена» | «отброшенные» / «заменённые» | doc/code drift |
| Status labels | `panel.status.blocked` "waiting"; `board.blocked` "Waiting"; `panel.status.accepted` "accepted" | «ждёт»; «Ждёт»; «принята» | "blocked"; "accepted" | docs keep the machine word, UI doesn't |
| Header chip | `panel.app.queueCount` "Review queue · {count}" | `panel.app.queueCount` «Очередь разбора · {count}» **vs tooltip** `panel.app.queueTitle` «Очередь приёмки» | "Waiting for you chip" | RU label ≠ RU tooltip ≠ RU sidebar heading |
| In-review state | `panel.status.inReview` "awaiting review" vs `notify.ready` "waiting for acceptance" | «ждёт приёмки» in both | "in review" | one EN state, two EN names |
| Left rail | nav "Repositories"; heading "Orchestration"; section "Repositories" | «Репозитории»; «Оркестрация»; «Репозитории» | docs say "Orchestration" | three names for one rail |
| Plan goal field | `welcome.emptyPlan` "Or an empty plan" (Welcome) vs `panel.side.goalAria` "Plan goal" (right pane) | «Или пустой план» vs «Цель плана» | "goal" | same field, two accessible names |
| Repo-add hint | `side.addRepo.hint` "Paste… Enter adds it." | «Вставь… Enter — добавить.» | formal «вы» in `welcome.*` | RU register «ты/вы» split |

**Verdict:** RU is *available* almost everywhere (no missing keys), but it is not always *clear*: the same lifecycle step is named up to four ways, and several protocol values leak untranslated. EN is clearer but the docs/screenshots describe labels the code no longer renders.

### 6.3 States that need an accessibility/clarity pass
- Tag chips are text-only badges (`review`, `check off`, `may be stuck`, `worker gone`); the `!` uses `aria-label` "needs attention" (`board.attentionAria`), which is good, but a sighted user reads only the tooltip-free chip.
- The ledger's single-letter kind codes and the "3 approximate marks" legend (`panel.ledger.approximate`, `panel.ledger.kind.*`) assume the reader studies the legend.
- `—` and "Not started" are styled like measured values in several empty states (prior notes; re-verify in a real render).

---

## 7. Recommendations (concrete, no code)

Ordered by user impact per unit of change.

1. **R1 — Make the Work board use the canonical waiting filter.** In `workColumns`, filter attention through `countsAsAttention` before moving a task out of **Running** (or split "running with a warn" into Running and keep only alert/stuck/worker-gone/failed in "To review"). This removes the live-stand mismatch (Q20) and restores the documented 30-minute rule. Also make the column's own count and the top chip provably equal, and add a test asserting the two numbers agree for a warn-`running` task.
2. **R2 — One name for the human queue.** Pick **"Review queue"** (current code) or **"Needs you"** (docs) and update the other in the same change: `side.inbox`, `work.needsYou`, `panel.app.queue*`, the docs (README/review/getting-started), the checked-in screenshots, and delete or wire the dead `review.yourWait` key.
3. **R3 — Never show a verdict before there is a run.** Gate the `task show`/panel verdict on `runs.length > 0` (or label it "no run yet") so a new task cannot read **disputed** (Q5).
4. **R4 — Tell the truth about auto-close.** When a person (TTY) records `verify --done`, either keep the auto path eligible or say once, on screen and in the CLI, that the person's check means the orchestrator will not auto-close (Q16). Amend `check.pending`/`check.checking` copy accordingly.
5. **R5 — Record the decision answer on the screen path too.** Either store the selected option/text in `recordAcceptance` like `answerDecision` does, or change `panel.task.decisionAcceptHelp` so it stops promising a recorded answer (Q15).
6. **R6 — Localise and surface attestations.** Pass the localised verdict into `attestation.current`/`historical`, and print the attestation record (verdict, by, at, HEAD, contract revision, stale reason) in `crewboard task show` (Q13, Q14).
7. **R7 — Fix the RU CLI help to match behaviour.** Add `[--auto]` to `accept`, `[--into branch] [--auto]` to `merge`, and stop calling accept terminal-only in `dict-ru.ts:270`; make the built-in preset one name in RU (see §6.2).
8. **R8 — Surface the invisible background work that changes the user's state.** A one-line, dismissible "what changed while you were away" summary on the plan (merge detected, run finished, check due, worktree removed, draft advanced) would convert several silent mutations into visible facts. Start with automatic worktree removal (a toast or a Needs-you-style note, not only a feed line).
9. **R9 — Give blocked-with-closed-dependency a way out.** Offer **Drop** / **Supersede** / **Re-link dependency** directly from the blocker state, and make the board warning actionable (Q6).
10. **R10 — Make `--force` and other error-advertised flags discoverable.** Add error-advertised flags (`--force`) to `help all`, and consider forwarding `--help` on subcommands to the built-in usage strings instead of treating it as a task id (`run --help → No task --help.`) (Q3; CLI audit F2).
11. **R11 — Explain "0 vs 1" for the example plan at the point of confusion.** A small "example — not counted" label on the example row/band; today only `needs-you.ts:191-192` and one docs sentence (`docs/en/review.md:13`) explain it (Q11).
12. **R12 — Make `settings.png`'s user-authored RU chip legible in an EN UI.** Keep the user's words, but render them in the "note" style that says "authored" rather than a status chip style that reads as UI copy (OBS only; no product bug).
13. **R13 — Align docs and screenshots with the current labels as a do-not-regress check.** The docs check (`scripts/check-docs.mjs`) verifies links, not label parity; a tiny allow-list test asserting the three headline labels (sidebar, chip, Work column) appear in the docs would catch the next rename.

---

## 8. Severity summary

| Severity | Findings |
| --- | --- |
| **High** | Q5 (`task show` disputed before any run), Q15 (decision answer not recorded), Q16 (person's check disables auto-close silently), Q20 (Work board vs counter mismatch; running task as "needs attention"), Q21 (raw `not_git:` error on the first-open screen) |
| **Medium** | Q1, Q3, Q6, Q7, Q8, Q9, Q10, Q11, Q13, Q14, Q17, Q19, Q22, Q23; invisible auto-merge/worktree-removal; RU help vs behaviour |
| **Low** | Q2, Q4, Q12, Q18, Q24; dead `review.yourWait` and `panel.app.noRepos`; plural-shape asymmetry; single-letter ledger legend; rail named three ways |

Counts: **24 questions** across 3 personas and **15 scenarios**; **5 high**, **14 medium**, **5 low**; roughly **40 distinct observations**, of which ~33 are **OBS** and ~7 are **HYP**.

---

## 9. What still needs real user research

This audit is inference from code and one live sighting. To turn the HYP rows into facts and to check the OBS rows for real impact, the following are still needed:

1. **Real first-run usability sessions** with 5+ people who have never seen Crewboard: do they find the contract requirement, the welcome 3-step checklist, and the "Review queue" (or "Needs you") heading? Watch Q1, Q2, Q3, and the first-open dead ends Q21 (raw `not_git:` error), Q22 (goal-field label) and Q24 (dead worker-settings button). Measure the real click count against the code-derived "4 clicks + 2 typed strings".
2. **A rendered run of the Work/Review/task panel** in EN and RU at 1440 and 1100 px, with a real running task, to confirm Q20, Q10, Q11 and the label clashes. Prior notes and this audit both had the browser blocked.
3. **A timed "clear my queue" task** with a multi-repo owner to measure the accept→merge confirmations and the batch behaviour (Q8, Q18).
4. **An orchestrator-close session** where the orchestrator checks and closes routine work, then a person helps with one `verify --done`, to confirm Q16 and Q19 in practice.
5. **Comprehension tests on the attestation vocabulary** ("Crewboard receipts", "Worker-reported claims", "Independent attestation") with people who did not write the docs (Q13, Q14).
6. **Non-macOS acceptance behaviour** (the screen cannot confirm at all off darwin — `native.ts:19-22`), to confirm the "Cancelled in confirmation dialog" message is understood as a platform limit, not a user cancel.
7. **Interviews** with people who keep long-running agents: what do they expect a "command running 1 min" card to mean? (Q20).

No real person was contacted for this document; no statuses were changed; the plan JSON was not edited.

---

## 10. Appendix — evidence provenance

- CLI v0.4.0 at commit `0f4a6f2`; firsthand run in `/tmp/cb-ux-*`; isolated CLI audit in `/tmp/crewboard-cli-audit-*`.
- Screen source: `packages/plugin/src/client/**`, `packages/plugin/src/host/**`, `packages/core/src/**`.
- Checked-in screenshots: `docs/assets/{hero-graph,review,sidebar-needs-you,task-panel,work,run-ledger,settings}.png`.
- Docs: `README.md`, `README.ru.md`, `docs/en/*`, `docs/ru/*`, `docs/architecture.md`.
- Prior research: `docs/notes/*` (used to avoid re-reporting fixed items; notably the old i18n exemptions, the right-pane placeholder and the steer-to-finished guard are **already fixed** and are not reported as new).
- The live-stand sighting in §4.5 was supplied by the orchestrator; this audit did not capture it.
