# Review and decisions

[Documentation](../README.md) · **English** | [Русский](../ru/review.md)

A finished run is not an accepted task. When a worker stops, its task waits for review, and only a person decides what happens next. Crewboard collects what the run left behind and compares it with what the worker claims, so the decision is quicker — but the decision stays yours.

![Review: a finished run with its verdict, checks, and the Accept and Send back buttons](../assets/review.png)

*A run waiting for review: the verdict, its facts, and the decision actions.*

## The four decisions

| Decision | CLI | Screen | Effect |
| --- | --- | --- | --- |
| Accept | `crewboard accept <id>` | **Accept** | The result is taken. The verdict is stored with the decision. The work is still on the task's branch: dependent tasks start once you merge it (see [After acceptance: merge](#after-acceptance-merge)). |
| Send back | `crewboard reject <id> --reason "…"` | **Send back** | The task returns with your reason and can be run again. |
| Supersede | `crewboard supersede <id> --by <other>` | task menu, **Supersede with a task…** | The task is closed because another variant won. |
| Drop | `crewboard drop <id> --reason "…"` | task menu, **Close as not needed…** | The task is closed as not needed. The reason stays in its history; it never becomes ready again and leaves the critical path. |

**Only a person can take them.**

- The CLI asks `[y/N]` and refuses to run without an interactive terminal. An agent running commands in the background gets "Only a human in an interactive terminal can run this command."
- The screen asks for a native macOS confirmation before the host applies the decision. Several tasks can be accepted together with **Accept in batch** (the review queue, Work and the board open the same sheet); the confirmation lists them. **Verify in your dsh** that the dialog appears.
- The dsh chat tools let an orchestrating agent plan, run, and supervise, but they include no acceptance tool.

A task of kind `decision` has no run at all; it exists so that a person closes it with `crewboard accept`.

## The orchestrator's check

Between "the worker finished" and "waiting for you" there can be one more step: the orchestrator checks the work first. The orchestrator is the dsh chat that runs the plan, or an agent that calls the CLI. It runs the gates, looks at the result, and then hands the task to you with a short note or returns it to the worker. Agents may do all of this; the check never accepts anything.

| Step | CLI | dsh chat tool | Effect |
| --- | --- | --- | --- |
| Take | `crewboard verify <id>` | `orchestra_verify`, `action=take` | The orchestrator takes a finished task for checking. The screen shows "Orchestrator is checking — the work reaches you when it is done". Taking a task it already checked changes nothing: the task stays with you. |
| Reopen | `crewboard verify <id> --reopen` | `action=reopen` | The orchestrator takes a checked task back from you to check it again. |
| Done with a note | `crewboard verify <id> --done --note "…"` | `action=done` with `note` | Checked. The task now waits for you, with the note above **Accept**. The note is required. The orchestrator first sees the verdict you will see; a disputed verdict or no changed files needs its confirmation (`--confirm`, or `confirm: true` in the tool). |
| Return with findings | `crewboard verify <id> --return "findings"` | `action=return` with `note` | Back to the worker: a new run starts in the same worktree with the findings. `--skip-preflight` skips the availability check. |

Only finished work waiting for review can be checked; anything else is refused with "Task … is not finished work waiting for review." `--done` and `--return` work with or without a take first.

While a check is due or in progress, the task stays out of **Needs you**. In dsh, the plan's chat is told when finished work waits for its check. You can still decide early: accepting a task whose check is not finished adds "The orchestrator has not finished checking … — accept without it?" to the confirmation.

Work the orchestrator does itself — a `root` task, such as integration on a stand — and decisions follow the same rule without a worker run: the orchestrator reports a root task with `crewboard verify <id> --done --note "…" [--report <file>]` (tool: `orchestra_verify`, `action=done` with `note` and `report`) and prepares a decision the same way, and only then do they reach you — the report shows where a worker's does (see [the CLI reference](cli.md#the-orchestrators-own-work)). A root task's verdict is computed the same way as a worker's; a decision has none — see [Decisions have no verdict](#decisions-have-no-verdict). **Accept in batch** names every decision or root task in the batch the orchestrator has not checked before it asks.

### The setting

**Orchestrator checks finished work** is set per repository, and a plan can override it. The value in force is the plan's own, else the repository's, else the default: **on while the plan has a chat** (a dsh chat bound to the plan as its orchestrator), off otherwise. So a plan run only from the terminal sends finished work straight to you unless you turn the check on.

On the screen, the setting sits next to the preset choice. In the terminal:

```sh
crewboard verify --setting on                 # this plan (the current one, or --plan <id>)
crewboard verify --setting off --scope repo   # the repository; asks a person to confirm
crewboard verify --setting default            # clear the stored value
```

Turning the check off asks for a person in an interactive terminal, because finished work then reaches you unchecked. Work that was waiting for a check when it was turned off goes straight to you. The repository value is stored in `.orchestration/settings.json`.

### Waiting for check steps

`crewboard wait --for check` returns when a check step happens: a check becomes due (`pending`), is taken (`checking`), is done (`checked`, with the note), or sends the work back (`returned`). `--for any` includes these steps. Exit codes are those of `wait`: `0` on an event, `2` on timeout, `1` on error.

## The verdict

The task panel shows a verdict above the decision actions. It is one of three kinds:

| Verdict | When | What it means for you |
| --- | --- | --- |
| **Result received** | The worker claims a result and the facts do not contradict it. | Check the changes against the contract as usual. |
| **Negative result** | The worker says it could not produce the result, or is blocked. | Accepting closes the task *without* a result; the CLI question says so. |
| **Verdict disputed** | The claim and the facts do not match. | Look at the named mismatch before deciding. |

The claim is the line `Result: received`, `Result: negative`, or `Result: blocked` (the Russian `Результат: получен | отрицательный | заблокирован` works too). It is read from the first five non-empty lines of the worker's final answer, or from the first line under a report heading (`## Report`, `## Отчёт`, `## Итог`), so a report that starts with its heading and puts the claim right under it counts. List, quote, bold and code marks around the line are ignored, and so is anything after the value (`Result: received — all checks green`). A claim quoted in the middle of a sentence or buried in prose does not count. Ask for this line in your contracts; when the plugin's chat agent writes a contract, it asks for it.

### Decisions have no verdict

A decision is your own choice, not a worker's claim, so Crewboard computes no verdict for it, even when the orchestrator stored a report with it. Its panel shows the checklist and **Where to look** (the results of the tasks it depends on), without worker, model or task-class lines, and the accept question — on the screen and in `crewboard accept` — asks you to close the decision instead of naming a mismatch.

A verdict is **disputed** when:

- the worker claims a result, but the run failed or was stopped;
- the worker claims a result, but no files changed;
- the run finished without a report;
- the report has no result line.

A disputed verdict points at a mismatch. It does not decide, and a "result received" verdict is not a guarantee.

### Accepting in batch

**Accept in batch · N** is the one way to accept several tasks at once; the review queue, Work and the board open the same sheet. It reads each task's verdict first and pre-selects only clean work: a received result, or a decision the orchestrator prepared. Negative, disputed and unchecked work, and work whose verdict could not be read, sits in a separate **Open first** group without ticks, each row with its reason; you can still tick it on purpose. The sheet and the macOS confirmation count what you chose: «Accept 10 tasks? 1 clean, 9 at risk.» Each row of the review queue shows its verdict too.

### Unfinished runs

A run whose worker stopped without handing its work in does not reach review. When the worker's process ends cleanly but its worktree has uncommitted changes and the answer has no result line, the run ends **unfinished** (`incomplete`): the task stays ready, **Needs you** lists it with the reason («ended without a report; N files uncommitted»), and the task panel offers **Continue** — a new run in the same worktree, told to finish the work, commit it and report. `crewboard continue <id>` does the same from a terminal.

An unfinished run is not checked by the orchestrator: there is nothing handed in to check. `crewboard wait` reports its finish as `(incomplete)`, and the orchestrator continues it with `orchestra_run` on the task (or `crewboard continue <id>`); the check starts when the continued run finishes.

The usual cause is a worker that started long checks in the background and ended its turn to wait for them. Crewboard tells every worker to run long checks in the foreground, and a Claude Code run stays open while the worker's own background work runs: its completion is delivered to the worker as a new turn, and the run ends after that turn. After an hour of waiting the worker is told to stop waiting and report.

### Facts shown with the verdict

- files changed, or no changes;
- a line of the report that mentions tests or checks, marked when it reports a failure;
- a mention of the deviations journal;
- how long the run took;
- the checks from the contract's `<checks>` block: how many the report says were run, not run, or does not mention.

Crewboard does not run your checks itself. "Run" means the report mentions the command together with an outcome (for example "passed", "green", "ok", "✓", "5 tests", or the Russian «прошёл», «зелёный», «пройдены», «упал», «9 тестов»); it is the worker's statement, not a re-run. If you need certainty, run the checks in the worktree yourself.

## Evidence

When a run finishes, Crewboard writes `.orchestration/runs/<run>/evidence.json` once and does not overwrite it. It contains:

- the worker and model;
- the contract path and a SHA-256 of the contract as it was at launch;
- the worker's full final answer and its claim line (the answer's first line when it has no claim);
- the changed files with added and deleted line counts, counted from the commit where the worktree branched off the repository's `HEAD` (untracked files included, `.orchestration/` excluded);
- each check from the contract's `<checks>` block with its state: `run`, `not_run`, `unreported`, or `unreadable`;
- when it was captured.

If the contract changed after launch, checks are marked unreadable rather than compared with a contract the worker never saw.

Evidence does not store diff bodies or command output; the diff is in the worktree while it exists. Runs finished before evidence capture existed are not backfilled. Saved runs from an older setup stay readable when their files are available, but steering, stopping, or relaunching them is refused.

## Before you accept

1. Read the report and the verdict. If it is disputed, start with the mismatch.
2. Open the changes. On the screen, the **Changes** tab; in the terminal, the task's worktree (`crewboard worktree list`).
3. Compare with the contract: result, scope, non-goals, checks.
4. Run the checks yourself if the report does not convince you.
5. Accept, or send back with a reason the next run can act on.

After acceptance, the worktree may be removed, depending on the cleanup setting (**after acceptance**, **on request**, or **never remove**). Copies with uncommitted or unmerged changes are kept either way.

## After acceptance: merge

Accepting does not change your base branch. The work stays on the task's branch (`orch/<id>-…`) until a person or the orchestrator merges it; Crewboard does not merge by itself.

- **Merged** means the task's work is in the base branch — the branch checked out in the main repository, which new working copies are made from — and the copy holds nothing uncommitted. The work counts as in the base when any of these holds:
  1. the branch is an ancestor of the base (a merge commit or a fast-forward);
  2. merging the branch would change nothing (`git merge-tree` yields the base's own tree): a squash or rebase merge;
  3. a commit on the base made since the fork, no older than the branch tip, names the branch (`Merge branch 'orch/a-x'`) or quotes the branch tip's hash (the default message of `git merge --squash`): a squash merge whose conflicts were resolved by hand;
  4. one commit on the base carries the branch's whole net change (same `git patch-id`).

  Once the work has reached the base, a later revert does not make the task unmerged again: that is a separate decision. A squash merge edited while merging, whose message names neither the branch nor its tip, is not recognised — the task stays «Accepted, not merged» and shows the commands. Crewboard checks this on every refresh and records when it saw the merge. A branch that is gone together with its copy counts as merged: cleanup removes only merged copies, and `git branch -d` refuses an unmerged branch.
- Until then the task is **Accepted, not merged**: in **Needs you**, on the **Work** board, in the Review band, in `crewboard status` and in `crewboard attention`. Its panel says what to do and lists the exact commands with **Copy commands**; `crewboard accept` prints the same commands.
- A dependency counts as done only when it is merged. Before that the dependent task shows "waiting for X to be merged", and `crewboard run` (and the chat's run tool) refuses with the commands. A copy started earlier would not contain the dependency's work. A person who wants to start anyway runs `crewboard run <id> --allow-unmerged` in an interactive terminal; agents cannot.
- A task closed with a negative result has nothing to merge and never holds its dependents. Decisions and root tasks have no branch.

**Uncommitted work.** A worker may leave its changes in the copy without a commit. The branch then does not contain the result, and `git merge` answers "Already up to date". The verdict shows "N files not committed — not on the branch", and the accept confirmation says so before you decide. After acceptance, the commands start by committing those files on the task branch:

```sh
git -C /work/repo-orch-api add -A
git -C /work/repo-orch-api commit -m 'crewboard: api'
git -C /work/repo merge --no-ff orch/api-extract-the-api
```

Crewboard prints these commands instead of committing for you: what goes into the commit (generated files, stray artefacts) is a person's call. Merging from Crewboard itself is planned.
