# Review and decisions

[Documentation](../README.md) · **English** | [Русский](../ru/review.md)

A finished run is not an accepted task. When a worker stops, its task waits for review, and only a person decides what happens next. Crewboard collects what the run left behind and compares it with what the worker claims, so the decision is quicker — but the decision stays yours.

![Review: a finished run with its verdict, checks, and the Accept and Send back buttons](../assets/review.png)

*A run waiting for review: the verdict, its facts, and the decision actions.*

## The three decisions

| Decision | CLI | Screen | Effect |
| --- | --- | --- | --- |
| Accept | `crewboard accept <id>` | **Accept** | The task is done; dependent tasks can start. The verdict is stored with the decision. |
| Send back | `crewboard reject <id> --reason "…"` | **Send back** | The task returns with your reason and can be run again. |
| Supersede | `crewboard supersede <id> --by <other>` | task menu, **Supersede with a task…** | The task is closed because another variant won. |

**Only a person can take them.**

- The CLI asks `[y/N]` and refuses to run without an interactive terminal. An agent running commands in the background gets "Only a human in an interactive terminal can run this command."
- The screen asks for a native macOS confirmation before the host applies the decision. Several tasks can be accepted together from the review queue; the confirmation lists them. **Verify in your dsh** that the dialog appears.
- The dsh chat tools let an orchestrating agent plan, run, and supervise, but they include no acceptance tool.

A task of kind `decision` has no run at all; it exists so that a person closes it with `crewboard accept`.

## The orchestrator's check

Between "the worker finished" and "waiting for you" there can be one more step: the orchestrator checks the work first. The orchestrator is the dsh chat that runs the plan, or an agent that calls the CLI. It runs the gates, looks at the result, and then hands the task to you with a short note or returns it to the worker. Agents may do all of this; the check never accepts anything.

| Step | CLI | dsh chat tool | Effect |
| --- | --- | --- | --- |
| Take | `crewboard verify <id>` | `orchestra_verify`, `action=take` | The orchestrator takes a finished task for checking. The screen shows "Orchestrator is checking — the work reaches you when it is done". |
| Done with a note | `crewboard verify <id> --done --note "…"` | `action=done` with `note` | Checked. The task now waits for you, with the note above **Accept**. The note is required. |
| Return with findings | `crewboard verify <id> --return "findings"` | `action=return` with `note` | Back to the worker: a new run starts in the same worktree with the findings. `--skip-preflight` skips the availability check. |

Only finished work waiting for review can be checked; anything else is refused with "Task … is not finished work waiting for review." `--done` and `--return` work with or without a take first.

While a check is due or in progress, the task stays out of **Needs you**. In dsh, the plan's chat is told when finished work waits for its check. You can still decide early: accepting a task whose check is not finished adds "The orchestrator has not finished checking … — accept without it?" to the confirmation.

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

The claim is read from the first line of the worker's final answer: `Result: received`, `Result: negative`, or `Result: blocked` (the Russian `Результат: получен | отрицательный | заблокирован` works too). Ask for this line in your contracts; when the plugin's chat agent writes a contract, it asks for it.

A verdict is **disputed** when:

- the worker claims a result, but the run failed or was stopped;
- the worker claims a result, but no files changed;
- the run finished without a report;
- the report has no result line.

A disputed verdict points at a mismatch. It does not decide, and a "result received" verdict is not a guarantee.

### Facts shown with the verdict

- files changed, or no changes;
- a line of the report that mentions tests or checks, marked when it reports a failure;
- a mention of the deviations journal;
- how long the run took;
- the checks from the contract's `<checks>` block: how many the report says were run, not run, or does not mention.

Crewboard does not run your checks itself. "Run" means the report mentions the command together with an outcome (for example "passed" or "5 tests"); it is the worker's statement, not a re-run. If you need certainty, run the checks in the worktree yourself.

## Evidence

When a run finishes, Crewboard writes `.orchestration/runs/<run>/evidence.json` once and does not overwrite it. It contains:

- the worker and model;
- the contract path and a SHA-256 of the contract as it was at launch;
- the worker's full final answer and its first (claim) line;
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
