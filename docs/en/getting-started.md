# Getting started

[Documentation](../README.md) · **English** | [Русский](../ru/getting-started.md)

This guide takes one repository from an empty plan to a decision on the first result. It uses the CLI; the same plan appears on the dsh screen once the [plugin is set up](plugin-setup.md).

## Before you start

- Node.js 24 or newer, pnpm 11.5.2, and Git, with the CLI built from a source checkout (the npm release is not published yet): `pnpm install --frozen-lockfile && pnpm build`. See [README: install](../../README.md#install).
- At least one worker CLI, installed and ready: Codex (`codex`), Devin (`devin`), or dsh (`dsh`); for automated Claude Code (`claude`) add an explicit `ANTHROPIC_API_KEY` — its subscription sign-in is not used. See [workers](workers.md).
- A Git repository with at least one commit. Crewboard creates task worktrees from it.

`crewboard` and `orch` are the same program; the help and messages use whichever name you typed. The commands below write `crewboard`; from a source checkout, run them as `node packages/cli/dist/main.js …` or define the alias shown in the [install steps](../../README.md#install).

## 1. Create a plan

Run commands from inside the repository:

```sh
crewboard init --goal "Split the API into modules"
```

This creates `.orchestration/plan.json` (the `main` plan) and adds `.orchestration/` to `.git/info/exclude`, so plan data is not committed by accident. A repository can hold several plans; see `crewboard plan` in the [CLI reference](cli.md#plans).

## 2. Write a contract

A task can run only with a contract: a file in the repository that states the result you want and how to check it. Keep it short and concrete.

Every contract Crewboard writes has the same sections, in this order: the title, **Context**, **Result**, **Checks**, **Not in scope**, **Sources**, and **Report**. The same template is used when you approve a plan draft, create a follow-up or a superseding task, run `crewboard task add --template`, or when the orchestrator creates a task. Context, Not in scope and Sources appear only when they have content; Checks and Report are always there:

- **Checks** holds a `<checks>` block with one command per line. The review screen uses it to tell which checks the worker reported running. The block opens at a line that is exactly `<checks>` and closes at a line that is exactly `</checks>`; a tag mentioned inside a sentence, a code span or fenced code is text, not a block. If a contract has several blocks, the last one counts. The same rule applies to `<paths>`.
- **Report** asks the worker to start its final answer with the line `Result: received`, `Result: negative`, or `Result: blocked` (in Russian, `Результат: получен | отрицательный | заблокирован`). The verdict reads that line; see [review](review.md).

To start from the template, let Crewboard write a skeleton and fill it in:

```sh
crewboard task add api --title "Extract the API module" --class code --template
#   contract: .orchestration/contracts/main/api.md — fill in the result and the checks, then crewboard run api
```

A filled contract looks like this:

```markdown
# Extract the API module

## Result

Move the HTTP handlers from src/server.ts into src/api/ without changing behaviour.

## Checks

One command per line between the tags. Run each before you report and name every one in the report with its outcome.

<checks>
- pnpm test
- pnpm typecheck
</checks>

## Not in scope

- Renaming routes

## Report

Start your final answer with one line: `Result: received`, `Result: negative` or `Result: blocked` — pick one by the facts. …
```

You can also write a contract by hand and attach it with `--contract <file>`. `crewboard run` warns, without refusing, when a contract has no checks or does not ask for the result line.

## 3. Add tasks

```sh
crewboard task add api --title "Extract the API" --class code --contract docs/tasks/api.md
crewboard task add docs --title "Document the API" --deps api --class research --contract docs/tasks/docs.md
crewboard status
```

`status` shows each task, what it waits for, the tasks ready to start, and the critical path:

```text
Split the API into modules · rev 3

Preset: Default: workers that pass checks (source: builtin)
○ api   Extract the API
⏸ docs  Document the API · waiting for api

Ready to start: api
Critical path: api → docs
```

The class (`code`, `design`, `review`, `research`) decides which workers are tried automatically. `--kind decision` creates a task that only a person closes.

## 4. Run a worker

```sh
crewboard workers        # the registry and the order per class
crewboard preflight -a codex
crewboard run api        # or: crewboard run api -a claude/opus
```

Without `-a`, Crewboard uses the task's own worker, or the first worker of the task's class that is enabled and passes its preflight check; with the built-in preset it then goes on to any other installed worker that passes. A worker it passed over is named, for example `claude/opus skipped: not logged in → codex/gpt-6-luna`, in the output and in the task's feed. When no worker can run the task, the refusal lists the installed workers that could and the command that routes the class to one, such as `crewboard workers route code codex/gpt-6-luna`. The run gets its own worktree next to the repository, on an `orch/api-…` branch. [Workers](workers.md) explains the order in detail.

## 5. Watch

```sh
crewboard events api       # the task's event feed
crewboard trace api        # turns, model time, tool calls
crewboard attention        # what waits on you: reviews, decisions, unmerged work, failed runs
crewboard steer api --message "Keep the old route names"
```

An orchestrating agent can wait in the background and wake up when something changes:

```sh
crewboard wait --for any --timeout 30m
```

It exits with `0` when a task was decided or a run finished, `2` on timeout, and `1` on error.

## 6. Decide

When the run finishes, the task is waiting for review. Read the report, the evidence, and the changes — on the screen, or with `crewboard events api` and in the worktree. Then, in an interactive terminal:

```sh
crewboard accept api
crewboard reject api --reason "Route compatibility is not verified"
crewboard supersede api --by api-v2
```

`accept`, `reject` and `supersede` ask for confirmation and need an interactive terminal, so an agent cannot make those judgment calls. Routine checked work is different: the orchestrator can auto-accept and auto-merge it with `crewboard accept <id> --auto` then `crewboard merge <id> --auto` (or `orchestra_close`) while the core gates hold. [Review](review.md) describes the verdict, the gates, and evidence.

Accepting does not change your base branch: the work is on the task's branch until you merge it, and tasks that depend on `api` wait for that. `crewboard accept` prints the commands; for example:

```sh
git merge --no-ff orch/api-extract-the-api   # in the main checkout, on the base branch
```

After the merge, the worktree is removed if your cleanup policy says so. [After acceptance: merge](review.md#after-acceptance-merge) covers uncommitted work and starting a dependent early.

## The screen

With the [plugin](plugin-setup.md) installed, open **Orchestration** (the graph icon in dsh's left column); the entry also shows how many items wait for you. The screen shows the same plans as the CLI. Its settings are under **Crewboard** in dsh settings.

On the first visit:

- With no repository listed, the screen asks for a folder path: type it and press **Add**. The **+** next to **Repositories** in the sidebar does the same later.
- A repository without a plan opens on the welcome screen, both right after you add it and when you click it in the sidebar. **Quiet** only collects repositories that had work before and none for a week.
- On the welcome screen, **From a spec** drafts a plan from a document, **From chat** asks for the plan's goal and then opens a chat with the orchestrator, and **See an example** opens a sample plan with a short tour; its **Done** brings you back to the welcome screen.
- An empty plan asks for its first task: **Add task** takes a title and, optionally, what is true when it is done, and writes the contract from the template; **Draft from spec** drafts the tasks from a document.
- The task panel says who will run a task that nobody assigned: «Will run: Codex GPT-6 Luna (by the preset)». A worker you pick yourself outside the preset is marked **hand-picked**, a note rather than a warning.

![Sidebar with two repositories; one shows a Needs you badge](../assets/sidebar-needs-you.png)

*The sidebar lists repositories and plans. **Needs you** collects work waiting for a person across all of them.*

![Graph view: tasks, dependencies, and the critical path of one plan](../assets/hero-graph.png)

*The **Graph** view (key `1`) shows dependencies and the critical path. Focus lenses highlight tasks that need attention, are running, are ready, or are in review, without hiding the rest.*

![Work view: tasks grouped by state, each with its worker](../assets/work.png)

*The **Work** view (key `2`) groups tasks by state and shows who works on them and what waits for you.*

![Review view: a finished run with its verdict and decision buttons](../assets/review.png)

*The **Review** view (key `3`) collects finished work, verdicts, and plan-level totals.*

![Task panel: contract, run, report, changed files, checks, and decision actions](../assets/task-panel.png)

*The task panel has the overview, activity, changes, contract, your actions, and links, with **Accept** and **Send back** for a task in review.*

*A running task opens on **Activity**: the worker's public messages, commands and changed files, the current reported step, and a control to catch up on new lines. It keeps that tab when the run finishes and shows the true outcome with a link to the report. Opening a finished task starts on **Overview**, and any tab you pick wins over the default.*

![Run ledger: steps of one run with model, tools, and cost](../assets/run-ledger.png)

*The run ledger shows the steps of a run, its model and tools, and what is known about its cost.*

![Settings: workers, their availability, and the order per task class](../assets/settings.png)

*Settings: workers, availability checks, the order per task class, presets, and worktree cleanup.*

## Next

- [CLI reference](cli.md) — every command and flag.
- [Workers](workers.md) — registry, presets, and how a worker is chosen.
- [Troubleshooting](troubleshooting.md) — when a run does not start.
