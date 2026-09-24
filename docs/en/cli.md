# CLI reference

[Documentation](../README.md) · **English** | [Русский](../ru/cli.md)

`crewboard` and `orch` are the same program; installing the CLI gives you both names. The help and messages use whichever name you typed. This page was checked against `crewboard --help` and the command sources of version 0.4.0.

Run commands inside a Git repository; the plan is found from the repository root. Outside a repository they stop with "Not a git repository".

## Global options

| Option | Meaning |
| --- | --- |
| `--help`, `-h`, `help` | Print the command summary. Also printed after an unknown command. |
| `--lang en\|ru` | Interface language for this call. Without it, Russian is used when `LC_ALL` or `LANG` starts with `ru`, English otherwise. Some messages from the plan engine are still Russian only. |
| `--plan <id>` | Work on another plan than the current one. Accepted by `status`, `wait`, `task`, `accept`, `reject`, `supersede`, `drop`, `verify`, `start`, `run`, `events`, `trace`, `steer`, `stop`, `attention`, `cost`, and `worktree`. When the current plan is archived, a command that changes a plan is refused without `--plan`. |

Exit codes: `0` success, `1` an error or a refused action, `2` a usage mistake. `wait` uses `2` for a timeout.

There is no `--version` flag; use `npm ls -g crewboard`.

## Plans

| Command | What it does |
| --- | --- |
| `crewboard init [--goal "…"]` | Create the `main` plan in `.orchestration/plan.json`, add `.orchestration/` to `.git/info/exclude`, and add the repository root (or worktree root) to the [Crewboard repository list](#repositories-on-the-screen) so the screen shows the plan. Refuses if a plan exists. |
| `crewboard plan list` | List plans: `●` current, `○` active, `·` archived, with task counts. |
| `crewboard plan new <id> --goal "…"` | Create a plan and make it current. Adds the place to the Crewboard repository list, like `init`. |
| `crewboard plan use <id>` | Make a plan current. An archived plan can be made current to read it; changing it then needs `--plan <id>`. |
| `crewboard plan rename <id> --goal "…"` | Change a plan's goal. |
| `crewboard plan archive <id>` / `unarchive <id>` | Hide a finished plan from the active list, or bring it back. |
| `crewboard plan split <id> --from <plan> --goal "…" --tasks a,b` | Move the listed tasks from `<plan>` into a new plan `<id>`. |
| `crewboard plan preset <id>` / `plan preset --clear` | Choose a worker preset for the current plan, or return it to the repository's choice. See [workers](workers.md). |
| `crewboard chat unbind <plan>` | Remove the link between a plan and a dsh chat. |
| `crewboard status [--json] [--plan id]` | Tasks with their state, what blocks them, tasks ready to start, the critical path, and the effective preset. An accepted task whose branch is not merged yet reads "accepted, not merged", a task waiting for it "waiting for X to be merged"; a line lists every accepted-unmerged task. `--json` adds `unmerged` (ids) and, per task, `unmerged` and `waitingMerge`. |

State icons in `status`: `·` backlog, `○` ready, `●` running, `◐` in review, `✓` accepted, `✗` closed, `⏸` blocked, `⊘` superseded or dropped.

### Plan drafts

A worker can draft a plan from a specification; you review it and approve it into a new plan.

| Command | What it does |
| --- | --- |
| `crewboard plan draft --from <file> [-a <worker>] [--wait]` | Start a draft job. Without `-a`, the first worker of the `research` class is used. `--wait` follows it to the end. |
| `crewboard plan draft jobs` | List draft jobs and their state. |
| `crewboard plan draft job <job> [--wait]` | Show or follow one job. |
| `crewboard plan draft repair <job> [-a <worker>] [--wait]` | Ask a worker to fix an answer that did not match the draft format. |
| `crewboard plan draft drop <job>` | Discard a job; its prompts and answers stay in `.orchestration/draft-runs/`. |
| `crewboard plan draft recover` | Pick up jobs whose process was interrupted. |
| `crewboard plan drafts` | List saved drafts. |
| `crewboard plan draft show <id>` | Print a draft and its findings. |
| `crewboard plan approve <id>` | Human only: turn a draft into a plan; the new plan becomes current. A dependency cycle or a missing dependency blocks approval. |
| `crewboard plan discard <id>` | Delete a draft. |

## Tasks and decisions

```text
crewboard task add <id> --title "…" [--kind implement|review|research|decision|root] [--lane "…"]
                   [--deps a,b] [--worker <profile>] [--contract <file>] [--class code|design|review|research] [--backlog]
crewboard task set <id> [--title "…"] [--lane "…"] [--deps a,b] [--worker <profile>] [--contract <file>]
                   [--class …] [--status backlog|ready] [--kind implement|review|research|decision|root]
```

| Flag | Meaning |
| --- | --- |
| `--kind` | `implement` (default), `review`, `research`, `decision` or `root`. A `decision` task is closed only by a person and cannot be run. A `root` task is the orchestrator's own work — integration on a stand, starting processes, the owner's database: no worker is ever launched for it (see [below](#the-orchestrators-own-work)). `task set --kind` changes the kind of an open task; an accepted or superseded task keeps its kind. |
| `--class` | Which worker order applies: `code`, `design`, `review`, `research`. Without it, `review` and `research` kinds use their class, everything else `code`. |
| `--deps a,b` | Tasks that must be accepted first. `task set --deps ""` clears them. |
| `--worker` | The task's own worker. It is used instead of the class order; see [workers](workers.md#how-a-worker-is-chosen). |
| `--contract` | Path to the contract, relative to the repository root. Required before a run. |
| `--lane` | A free-form group label shown on the screen. |
| `--backlog` / `--status` | Park a task in the backlog, or make it ready. `--status` accepts only `backlog` and `ready`. |

Decisions — **human only**: they ask `[y/N]` in an interactive terminal and refuse without one.

| Command | What it does |
| --- | --- |
| `crewboard accept <id>` | Accept the result. The question names a negative or disputed verdict and files the copy holds without a commit (the branch does not contain them). Afterwards the worktree is removed if the cleanup policy says so. While the branch is not merged, it prints the exact commands to commit what is left and merge; dependent tasks wait for the merge ([Review](review.md#after-acceptance-merge)). |
| `crewboard reject <id> --reason "…"` | Send the task back with a reason; it can be run again. |
| `crewboard supersede <id> --by <id>` | Close a task because another variant won. |
| `crewboard drop <id> --reason "…"` | Close a task that is no longer needed. Human only, with a confirmation, like `accept` and `reject`. The task becomes **dropped** («closed as not needed»): the reason stays in its history, and it never becomes ready again, leaves the critical path and is not launched. `task set --status` does not reopen it. A running task is refused: stop it first. An accepted, superseded or dropped one is refused too. On the screen: **Close as not needed…** in the task menu. |

The orchestrator's check — **agents allowed**. It sits between a finished run and your decision; see [the orchestrator's check](review.md#the-orchestrators-check).

| Command | What it does |
| --- | --- |
| `crewboard verify <id>` | Take a finished task for checking. On a task already checked it changes nothing and prints the note: the task stays with the person. |
| `crewboard verify <id> --reopen` | Take a checked task back from the person to check it again. |
| `crewboard verify <id> --done --note "…" [--confirm]` | Checked: the task now waits for a person, with the note above **Accept**. The note is required. It first prints the verdict the person will see and the number of changed files; when the verdict is disputed or no file changed, it asks for confirmation — `y` in a terminal, `--confirm` otherwise. |
| `crewboard verify <id> --return "findings" [--skip-preflight]` | Send the work back to its worker with the findings: a new run in the same worktree. |
| `crewboard verify --setting on\|off\|default [--scope plan\|repo]` | Turn the check on or off for the plan (default scope) or the repository, or clear the stored value. The default is on while the plan has a chat. `off` asks a person to confirm. |

All `verify` forms accept `--plan <id>`. Only finished work waiting for review can be checked.

There is no batch accept in the CLI: `accept` takes one task, and its question names a task the orchestrator has not checked. Accepting several tasks at once is the screen's (**Accept in batch**), which pre-selects only clean work and lists the decisions and root tasks without the orchestrator's check before it asks. On a decision, `accept` asks you to close it: a decision has no verdict. A negative or disputed verdict is named in words, not as a code.

### The orchestrator's own work

A `root` task is work the orchestrator does itself and a person then accepts. `crewboard run` refuses it and names these commands — **agents allowed**:

| Command | What it does |
| --- | --- |
| `crewboard start <id>` | Take a ready root task in work: the screen shows it «in work by the orchestrator» on the graph, in **Work** and in the task panel. It never enters **Needs you** while in work. |
| `crewboard verify <id> --done --note "…" [--report <file>]` | Done: the task goes to review, marked «checked by the orchestrator». `--report` is a markdown file stored with the task and shown where a worker's report is: a first line `Result: received`, `negative` or `blocked`, then the checks you ran, evidence (commits, logs, commands) and how to reproduce. Without `--report`, the note is the report. |

Sent back, a root task returns to ready with the reason in its notes; start it again.

Decisions are prepared the same way: `crewboard verify <id> --done --note "…" [--report <file>]` on a decision records the options and the recommendation. With the orchestrator's check on (the default while the plan has a chat), a decision enters **Needs you** only when its dependencies are accepted **and** it is prepared; until then the screen says it is being prepared by the orchestrator. With the check off — a plan run by hand from the CLI, without a chat — a decision waits as soon as its dependencies are accepted, as before.

## Runs

| Command | What it does |
| --- | --- |
| `crewboard run <id> [-a <profile>] [--scope s] [--contract f] [--skip-preflight]` | Start a worker in the task's worktree. `-a` picks a worker and becomes the task's worker. `--contract` overrides the task's contract for this run. `--scope` fills `{scope}` in the recipe's baseline command (see [worktree recipe](#worktree-recipe)). `--skip-preflight` skips the availability check. For dsh, use `-a dsh` or `-a dsh/<model>`, for example `dsh/deepseek-flash`. A task whose dependency is accepted but not merged is refused with the merge commands; `--allow-unmerged` starts it anyway — a person only, in an interactive terminal; the copy then lacks that work. |
| `crewboard events <id>` | The event feed of the task's latest run, including your directions. |
| `crewboard trace <id> [--json]` | Turns, model time, tool calls, and directions of the latest run. |
| `crewboard steer <id> (--message "…" \| --file f) [--mode auto\|queue\|interrupt] [--relaunch] [--skip-preflight]` | Send a direction to a running worker. `queue` waits for the current turn to end and then becomes the next turn; `auto` and `interrupt` reach the worker during the turn (Claude Code takes them at its next step, Codex restarts the turn with them). Every direction ends acknowledged or not delivered with a reason. If the run has finished, `--relaunch` starts a new run with the direction. |
| `crewboard continue <id>` | Continue a run that ended unfinished — no report and uncommitted work (see [Unfinished runs](review.md#unfinished-runs)): a new run in the same worktree, told to finish the work, commit it and report. Refused when the last run did not end unfinished. |
| `crewboard stop <id>` | Stop the latest run. A Claude Code or Codex run whose last turn has already ended successfully (the worker gave its final report) finishes as completed and goes to review; a run stopped mid-turn is cancelled. |
| `crewboard attention [--all] [--json] [--alarms]` | What waits on a person — the same list as the screen's "Needs you": tasks waiting for review (and whether the orchestrator checked them), decisions, failed or stalled runs, and other plans that wait. Text is grouped by kind; accepted work not merged yet (`unmerged`, with the merge command as `hint`); in `--json` every item has a `kind` (`review`, `decision`, `unmerged`, `attention`, `plan`) plus `root`, `planId`, `taskId` and, for alarms, `runId`. Example-plan rows appear only when the example is the plan asked about (the repository's open plan, or `--plan` naming it); they come last, marked `example`, and are not counted. `--all` leaves them out. `--all` covers every repository the screen lists (it works from any folder). `--alarms` prints only the run alarms (failed, stalled, looping runs), as the command did before. Prints "All clear." only when nothing waits. |
| `crewboard cost [--json]` | Totals per worker: runs, minutes, money charged (`cash $X`) and the API-rate estimate (`estimate ≈$Y`) side by side, never added up, tokens, quota. A plan without runs prints `No runs in plan <id>.` See [costs](costs.md). |
| `crewboard wait [--for decision\|finished\|check\|any] [--tasks a,b] [--interval 15s] [--timeout 30m] [--json]` | Wait until a task is decided, a run finishes, or a step of the orchestrator's check happens (`check`). It waits for the next change; with `--tasks`, when every listed task is already there (its run finished, its check done, decided or closed), it exits `0` at once and prints those tasks marked `already` (`"already": true` in JSON). Exit `0` on an event, `2` on timeout (30 minutes unless `--timeout` says otherwise), `1` on error. Durations take `ms`, `s`, `m`, `h`; a bare number is seconds. Meant to run in the background of an orchestrating agent; it also syncs worker state when no dsh screen is open. |

A run is refused when the task is blocked, running, already accepted or superseded, is a decision or a root task, has no contract, or when no worker passes preflight. The message says which, and a refusal that prints more than one line (a red baseline with its test output, a preflight list) ends with `✗ <id> was not started: <reason>`, so the last line of the output is always the reason.

## Workers and presets

| Command | What it does |
| --- | --- |
| `crewboard workers` | The registry and the worker order for each class, with disabled workers and reasons. |
| `crewboard workers add <id> --kind dsh\|claude\|codex\|devin --label "…" [--model m] [--transport t] [--effort e] [--billing API\|подписка\|промо]` | Register a worker or update one. `--billing` defaults to subscription for Claude and Codex, promotional for Devin, and API for dsh. The billing values are stored in Russian. |
| `crewboard workers rm <id>` | Remove a worker, its aliases, and its references in the class order. |
| `crewboard workers disable <id> [--reason "…"]` / `enable <id>` | Turn a worker off on this machine, or back on. A disabled worker is never launched. |
| `crewboard workers route <class> <id,id,…>` | Set the machine-wide order for one class. |
| `crewboard presets [list]` | The effective preset and its source, then saved presets. |
| `crewboard presets add\|set <id> --label "…" --code a,b --design a,b --review a,b --research a,b` | Save a named class order. All four class flags are required; an empty value leaves the class empty. |
| `crewboard presets rm <id>` | Delete a preset; repositories and plans that used it return to **All workers**. |
| `crewboard repo preset <id>` | Choose a preset for this repository. `all-workers` is the built-in one. |
| `crewboard plan preset <id\|--clear>` | Choose a preset for the current plan. |

## Repositories on the screen

The screen shows repositories from three lists, merged without repeats: dsh workspaces, the plugin's `repos` setting (with `CREWBOARD_REPOS`), and Crewboard's own list in `~/.config/crewboard/repos.json`. The CLI writes only the last one. `crewboard init` and `crewboard plan new` add the place they work in; these commands manage it by hand:

| Command | What it does |
| --- | --- |
| `crewboard repo add [path]` | Add this repository, or the one at `path`, to the Crewboard list. `~` is expanded; a subfolder is listed as its repository root, a worktree as its own root. Refuses a folder that is not a Git repository or worktree. |
| `crewboard repo list` | Every place the screen shows, with where it comes from: `dsh workspace`, `plugin repos setting`, `Crewboard list`, or `worktree of <repo>`. A folder that no longer exists is marked `missing`. |
| `crewboard repo rm <path>` | Remove a path from the Crewboard list. Files, plans, and worktrees stay on disk. A path that no longer exists is removed the same way. A dsh workspace or a `repos` path cannot be removed here; the message says where to remove it. |

Worktrees are found on their own: for every listed repository the screen runs `git worktree list` and shows each checkout that holds a plan (`.orchestration/`), grouped under the repository and marked **worktree**. Crewboard's own task copies (`<repo>-orch-<task>`, next to the repository) are never shown as plans of their own, even if a plan file appears in one: they hold a worker's checkout of a task, not a place.

When a plan command works on a plan the screen does not show, it prints one warning after its output, with the command that fixes it (`crewboard repo add`). The warning appears only when dsh is installed (`~/.dsh` exists) and never in a task copy.

## Environment

| Command | What it does |
| --- | --- |
| `crewboard preflight [-a <profile>] [--probe] [--json]` | Check that worker CLIs are installed and signed in. Without `-a`, every enabled profile is checked. With `-a`, the Claude Code version floor for the model is checked too. `--probe` sends a test prompt where supported. Exit `1` if a check fails. |
| `crewboard worktree prepare <id> [--scope s]` | Create or reuse the task's worktree and run the recipe, without starting a worker. |
| `crewboard worktree list` | Task worktrees with clean/dirty and accepted state, and the last baseline. |
| `crewboard worktree gc` | Preview: which worktrees could be removed, which are kept and why, with sizes. Removes nothing. |
| `crewboard worktree gc --yes` | Remove the eligible worktrees. Unaccepted, running, dirty, unmerged, and the three most recently accepted copies are kept. Removal uses `git worktree remove` without force. Prints each removed copy, or `Nothing removed: N kept as …` with the reasons. |
| `crewboard worktree gc --force <id>` | Human only: remove one worktree even with changes in it. |

### Worktree recipe

A new worktree starts as a clean checkout of `HEAD`. An optional `.orchestration/recipes.json` prepares it before the worker starts:

```json
{
  "setup": ["pnpm install --frozen-lockfile", { "copy": ".env.local" }],
  "env": { "unset": ["NODE_OPTIONS"] },
  "baseline": "pnpm test {scope}",
  "timeoutSec": 300
}
```

`setup` steps are shell commands, or `{ "copy": "<path>" }` to copy a file or folder from the main checkout, such as an untracked `.env.local`. `env.unset` removes variables from the steps' environment. `baseline` is a check that must pass before the task goes to a worker: a red baseline refuses the run. Each step has `timeoutSec` (default 300). A reused worktree is fast-forwarded to the repository's `HEAD` when it has no uncommitted changes. Its `setup` runs again only if it never finished. Its `baseline` runs again unless the last one was green, used the same command and ran on a copy that already had the current repository `HEAD`. The worker's own commits do not count as a change. So a red or unknown baseline, for example on a copy made by an older version, is always run again before a worker starts. The last result (commit, command, green or red, time) is shown by `crewboard worktree list` and in the task panel.

## Files and environment variables

| Path | Contents |
| --- | --- |
| `.orchestration/plan.json`, `.orchestration/plans/*.json` | Plans; `.orchestration/current` names the current one. |
| `.orchestration/runs/<run>/evidence.json` | Evidence captured when a run finished. |
| `.orchestration/preset.json` | The repository's preset choice. |
| `.orchestration/recipes.json` | The optional [worktree recipe](#worktree-recipe). |
| `~/.config/crewboard/profiles.json` | Worker profiles, aliases, machine-wide class order, disabled workers. |
| `~/.config/crewboard/workers.json` | The worker registry. |
| `~/.config/crewboard/presets.json` | Saved presets. |
| `~/.config/crewboard/repos.json` | The Crewboard repository list: the places the screen shows besides dsh workspaces and the plugin's `repos`. |

`CREWBOARD_PROFILES_FILE`, `CREWBOARD_WORKERS_FILE`, `CREWBOARD_PRESETS_FILE`, and `CREWBOARD_REPOS_FILE` point these files elsewhere; the older `ORCH_*` names are still read. On first use, an existing `~/.config/dsh-orchestra/` is copied to `~/.config/crewboard/`; the original is left unchanged.
