# CLI reference

[Documentation](../README.md) · **English** | [Русский](../ru/cli.md)

`crewboard` and `orch` are the same program; installing the CLI gives you both names. The help and messages use whichever name you typed. This page was checked against `crewboard help all` and the command sources of version 0.4.0.

Run commands inside a Git repository; the plan is found from the repository root. Outside a repository they stop with "Not a git repository".

## Global options

| Option | Meaning |
| --- | --- |
| (no arguments), `--help`, `-h`, `help` | Print the short **start here** page: `init`, `task add --template`, `run`, `status`, `accept`/`merge` — the five commands a newcomer needs, plus `crewboard help all`. |
| `help all` | Print the full command reference (what earlier versions printed for `--help`). |
| `--version` | Print the installed version and exit. |
| `--lang en\|ru` | Interface language for this call. Without it, Russian is used when `LC_ALL` or `LANG` starts with `ru`, English otherwise. Some messages from the plan engine are still Russian only. |
| `--plan <id>` | Work on another plan than the current one. Accepted by `status`, `wait`, `task`, `accept`, `reject`, `supersede`, `drop`, `verify`, `start`, `decision`, `run`, `events`, `trace`, `steer`, `stop`, `attention`, `cost`, and `worktree`. When the current plan is archived, a command that changes a plan is refused without `--plan`. |

Exit codes: `0` success, `1` an error or a refused action, `2` a usage mistake. `wait` uses `2` for a timeout. An unknown command prints the nearest known one when it is a close match ("Unknown command: statuz — did you mean status?"), then the short page. Writing to a closed pipe (`crewboard status | head`) exits `0` quietly instead of printing a stack.

A command that only a person can run (`mark-merged`, `drop`, `plan restore`, `reject`, `supersede`, `verify --setting off`) refused for lack of a terminal says: "This command needs a person: if you are a person, run it in a terminal."

## Plans

| Command | What it does |
| --- | --- |
| `crewboard init [--goal "…"]` | Create the `main` plan in `.orchestration/plan.json`, add `.orchestration/` to `.git/info/exclude`, and add the repository root (or worktree root) to the [Crewboard repository list](#repositories-on-the-screen) so the screen shows the plan. Refuses if a plan exists. |
| `crewboard plan list` | List plans: `●` current, `○` active, `·` archived, with task counts. |
| `crewboard plan new <id> --goal "…"` | Create a plan and make it current. Adds the place to the Crewboard repository list, like `init`. |
| `crewboard plan use <id>` | Make a plan current. An archived plan can be made current to read it; changing it then needs `--plan <id>`. |
| `crewboard plan rename <id> --goal "…"` | Change a plan's goal. |
| `crewboard plan restore [--plan <id>]` | Human only, with a confirmation: bring back the version the plan had before its last save (`plan.json.prev`). See [troubleshooting](troubleshooting.md#when-something-went-wrong). |
| `crewboard plan archive <id>` / `unarchive <id>` | Hide a finished plan from the active list, or bring it back. |
| `crewboard plan split <id> --from <plan> --goal "…" --tasks a,b` | Move the listed tasks from `<plan>` into a new plan `<id>`. |
| `crewboard plan preset <id>` / `plan preset --clear` | Choose a worker preset for the current plan, or return it to the repository's choice. See [workers](workers.md). |
| `crewboard chat unbind <plan>` | Remove the link between a plan and a dsh chat. |
| `crewboard status [--all] [--json] [--plan id]` | Without `--all`: a one-line summary ("2 of 3 open · 1 accepted, not merged") and only the open tasks — closed, superseded and dropped ones stay out of the way, and an accepted task stays listed only until it is merged, with a hint to `--all` when any are hidden. `--all` prints every task, as earlier versions always did. Tasks with their state, what blocks them, tasks ready to start, the critical path, and the effective preset. An accepted task whose branch is not merged yet reads "accepted, not merged", a task waiting for it "waiting for X to be merged". `--json` always lists every task and adds `unmerged` (ids) and, per task, `unmerged` and `waitingMerge`. A task in review whose branch would conflict with its base or another task in review reads «⚠ conflicts with main in src/a.ts»; «Conflicts in review» lists them with a ready `reject … --reason`, and `--json` adds `conflicts` and `sendBack` ([Review](review.md#conflicts-before-acceptance)). `--json` gives each decided task `lastDecision`: `{by, at, verdict, reason}` — plus `answer` and `basis` on an answer recorded from chat ([Review](review.md#the-orchestrator-hears-your-decisions)). |

State icons in `status`: `·` backlog, `○` ready, `●` running, `◐` in review, `✓` accepted, `✗` closed, `⏸` blocked, `⊘` superseded or dropped.

### Plan drafts

A worker can draft a plan from a specification; you review it and approve it into a new plan.

The draft worker is picked the way a run's worker is: a worker named with `-a` must pass preflight and is refused otherwise; without `-a`, the `research` preset is walked in order and the first worker that passes preflight writes the draft. The CLI prints `The draft will be written by: <worker>` and, for every worker it passed over, the first failed check.

A draft worker reads the repository but cannot change it:

| Backend | How |
| --- | --- |
| Claude Code | Runs in the checkout with `--permission-mode plan`: file edits and commands are refused. |
| Codex | Runs in the checkout in the read-only sandbox (`-s read-only`). |
| dsh, Devin | Have no read-only mode: they run in a temporary detached git worktree of `HEAD` outside the checkout, removed when the attempt ends. Uncommitted changes are not in that copy (the spec itself is in the prompt). A folder that is not a git checkout cannot draft with these workers — pick Claude or Codex with `-a`. |

When an attempt fails, the job keeps the first line of the worker's error, and `job` prints it with a hint when the cause is recognisable (log in, enable the worker, update its CLI). A worker picked automatically is not kept: `retry` picks again, so a worker that stopped passing preflight is skipped; a worker named with `-a` stays with the job.

| Command | What it does |
| --- | --- |
| `crewboard plan draft --from <file> [-a <worker>] [--wait] [--skip-preflight]` | Start a draft job. Without `-a`, the first `research` worker that passes preflight is used. `--wait` follows it to the end. |
| `crewboard plan draft jobs` | List draft jobs and their state. |
| `crewboard plan draft job <job> [--wait]` | Show or follow one job. |
| `crewboard plan draft retry <job> [-a <worker>] [--wait]` | Try again: a worker fixes an answer that did not match the draft format, or reruns the request after a failure. `repair` is the older name of the same command. |
| `crewboard plan draft drop <job>` | Discard a job; its prompts and answers stay in `.orchestration/draft-runs/`. |
| `crewboard plan draft recover` | Pick up jobs whose process was interrupted. |
| `crewboard plan drafts` | List saved drafts. |
| `crewboard plan draft show <id> [--json]` | Print the draft's goal, its tasks (with their class and dependencies) and its open questions, then its findings. `--json` prints the raw draft object instead. |
| `crewboard plan approve <id>` | Human only: turn a draft into a plan; the new plan becomes current. A dependency cycle or a missing dependency blocks approval. |
| `crewboard plan discard <id>` | Delete a draft. |

## Tasks and decisions

```text
crewboard task add <id> --title "…" [--kind implement|review|research|decision|root] [--lane "…"]
                   [--deps a,b] [--worker <profile>] [--contract <file> | --template] [--class code|design|review|research] [--backlog]
crewboard task set <id> [--title "…"] [--lane "…"] [--deps a,b] [--worker <profile>] [--contract <file> | --template]
                   [--class …] [--status backlog|ready] [--kind implement|review|research|decision|root]
crewboard task show <id> [--plan id] [--json]
```

| Flag | Meaning |
| --- | --- |
| `--kind` | `implement` (default), `review`, `research`, `decision` or `root`. A `decision` task is closed only by a person and cannot be run. A `root` task is the orchestrator's own work — integration on a stand, starting processes, the owner's database: no worker is ever launched for it (see [below](#the-orchestrators-own-work)). `task set --kind` changes the kind of an open task; an accepted or superseded task keeps its kind. |
| `--class` | Which worker order applies: `code`, `design`, `review`, `research`. Without it, `review` and `research` kinds use their class, everything else `code`. |
| `--deps a,b` | Tasks that must be accepted first. `task set --deps ""` clears them. |
| `--worker` | The task's own worker. It is used instead of the class order; see [workers](workers.md#how-a-worker-is-chosen). |
| `--contract` | Path to the contract, relative to the repository root. Required before a run: a worker task added without one shows **needs contract** in `status` (`"needsContract": true` in `--json`) and on the screen, is not counted as ready to start, and `run` refuses it with the command to attach one. |
| `--template` | Write a contract skeleton from the one template to `.orchestration/contracts/<plan>/<id>.md` and attach it; fill in the result and the checks before the run. See [Write a contract](getting-started.md#2-write-a-contract). `task set --template` does the same for a task without a contract. Not for `decision` and `root` tasks, which take no contract. |
| `--lane` | A free-form group label shown on the screen. |
| `--backlog` / `--status` | Park a task in the backlog, or make it ready. `--status` accepts only `backlog` and `ready`. |

`crewboard task show <id>` prints everything about one task, so a review needs no `status`, `events`, `attention`, the contract file and git side by side. **Agents allowed**; it changes nothing but records finished runs and merges, as `status` does. Sections:

| Section | What it shows |
| --- | --- |
| Header | Title, kind, class, status, worker; dependencies, the tasks that need it, and what a blocked task waits for (work, or a merge). |
| Worktree | Path, branch and base; files changed against the base with `+`/`−` lines (the copy's committed and uncommitted edits; the branch when the copy is gone; the run's evidence when git cannot tell); files left without a commit. When the recorded base no longer matches the repository's [default base](#base-branch), a warning names both and the command to rebase or start over. |
| Merge | Merged into the base (when, which commit); accepted, not merged, with the exact commands, `crewboard merge <id>` and the paths a merge would conflict on; in review, its conflicts with the base and other tasks in review ([Review](review.md#conflicts-before-acceptance)). |
| Last run | Run, worker, outcome and when; why an unfinished run stopped or the last problem of a failed one. |
| Report | The first lines of the report and where the whole of it is: the run's `evidence.json`, the orchestrator's stored report, or `crewboard events <id>`. |
| Verdict | Result, negative or disputed, and why; how many contract checks the worker's report names as run; the checks Crewboard ran itself (passed of total, each failure with its output file and last lines) or the command that runs them; a mismatch. |
| Orchestrator check | Pending, being checked or checked, by whom and when, with the note. |
| Notes and decisions | The latest notes: people's comments, acceptance, send-backs, merges. |
| Contract | The contract path and its `<checks>` block. |

`--json` prints the whole structure: the task panel's detail on the screen (the same fields and values, events and contract text included) plus `planId`, `diffstat`, `mergeState` (`merged`, `unmerged` with `commands` and `conflicts`, `in_review` with `conflicts`, or `none`), `lastRun` with `reason`, `reportFile` and `checks`. The orchestrator's `orchestra_task` tool returns the same structure. A task that does not exist is refused with one sentence (exit `1`).

Judgment calls remain **human only**. Routine checked tasks support `accept --auto` and `merge --auto` without a terminal.

| Command | What it does |
| --- | --- |
| `crewboard accept <id> [--auto]` | Before the question: one line with the verdict, the orchestrator's check state and the merge state (conflict-free, or which paths would conflict), so you do not have to run `status` or `task show` first. Then the question, which names a negative or disputed verdict and files the copy holds without a commit (the branch does not contain them). Afterwards the worktree is removed if the cleanup policy says so. While the branch is not merged, it prints the exact commands to commit what is left and merge, and names `crewboard merge`; dependent tasks wait for the merge ([Review](review.md#after-acceptance-merge)). |
| `crewboard merge <id> [--squash\|--no-ff] [--yes] [--auto] [--into branch] [--json]` | Merge an accepted, not merged task into its base in the main repository. Checks first that the base branch is checked out and clean, the copy holds nothing uncommitted, and the merge would not conflict (`git merge-tree`, no files change); a conflict is refused with the paths. `--no-ff` (default) makes a merge commit naming the task branch, `--squash` one commit. Records the merge on the task and cleans up the copy like `worktree gc`. `--yes` skips the question; `--auto` allows a checked accepted task to merge without a terminal; `--into` names the checked-out plan branch if the recorded base is wrong; `--json` prints the result (`ok`, `into`, `strategy`, `commit`, `copy`) or the refusal (`error`, `message`, `paths`) ([Review](review.md#merge-from-crewboard)). |
| `crewboard mark-merged <id> --reason "…"` | Record an accepted, not merged task as merged when its work reached the base in a way Crewboard cannot see — carried into the main checkout by hand and edited again by later tasks, or merged in another clone. Human only, with a confirmation; refused without an interactive terminal. Git is not touched and a detached HEAD is fine. The reason stays in the task feed, the task leaves «Accepted, not merged» and its dependents may start. Work carried over byte for byte needs nothing: it counts as merged by content. On the screen: **Mark as merged…** in the task panel ([Review](review.md#work-landed-by-hand)). |
| `crewboard reject <id> --reason "…" [--rerun [-a <worker>] [--skip-preflight]]` | Send the task back with a reason; it can be run again, and the reason goes into the next run's prompt after the contract. `--rerun` starts that run at once in the same worktree — the previous run's worker, or the one `-a` names — with one confirmation for both; a decision, a root task or a task without a run is refused before anything is sent back ([Review](review.md#send-back-and-rerun)). |
| `crewboard supersede <id> --by <id>` | Close a task because another variant won. |
| `crewboard drop <id> --reason "…"` | Close a task that is no longer needed. Human only, with a confirmation, like `accept` and `reject`. The task becomes **dropped** («closed as not needed»): the reason stays in its history, and it never becomes ready again, leaves the critical path and is not launched. `task set --status` does not reopen it. A running task is refused: stop it first. An accepted, superseded or dropped one is refused too. On the screen: **Close as not needed…** in the task menu. |

The orchestrator's check — **agents allowed**. It sits between a finished run and your decision; see [the orchestrator's check](review.md#the-orchestrators-check).

| Command | What it does |
| --- | --- |
| `crewboard verify <id>` | Take a finished task for checking. On a task already checked it changes nothing and prints the note: the task stays with the person. |
| `crewboard verify <id> --reopen` | Take a checked task back from the person to check it again. |
| `crewboard verify <id> --done --note "…" [--confirm]` | Checked. The note is required. It first prints the verdict the person will see and the number of changed files; when the verdict is disputed or no file changed, it asks for confirmation — `y` in a terminal, `--confirm` otherwise. Routine checked work can then be auto-accepted and merged by the orchestrator; decisions, root tasks, disputed or negative results, conflicts and `<human_review>` still wait for a person, with the note above **Accept**. |
| `crewboard verify <id> --takeover --note "…"` | Take preserved uncommitted work from an incomplete run for the orchestrator's check, with no new run: the run stays `incomplete`, the task moves to **being checked**, and the orchestrator commits the copy and supplies a positive report with `--done --report`. Only an incomplete run with preserved changes (`left_uncommitted` or `no_claim`) qualifies; a run that ended without an answer is not taken over. |
| `crewboard verify <id> --attest --verdict result\|negative\|disputed --report <file> --note "…"` | Record a separate orchestrator judgement beside the worker's report. The proof file must carry a matching primary `Result:` claim: `Result: received` (or another positive value) for `result`, `Result: negative`/`Result: blocked` for `negative`. The `disputed` verdict has a report-parsing limitation — a bare `Result: disputed` is not recognized (see the [known limitations](../audits/2026-09-28/documentation.md#known-limitations)). A positive attestation also requires a clean committed copy and passing current receipts for every mandatory contract check at the current HEAD and contract revision; the record binds the run, proof hash, HEAD and contract revision. See [Independently attest a worker result](review.md#independently-attest-a-worker-result). |
| `crewboard verify <id> --return "findings" [--skip-preflight]` | Send the work back to its worker with the findings: a new run in the same worktree. |
| `crewboard verify <id> --run-checks` | Crewboard runs the contract's `<checks>` in the task's worktree itself — one command after another, with the recipe's environment and timeout per command — prints each outcome with its output file (and the last lines of a failure), and records the result next to the run's evidence, apart from the worker's claim. Prints a mismatch when the worker claims a result and a check failed. Exit `1` when a check failed. Nothing from the report is run; a contract without checks says so ([Review](review.md#checks-run-by-crewboard)). |
| `crewboard verify --setting on\|off\|default [--scope plan\|repo]` | Turn the check on or off for the plan (default scope) or the repository, or clear the stored value. The default is on while the plan has a chat. `off` asks a person to confirm. |

All `verify` forms accept `--plan <id>`. Ordinary `verify` and `--attest` act on a finished task in review; `--takeover` acts on a ready task whose incomplete run preserved uncommitted work, and `--done`/`--report` also finish root tasks and prepare decisions (see [the orchestrator's own work](#the-orchestrators-own-work)).

There is no batch accept in the CLI: `accept` takes one task, and its question names a task the orchestrator has not checked. Accepting several tasks at once is the screen's (**Accept in batch**), which pre-selects only clean work and names the root tasks without the orchestrator's check before it asks — decisions are never part of a batch: a decision is confirmed one by one, in the task panel or recorded from chat with `crewboard decision answer`. On a decision, `accept` asks you to close it: a decision has no verdict. A negative or disputed verdict is named in words, not as a code.

### The orchestrator's own work

A `root` task is work the orchestrator does itself and a person then accepts. `crewboard run` refuses it and names these commands — **agents allowed**:

| Command | What it does |
| --- | --- |
| `crewboard start <id>` | Take a ready root task in work: the screen shows it «in work by the orchestrator» on the graph, in **Work** and in the task panel. It never enters **Needs you** while in work. |
| `crewboard verify <id> --done --note "…" [--report <file>]` | Done: the task goes to review, marked «checked by the orchestrator». `--report` is a markdown file stored with the task and shown where a worker's report is: a first line `Result: received`, `negative` or `blocked`, then the checks you ran, evidence (commits, logs, commands) and how to reproduce. Without `--report`, the note is the report. |

Sent back, a root task returns to ready with the reason in its notes; start it again.

Decisions are prepared the same way: `crewboard verify <id> --done --note "…" [--report <file>]` on a decision records the options and the recommendation. With the orchestrator's check on (the default while the plan has a chat), a decision enters **Needs you** only when its dependencies are accepted **and** it is prepared; until then the screen says it is being prepared by the orchestrator. With the check off — a plan run by hand from the CLI, without a chat — a decision waits as soon as its dependencies are accepted, as before.

Two more commands on a decision are **agents allowed** — they record what the person already said, they do not ask them anything:

| Command | What it does |
| --- | --- |
| `crewboard decision answer <id> --answer "…" --basis "…"` | Record an answer the person already gave in chat: `answer` is what they answered, `basis` the message it rests on. The decision closes as accepted and dependents unblock — no second Accept in the panel. Both fields are required; the task must be a decision with no unfinished run. Repeating the recorded answer is a no-op; a different answer on a closed decision is refused — return it to preparation first. This is not `accept --auto` and no proof the message is genuine: the orchestrator is responsible for the basis being what the person actually wrote; it does not read other chats. |
| `crewboard decision prepare <id> --reason "…"` | Return an open decision to the orchestrator's preparation on the person's «study it and propose»: the check and the start mark clear, so it leaves the person's queue until `verify --done` prepares it again. The brief, the notes and the earlier report stay as history (its path rides on the record); dependents stay blocked; a closed decision is refused. |

## Runs

| Command | What it does |
| --- | --- |
| `crewboard run <id> [-a <profile>] [--scope s] [--contract f] [--base <branch>] [--skip-preflight]` | Start a worker in the task's worktree. `-a` picks a worker and becomes the task's worker. `--contract` overrides the task's contract for this run. `--scope` fills `{scope}` in the recipe's baseline command (see [worktree recipe](#worktree-recipe)). `--skip-preflight` skips the availability check. For dsh, use `-a dsh` or `-a dsh/<model>`, for example `dsh/deepseek-flash`. A task whose dependency is accepted but not merged is refused with the merge commands; `--allow-unmerged` starts it anyway — a person only, in an interactive terminal; the copy then lacks that work. When the previous run left uncommitted changes in the copy, a person is asked whether to continue with them or reset the copy; `--keep-changes` / `--reset-copy` answer in advance, and an agent is refused with both commands named. `--base` names the copy's base on purpose — a person only, in an interactive terminal; without it a new copy takes the repository's [default base](#base-branch), never whatever the main checkout happens to have checked out, and the launch says so once when the two differ. An agent's `--base` is refused. |
| `crewboard events <id>` | The event feed of the task's latest run, including your directions. |
| `crewboard trace <id> [--json]` | Turns, model time, tool calls, and directions of the latest run. |
| `crewboard steer <id> (--message "…" \| --file f) [--mode auto\|queue\|interrupt] [--relaunch] [--skip-preflight]` | Send a direction to a running worker. `queue` waits for the current turn to end and then becomes the next turn; `auto` and `interrupt` reach the worker during the turn (Claude Code takes them at its next step, Codex restarts the turn with them). Every direction ends acknowledged or not delivered with a reason. If the run has finished, `--relaunch` starts a new run with the direction. |
| `crewboard continue <id>` | Continue a run that ended unfinished — no report and uncommitted work (see [Unfinished runs](review.md#unfinished-runs)): a new run in the same worktree, told to finish the work, commit it and report. Refused when the last run did not end unfinished. |
| `crewboard stop <id>` | Stop the latest run. A Claude Code or Codex run whose last turn has already ended successfully (the worker gave its final report) finishes as completed and goes to review; a run stopped mid-turn is cancelled. |
| `crewboard attention [--all] [--json] [--alarms]` | What waits on a person — the same list as the screen's "Needs you": tasks waiting for review (and whether the orchestrator checked them), decisions, failed or stalled runs, and other plans that wait. Text starts with the one waiting number and its scope — «Waiting on you: in this plan 4 · in this repository 5 — 3 tasks wait for review · 1 decision» (`--all`: «all N») — the same count the screen shows ([Review](review.md#what-waits-on-you)), then groups the rows by kind; accepted work not merged yet (`unmerged`, with the merge command as `hint`); in `--json` every item has a `kind` (`review`, `decision`, `unmerged`, `attention`, `plan`) plus `root`, `planId`, `taskId` and, for alarms, `runId`; a task row has its `reason` (`review`, `checkOff`, `blocked`, `decision`, `failed`, `unmerged`) and `planTitle`, a background plan row its `reasons` with a count for each. Example-plan rows appear only when the example is the plan asked about (the repository's open plan, or `--plan` naming it); they come last, marked `example`, and are not counted. `--all` leaves them out. `--all` covers every repository the screen lists (it works from any folder). `--alarms` prints only the run alarms (failed, stalled, looping runs), as the command did before. Prints "All clear." only when nothing waits. |
| `crewboard cost [--json]` | Totals per worker: runs, minutes, money charged (`cash $X`) and the API-rate estimate (`estimate ≈$Y`) side by side, never added up, tokens, quota. A plan without runs prints `No runs in plan <id>.` See [costs](costs.md). |
| `crewboard wait [--for decision\|finished\|check\|any] [--tasks a,b] [--interval 15s] [--timeout 30m] [--json]` | Wait until a task is decided, a run finishes, or a step of the orchestrator's check happens (`check`). It waits for the next change; with `--tasks`, when every listed task is already there (its run finished, its check done, decided or closed), it exits `0` at once and prints those tasks marked `already` (`"already": true` in JSON). Exit `0` on an event, `2` on timeout (30 minutes unless `--timeout` says otherwise), `1` on error. Durations take `ms`, `s`, `m`, `h`; a bare number is seconds. Meant to run in the background of an orchestrating agent; it also syncs worker state when no dsh screen is open. |

A run is refused when the task is blocked, running, already accepted or superseded, is a decision or a root task, has no contract, or when no worker passes preflight. A contract without a `<checks>` block or without the result line does not stop the run: `run` prints a warning for each after the launch. The message says which, and a refusal that prints more than one line (a red baseline with the tail of its output, a preflight list) ends with `✗ <id> was not started: <reason>`, so the last line of the output is always the reason.

## Workers and presets

| Command | What it does |
| --- | --- |
| `crewboard workers [--all]` | One summary line per provider (models, how many are in presets) and the worker order for each class, with disabled workers and reasons; `--all` lists every model. |
| `crewboard workers add <id> --kind dsh\|claude\|codex\|devin --label "…" [--model m] [--transport t] [--effort e] [--billing API\|подписка\|промо]` | Register a worker or update one. `--billing` defaults to subscription for Claude and Codex, promotional for Devin, and API for dsh. The billing values are stored in Russian. |
| `crewboard workers rm <id>` | Remove a worker, its aliases, and its references in the class order. |
| `crewboard workers disable <id> [--reason "…"]` / `enable <id>` | Turn a worker off on this machine, or back on. A disabled worker is never launched. |
| `crewboard workers route <class> <id,id,…>` | Set the machine-wide order for one class. |
| `crewboard presets [list]` | The effective preset and its source, then saved presets. |
| `crewboard presets add\|set <id> --label "…" --code a,b --design a,b --review a,b --research a,b` | Save a named class order. All four class flags are required; an empty value leaves the class empty. |
| `crewboard presets rm <id>` | Delete a preset; repositories and plans that used it return to the default preset (**Default: workers that pass checks**). |
| `crewboard repo preset <id>` | Choose a preset for this repository. `all-workers` is the built-in one. |
| `crewboard plan preset <id\|--clear>` | Choose a preset for the current plan. |

## Base branch

A repository has a **default base**: its `origin/HEAD`, else `main` or `master` — never whatever branch a shared main checkout happens to have checked out. A launch takes it for every new copy and records it on the task; a reused copy keeps the base it already has. When the main checkout is on another branch at launch time, the launch still branches from the default base and says so in one line, so nobody mistakes the checked-out branch for where the work is headed. This is what merge, conflicts and «bring the branch up to date» all compare against.

| Command | What it does |
| --- | --- |
| `crewboard repo default-base [<branch>\|--clear]` | Without a value, shows the effective default base and its source. With a branch, overrides it for this repository. `--clear` returns to the repository's own default. |
| `crewboard plan default-base [<branch>\|--clear]` | The same, for the current plan only; it wins over the repository's setting. |
| `crewboard run <id> --base <branch>` | A person chooses a task's base on purpose, once, from an interactive terminal. An agent's `--base` is refused. |

A copy whose recorded base no longer matches the repository's current default — the person chose one on purpose, or the default moved on since — shows that once in the task panel and in `crewboard task show`, with the command to rebase onto the new default or to remove the copy and relaunch from it.

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
| `crewboard slot -- <command…>` | Wait for a free [check slot](#check-slots), then run `<command>` with its exit code and output unchanged. |
| `crewboard slot --set <n>` | Set the machine's check slot count. |
| `crewboard slot` | Show the machine's check slot count (configured, or the default). |

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

A failed step's output is not put into the message whole. Crewboard writes it to `.orchestration/output/<task>/<time>-<kind>.log` (`baseline`, `prepare` or `refresh` for a conflicting update of the copy) and the message names the file with its size and shows its last 20 lines. A task keeps its latest 10 such files; `worktree gc` removes them with the copy. `crewboard worktree list` and the task panel name the file of a red baseline, and the host's JSON refusal carries it as `output: { path, bytes, tail }`.

### Check slots

With several worktrees preparing at once, or several worker runs testing at once, their baselines, `verify --run-checks` and any of the workers' own test commands can drive a machine's load average through the roof and turn a short test into a flaky timeout. A check slot is a machine-wide limit on how many of these heavy commands run at once — shared by every worktree, plan and repository on the machine, not per repository.

The baseline (above) and `crewboard verify <id> --run-checks` already wait for a slot on their own; a worker is told (in its rules, alongside «run long checks in the foreground») to run its own long commands (tests, builds, stress runs) through `crewboard slot -- <command…>`, for example `crewboard slot -- pnpm test`. `slot` waits for a free slot, printing `waiting for a check slot (N ahead)` while it waits, then runs `<command>` with its exit code and output unchanged.

The slot count defaults to a quarter of the machine's cores, at least one; `crewboard slot --set <n>` changes it, and a bare `crewboard slot` shows the current count. `CREWBOARD_CHECK_SLOTS` overrides it for one call. The lock lives at `~/.config/crewboard/slots/`: each held slot is a file with the holding process's pid, host and time, the same idea as `plan.lock`; a holder whose process is gone is taken over at once, so a crashed check never wastes a slot.

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
| `~/.config/crewboard/slots/` | The [check slots](#check-slots) lock: one file per held slot. |
| `~/.config/crewboard/slots.json` | The configured check slot count (`crewboard slot --set`). |

`CREWBOARD_PROFILES_FILE`, `CREWBOARD_WORKERS_FILE`, `CREWBOARD_PRESETS_FILE`, `CREWBOARD_REPOS_FILE`, `CREWBOARD_SLOTS_DIR`, and `CREWBOARD_SLOTS_CONFIG` point these files elsewhere; the older `ORCH_*` names are still read. `CREWBOARD_CHECK_SLOTS` overrides the check slot count itself. On first use, an existing `~/.config/dsh-orchestra/` is copied to `~/.config/crewboard/`; the original is left unchanged.
