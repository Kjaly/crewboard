# Crewboard

**English** | [Русский](README.ru.md)

[![CI](https://github.com/Kjaly/crewboard/actions/workflows/ci.yml/badge.svg)](https://github.com/Kjaly/crewboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Status:** 0.4.0 (version from the package manifests; both packages prepared for npm) · Node.js 24+ · used on macOS with dsh 0.1.5 release candidates · Linux and Windows untested

**See your coding agents at work, across projects.**\
One board for plans, runs, costs, and decisions.

Crewboard is a plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) and a `crewboard` command-line tool (`orch` is the same program). Both work on one plan per repository, kept next to the code and outside Git history.

![Screenshot of the Crewboard graph: one plan's tasks on six lanes with their workers; in the sidebar, "Needs you" from a second repository and the plan's lane tree.](docs/assets/hero-graph.png)

*The example plan that ships with Crewboard: one repository's graph, and a second repository waiting for a decision in the sidebar.*

## How it works

1. **A goal becomes a plan.** In dsh, the chat that runs the plan (the orchestrator) drafts tasks and contracts from your goal. In a terminal, `crewboard init` and `crewboard task add` do it by hand.
2. **Workers chosen by the preset take tasks.** Codex, Claude Code, DeepSeek through dsh, and Devin work in one plan. The preset decides which worker takes each class of task, at the effort you registered it with (how hard its model thinks); a person may pick another, an agent may not. Each run gets its own working copy (a Git worktree).
3. **The orchestrator checks first.** When a worker finishes, the orchestrator takes the result for checking (`crewboard verify`) — it can also run the contract's own checks itself, next to the worker's claim. It hands the task to you with a note, or returns it to the worker with findings. This is on while the plan has a chat; otherwise finished work comes straight to you. Work too risky to hand to a worker (integration on a stand, the owner's database) is a `root` task the orchestrator does itself (`crewboard start`, then `crewboard verify --done --report`), and a decision reaches you only once the orchestrator has prepared its options.
4. **The orchestrator closes routine work.** After a positive verdict, its check and green contract checks, it can accept and merge with `orchestra_close`. You decide explicit decision tasks, disputed results and contracts marked `<human_review>`. You can still accept or send work back yourself.
5. **Accepted work is merged into its plan branch.** Acceptance leaves the task branch separate. `orchestra_close` can perform the merge after checking the base and conflicts; the screen and `crewboard merge` remain available to you. Until the merge lands, Crewboard shows **Accepted, not merged**, and dependent tasks wait.

## Is it for you

I run several repositories through coding agents and could not see what each agent was doing, where I had to step in, or how to mix providers in one plan. Crewboard is the tool I built for that, and I am sharing it because it helped me.

**It is for you if** you keep several repositories going, use more than one coding agent, and want to see what they do and make the final call yourself.

**It is not for you if** one agent and one small change is all you need, or you want agents to accept their own work. Contracts and review are deliberate overhead.

## What you see and decide

- **Every repository in one sidebar.** Connected repositories, their plans, and a **Needs you** queue for anything that waits on a person.
- **The plan is a graph.** Tasks have dependencies, a class, and a contract that states the result and the checks. You see each task's state and the critical path.
- **A run ledger for every run.** What the run did and what it claims: events, changed files, the worker's report, and which contract checks it says it ran.
- **Costs kept apart.** Money charged, an estimate at API prices, and "no data" never look the same. See [what each number means](docs/en/costs.md).
- **Judgment stays yours.** The orchestrator can accept and merge routine checked work; decisions, disputed results and explicit human review remain with you.

## Install

**Current install: from a source checkout.** The npm release is not published yet, so the commands below are the install path today; `npm install -g crewboard` and `dsh plugin --profile web add dsh-crewboard` become available only after a maintainer publishes the release (see [releasing](docs/releasing.md)).

### Prerequisites

- **To install:** Node.js 24 or newer, pnpm 11.5.2, and Git.
- **For the screen:** dsh (DeepSeek Harness): `npm install -g @deepseek-ai/dsh`. The CLI works without it.
- **For the orchestrator chat** (Quick start A, **From chat**): a DeepSeek API key. The chat runs on DeepSeek inside dsh; add the key in dsh under **Settings → Models**, or export `DEEPSEEK_API_KEY`. dsh workers use the same key.
- **For each worker:** its CLI installed and ready: `codex login`, `devin auth login`, or a dsh worker with the DeepSeek key above. Automated Claude Code needs an explicit `ANTHROPIC_API_KEY` against the official Anthropic endpoint instead of a subscription login (see [the API-only policy](docs/notes/2026-09-28-anthropic-automation-policy.md)). `crewboard preflight` checks all of them, and the screen marks a worker **ready** only after that check passed.
- **To accept on the screen:** dsh running on a macOS host. **Accept** asks for confirmation in a macOS dialog; elsewhere, accept in a terminal with `crewboard accept <id>`.

Build the CLI from a checkout; you get both `crewboard` and `orch`:

```sh
git clone https://github.com/Kjaly/crewboard.git
cd crewboard
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/main.js --help
```

The quick-start examples below write `crewboard` (and `orch`). From a checkout without a global install, run them as `node packages/cli/dist/main.js …`, or define shell functions that use the absolute path (for this shell session):

```sh
CREWBOARD_CLI="$PWD/packages/cli/dist/main.js"
crewboard() { node "$CREWBOARD_CLI" "$@"; }
orch() { crewboard "$@"; }
```

Only want the terminal? Stop here: the CLI works without dsh and has no private runtime dependency. dsh adds the screen, notifications, the orchestrator chat, and dsh workers.

To add the screen, install the plugin from the same checkout into dsh's `web` profile by path:

```sh
dsh plugin --profile web add "$PWD/packages/plugin"
```

After publication these two steps become `npm install -g crewboard` and `dsh plugin --profile web add dsh-crewboard`.

Then add the repositories to show: press **+** next to **Repositories** on the screen and paste a folder path, or run `crewboard init` (or `crewboard repo add`) inside a repository. dsh workspaces appear on their own; the plugin's `repos` setting and `CREWBOARD_REPOS` still work. Details and what to check in your dsh are in [plugin setup](docs/en/plugin-setup.md#connect-repositories).

[CONTRIBUTING.md](CONTRIBUTING.md) has the full source-build steps, the checks, and how to run the plugin stand.

Checked on macOS (Node.js 24.16, pnpm 11.5.2) from a source checkout and a throwaway dsh profile. Not checked: the screen in every dsh version, a clean machine, Linux, Windows.

## Quick start A: from the dsh chat

1. Run `dsh web` and open **Orchestration**: the graph icon (three linked dots) in dsh's left column; its tooltip reads Orchestration.
2. With no plan yet, choose **From chat**. It opens a dsh chat that asks the agent to draft a plan. Describe your goal, read the draft, and approve it with **Approve as plan**; only a person can. For an existing plan, use **Open plan chat** or **Make this chat the orchestrator**.
3. The chat writes a contract per task and starts workers; the preset picks them. Follow the runs on the **Graph** and **Work** views.
4. When a run finishes, the task shows "Orchestrator is checking" until the chat is done with it.
5. The task then appears in **Needs you**; its panel shows the orchestrator's note above **Accept**. Choose **Accept** or **Send back** and confirm.
6. An accepted task stays in **Needs you** as **Accepted, not merged** until you merge its branch; its panel lists the commands. Dependent tasks start after the merge.

[Review](docs/en/review.md#the-orchestrators-check) explains the check and its setting.

## Quick start B: CLI only

In a Git repository, create a plan and a task, and get a contract skeleton to fill in:

```sh
crewboard init --goal "Split the API into modules"
crewboard task add api --title "Extract the API" --class code --template
```

`--template` writes the skeleton to `.orchestration/contracts/main/api.md`. Open it and fill in what must be true when the work is done (the **Result** section) and the commands a reviewer runs, one per line, between `<checks>` and `</checks>`:

```markdown
## Result

Move the HTTP handlers from src/server.ts into src/api/ without changing behaviour.

## Checks

…

<checks>
- pnpm test
</checks>
```

`run` refuses to start it while it still reads like the unfilled skeleton (`--force` overrides). Then:

```sh
crewboard status          # what is ready, what waits, the critical path
crewboard workers         # registered workers and their order per task class
crewboard run api         # the preset's worker for "code", in its own working copy
crewboard events api      # what the worker is doing
```

After the run, an agent may check the result; a person decides in an interactive terminal:

```sh
crewboard verify api --done --note "tests green"    # optional: the orchestrator's check
crewboard accept api
crewboard reject api --reason "Route compatibility is not verified"   # send back
```

`accept` prints the next step: the work is on the branch `orch/api-…` until you merge it, and tasks that depend on `api` wait for that:

```sh
crewboard merge api                            # or manually: git merge --no-ff orch/api-extract-the-api, in the main checkout on the base branch
crewboard status                               # api is no longer "accepted, not merged"
```

[Getting started](docs/en/getting-started.md) has more detail; the [CLI reference](docs/en/cli.md) lists every command.

## Screens

![Screenshot of the Review view: one decision waiting for you, plan progress, money and quota on separate cards, and the task awaiting review with its verdict and report.](docs/assets/review.png)

*Review: what waits for you, how far the plan got, what it cost, and the task you decide on.*

![Screenshot of a run ledger: the run's worker, time, tokens and cost, a timeline of its steps, and the list of steps.](docs/assets/run-ledger.png)

*Run ledger: what one run did, step by step, and what it cost.*

The sidebar, the task panel, the Work view, and settings are in [getting started](docs/en/getting-started.md#the-screen).

## Limits

- **Evidence is what the run left behind, not proof.** The verdict flags mismatches between the worker's claim and the run; it does not decide. See [review](docs/en/review.md).
- **Costs are only as good as their source.** Some runs report money, some tokens or quota, some nothing.
- **Plans stay in the repository.** They live in `.orchestration/`, excluded through `.git/info/exclude`; worker profiles and presets in `~/.config/crewboard/`. Unaccepted or dirty working copies are never removed automatically.
- **macOS only, so far.** Confirmation dialogs are macOS dialogs, and I check the dsh integration only against the dsh versions I run.
- **Claude automation uses a conservative API-only policy.** The guard is implemented; update Crewboard to activate it; see the [dated policy and implementation status](docs/notes/2026-09-28-anthropic-automation-policy.md). Subscription sign-in is excluded from Crewboard automation; this is stricter than some officially permitted workflows. Interactive Claude outside Crewboard is unaffected, and a guarded Claude run records no API charge — only a client-side estimate kept separate from subscription quota.

The [architecture notes](docs/architecture.md) describe the packages and data flow.

## Documentation and help

- [Documentation index](docs/README.md)
- [Getting started](docs/en/getting-started.md) · [Plugin setup](docs/en/plugin-setup.md) · [CLI reference](docs/en/cli.md) · [Workers](docs/en/workers.md) · [Review](docs/en/review.md) · [Costs](docs/en/costs.md) · [Troubleshooting](docs/en/troubleshooting.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)

Questions and bugs: [GitHub issues](https://github.com/Kjaly/crewboard/issues).
