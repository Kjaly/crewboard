# Changelog

All notable changes to Crewboard are documented here. This changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The public history starts with 0.3.0, the first public snapshot of the repository. The 0.1.0 and 0.2.0 entries below describe internal milestones from before that snapshot, under the working name dsh-orchestra; they were never published and have no Git tags.

## [0.3.0] - Unreleased

First public release. Crewboard is published as two npm packages: [`crewboard`](https://www.npmjs.com/package/crewboard), the command-line interface, and [`dsh-crewboard`](https://www.npmjs.com/package/dsh-crewboard), the DeepSeek Harness plugin.

### Added

- **npm packages.** `npm install -g crewboard` installs the CLI as `crewboard` and `orch`; `dsh plugin --profile web add dsh-crewboard` adds the screen to dsh. The CLI bundles the plan engine and has no private runtime dependency. Releases are published from CI with npm trusted publishing.
- **Repository sidebar.** A two-level list of repositories and plans with pinning and hiding, and a **Needs you** queue for work waiting for a person across repositories. Waiting work also shows in the browser tab title, the favicon, and browser notifications.
- **Graph, Work, and Review views.** Review shows plan progress, money and quota, and lets you open a run or a task in detail. The task panel has overview, activity, changes, contract, your actions, and links; a right-click menu on a task offers follow-up and superseding tasks. The current place is kept in the URL, and heavy screens load on demand.
- **Plan drafts as durable jobs.** A draft keeps the worker's answer even when it does not match the draft format, and can be repaired, retried, recovered, or dropped (`crewboard plan draft …`).
- **The orchestrator's check.** Between a finished run and a person's decision, the plan's orchestrator can check the work: `crewboard verify <id>` takes it, `--done --note "…"` hands it to the person with the note above **Accept**, and `--return "findings"` sends it back to the worker in the same worktree. **Orchestrator checks finished work** is set per repository or plan and is on by default while the plan has a chat (`crewboard verify --setting`); `crewboard wait --for check` follows its steps. Acceptance stays human-only.
- **Run ledger.** Paged, seekable steps of a run with links to individual steps.
- **CLI version preflight.** Claude Code is checked against the minimum version of the model before a run; Opus 5.5 needs Claude Code 2.1.280 or newer.
- **Documentation** in English and Russian: getting started, plugin setup, CLI reference, workers, review, costs, and troubleshooting.

### Changed

- **Renamed to Crewboard.** Machine settings move to `~/.config/crewboard/`; an existing `~/.config/dsh-orchestra/` is copied there on first use and left unchanged. `CREWBOARD_*` environment variables replace `ORCH_*`, which are still read. The plugin's settings row is `crewboard`; a `repos` list under the old `dsh-orchestra` id is still read.
- **A task's own worker is honoured.** `crewboard run` without `-a` uses the task's worker and refuses the run, with the reason, when that worker is disabled or fails preflight, instead of falling back to another worker. A worker outside the plan's preset runs only when a person chooses it in a terminal or on the screen, and leaves a note in the task feed; an agent's choice outside the preset is refused.
- An idle plan graph no longer rewrites the page, and dictionaries load as separate assets.

### Fixed

- The plugin's browser half is registered under the package name, and the bundle patch imports the plugin by that name.
- The bundled CLI ships its run supervisors next to its entry point.
- Orchestra tool output stays lossless JSON.

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
