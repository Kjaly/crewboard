# Changelog

All notable changes to Crewboard are documented here. This changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The public history starts with the first public snapshot of the repository (0.3.0, pushed to GitHub on 2026-09-24 without a tag or an npm release); its changes are folded into 0.4.0, the first release. The 0.1.0 and 0.2.0 entries below describe internal milestones from before that snapshot, under the working name dsh-orchestra; they were never published and have no Git tags.

## [0.4.0] - Unreleased

First public release. Crewboard is published as two npm packages: [`crewboard`](https://www.npmjs.com/package/crewboard), the command-line interface, and [`dsh-crewboard`](https://www.npmjs.com/package/dsh-crewboard), the DeepSeek Harness plugin.

### Added

- **npm packages.** `npm install -g crewboard` installs the CLI as `crewboard` and `orch`; `dsh plugin --profile web add dsh-crewboard` adds the screen to dsh. The CLI bundles the plan engine and has no private runtime dependency. Releases are published from CI with npm trusted publishing.
- **Repository sidebar.** A two-level list of repositories and plans with pinning and hiding, and a **Needs you** queue for work waiting for a person across repositories. Waiting work also shows in the browser tab title, the favicon, and browser notifications.
- **Graph, Work, and Review views.** Review shows plan progress, money and quota, and lets you open a run or a task in detail. The task panel has overview, activity, changes, contract, your actions, and links; a right-click menu on a task offers follow-up and superseding tasks. The current place is kept in the URL, and heavy screens load on demand.
- **Plan drafts as durable jobs.** A draft keeps the worker's answer even when it does not match the draft format, and can be repaired, retried, recovered, or dropped (`crewboard plan draft …`).
- **The orchestrator's check.** Between a finished run and a person's decision, the plan's orchestrator can check the work: `crewboard verify <id>` takes it, `--done --note "…"` hands it to the person with the note above **Accept**, and `--return "findings"` sends it back to the worker in the same worktree. **Orchestrator checks finished work** is set per repository or plan and is on by default while the plan has a chat (`crewboard verify --setting`); `crewboard wait --for check` follows its steps. Acceptance stays human-only.
- **The orchestrator's own work and prepared decisions.** A `root` task is work the orchestrator does itself — integration on a stand, starting processes, the owner's database: `crewboard start <id>` shows it «in work by the orchestrator», `crewboard verify <id> --done --note "…" [--report <file>]` sends it to review with a report shown where a worker's is, and no worker is ever launched for it. A decision reaches **Needs you** only once its dependencies are accepted and the orchestrator prepared it with `verify --done` (while the orchestrator check is on); **Accept in batch** names decisions and root tasks the orchestrator has not checked. `crewboard task set <id> --kind` changes the kind of an open task.
- **Run ledger.** Paged, seekable steps of a run with links to individual steps.
- **Closing a task that is no longer needed.** `crewboard drop <id> --reason "…"` (human only, with a confirmation) and **Close as not needed…** in the task menu close a task for good: it becomes «dropped», keeps the reason in its history, never becomes ready again and leaves the critical path. A plan with a dropped task is refused by older builds instead of being misread.
- **Unfinished runs.** A run whose worker stopped with uncommitted work and no result line ends `incomplete` instead of going to review: **Needs you** says why, and **Continue** (or `crewboard continue <id>`) relaunches it in the same worktree with the direction to finish and report.
- **Accepted is not merged.** Accepting leaves the work on the task's branch; Crewboard detects when that work reaches the base branch — by a merge, a fast-forward or a squash, also one resolved by hand (see docs/en/review.md for the rule) — and records the task as merged, and never merges by itself. Until then the task is **Accepted, not merged** in **Needs you**, the Work board, Review, `crewboard status` and `crewboard attention`, and its panel (and `crewboard accept`) gives the exact commands. A dependency counts as done only once merged: a dependent task shows «waiting for X to be merged» and `crewboard run` refuses with the commands, unless a person passes `--allow-unmerged`. Files a worker left without a commit are named in the verdict and in the accept confirmation, since the branch does not contain them.
- **CLI version preflight.** Claude Code is checked against the minimum version of the model before a run; Opus 5.5 needs Claude Code 2.1.280 or newer.
- **Documentation** in English and Russian: getting started, plugin setup, CLI reference, workers, review, costs, and troubleshooting.

### Changed

- **Renamed to Crewboard.** Machine settings move to `~/.config/crewboard/`; an existing `~/.config/dsh-orchestra/` is copied there on first use and left unchanged. `CREWBOARD_*` environment variables replace `ORCH_*`, which are still read. The plugin's settings row is `crewboard`; a `repos` list under the old `dsh-orchestra` id is still read.
- **A task's own worker is honoured.** `crewboard run` without `-a` uses the task's worker and refuses the run, with the reason, when that worker is disabled or fails preflight, instead of falling back to another worker. A worker outside the plan's preset runs only when a person chooses it in a terminal or on the screen, and leaves a note in the task feed; an agent's choice outside the preset is refused.
- An idle plan graph no longer rewrites the page, and dictionaries load as separate assets.

### Fixed

- `crewboard worktree gc` without `--yes` removes nothing: it used to remove merged, clean accepted copies through its re-check without saying so. `--yes` lists what it removed, or `Nothing removed: N kept as …`.
- `crewboard cost` shows money charged (`cash $X`) and the API-rate estimate (`estimate ≈$Y`) separately instead of adding them into one figure; the JSON totals carry `cashUsd` and `apiEquivalentUsd` instead of `usd`, and a plan without runs says so.
- `crewboard wait --tasks` returns `0` at once when every listed task is already where the wait looks, instead of waiting for a transition that already happened; the default timeout is 30 minutes instead of none.
- The plugin's browser half is registered under the package name, and the bundle patch imports the plugin by that name.
- The bundled CLI ships its run supervisors next to its entry point.
- Orchestra tool output stays lossless JSON.
- An honest report is no longer disputed: the result line is read from the first lines of the answer or right under a report heading (`## Отчёт`, `## Report`), with list, quote, bold and code marks ignored, and Russian check outcomes («прошёл», «зелёный», «пройдены», «9 тестов», `ok`, `✓`) count as run.
- A result line with a free-text positive claim is accepted: «Result:»/«Результат:» followed by a plain sentence (in Russian, Ukrainian, English, German, French, Spanish, Portuguese, Italian or Polish) counts when its first sentence has a whole positive word and no negation, hedge or failure word; exact keys such as «получен»/`received` work as before.
- A decision has no verdict: its panel shows the checklist and **Where to look** without worker or task-class lines, and `crewboard accept` asks to close it instead of naming `claim_missing`. Verdict reasons in the CLI are words, not codes.
- Batch acceptance never takes risky work by default: **Accept in batch** is the one entry point (the review queue opens the same sheet), pre-selects only clean results, groups negative, disputed and unchecked work under **Open first** without ticks, and the confirmation counts «1 clean, 9 at risk». Review queue rows show their verdict.
- A Claude Code run no longer ends while the worker waits for its own background work: the session stays open until that work finishes and the worker's follow-up turn ends (bounded to an hour). Every worker is told to run long checks in the foreground.
- A Claude Code run that hit the usage limit or ended its last turn with `is_error: true` fails with Claude's message (and, for a limit, the reset time and "start again after the reset") instead of going to review as finished work.
- One worker per worktree even after a run's supervisor dies: the worker runs in its own process group recorded in the run's state, Crewboard stops an orphaned worker and refuses a new start while it lives, and the run ends failed with the reason "the run's supervisor exited; its worker was stopped".
- Activity of a finished run shows its steps instead of "this run has not done anything"; `crewboard events` shows the worker's warnings and `crewboard status` marks a task whose last run failed.
- A closed task starts no worker: `crewboard run`, `orchestra_run`, `steer --relaunch` and `continue` refuse a task that is accepted (also with a negative verdict) or superseded, with the reason in the CLI's language.
- Ctrl+D or Ctrl+C at a confirmation (`accept`, `reject`, `supersede`, `plan approve`, `worktree gc --force`, `verify`) means no: it prints the same «Cancelled.» line as answering `n` and exits 1, without an `AbortError` stack.
- CI and release workflows use `actions/checkout@v7`, `actions/setup-node@v7` and `pnpm/action-setup@v6`, which run on Node.js 24.

## Internal milestones before the public snapshot

### [0.2.0] - 2026-09-23 (internal)

#### Added

- **Screens:** a live plan graph, board, console, economics view, and timeline in dsh. The graph has search, a minimap, lenses, camera navigation, folded completed lanes, and task details with changes, runs, and reports. Repositories and plans remain navigable when another plan needs attention.
- **CLI:** commands to inspect events, traces, costs, attention, workers, and worktrees; wait for a human decision or a finished worker; manage multiple plans and plan chats; and configure routing and presets. Claude Code, Codex, Devin and dsh use direct backends.
- **Acceptance and verdict:** a review queue, in-app notifications, batch acceptance, and a verdict that relates the worker's result claim to known checks, changed files, and run outcome. Evidence stays with finished runs. Accept, return, and supersede remain human decisions, with native confirmation where the dsh host supports it.
- **Presets:** a configurable worker registry and named class-order presets, selectable per repository or per plan. The screen and CLI show the effective selection and refuse disabled workers; a worker named by hand outside the preset runs and leaves a note in the task feed.
- **Languages:** English and Russian interface dictionaries for the screen, host messages, and CLI. The screen follows dsh's active language without a reload.
- **Plan drafts:** a worker or the chat agent drafts a plan graph from a specification; the human reviews its findings and approves it into a new plan. A dependency cycle or a missing dependency blocks approval.
- **Worktree cleanup:** a preview and guarded cleanup in the CLI and screen, plus cleanup after acceptance. Automatic paths retain running, unaccepted, dirty, unmerged, and the three most recently accepted task worktrees; a retained worktree has a visible reason.

#### Changed

- Removed the vendored porch runtime. Devin runs directly over ACP, profiles and routes use the Orchestra profile store, and Codex quota comes from `codex app-server`. Older runs remain readable from their saved artifacts.
- The dsh host and browser client now resolve optional dsh services through scoped accessors, so unavailable services degrade their own integration instead of breaking the screen.
- Plans can be bound to dsh chats, split into new plans, and selected within a repository. Runs can be relaunched with context or from a trace step.

### [0.1.0] - 2026-09-22 (internal)

#### Added

- The first plan engine: validated plan files, dependency and ready-state derivation, revision-checked atomic writes, and quarantine of corrupt plans.
- The `orch` CLI for creating plans and tasks, launching and supervising workers, and reviewing results with human-only acceptance.
- Worker adapters for dsh ACP, isolated task worktrees, preflight checks, normalized event feeds, supervision signals, run trajectories, and usage accounting.
- The first dsh plugin host, live snapshot API and SSE feed, orchestration tools, sidebar entry, and plan screen foundation.
