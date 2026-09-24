# Troubleshooting

[Documentation](../README.md) · **English** | [Русский](../ru/troubleshooting.md)

If something here does not match what you see, please [open an issue](https://github.com/Kjaly/crewboard/issues) with the command, its output, and your versions (`npm ls -g crewboard`, `node --version`, `dsh --version`).

## `crewboard: command not found`

The global npm bin directory is not on your `PATH`, or the install used another Node version. Check with `npm prefix -g` and `npm ls -g crewboard`. With a Node version manager, install under the version you run.

## "Not a git repository"

Commands work inside a Git repository. `cd` into it first; any subdirectory works.

## "No plan: run `crewboard init`"

The repository has no plan yet: run `crewboard init` (the message names `orch init` when you typed `orch`). If other plans exist, the message lists them; choose one with `crewboard plan use <id>` or pass `--plan <id>`.

## A run does not start

The message names the reason. The most common ones:

| Message | What to do |
| --- | --- |
| no contract (`Нет контракта…`) | Add one: `crewboard task set <id> --contract <file>`, or run with `--contract <file>`. |
| contract not found (`Контракт не найден…`) | The path is relative to the repository root; check it. |
| task waits (`Задача ждёт: …`) | A dependency is not accepted yet. See `crewboard status`. |
| human decision (`Это решение человека…`) | A `decision` task is closed with `crewboard accept`, not run. |
| "Worker … is disabled on this machine" | Enable it (`crewboard workers enable <id>`) or choose another worker with `-a`. |
| "Preflight … failed" (`Preflight для … не пройден`) with a `✗` list | Fix what the list says — install the CLI, sign in, update it — or pick another worker. `crewboard preflight -a <worker>` repeats the check. |
| "No worker is available for …" | No worker in the class's list passes preflight. Check `crewboard workers` and `crewboard presets list`: the list may be empty in the effective preset, or every worker in it is disabled or failing. |
| red baseline (`Базовый прогон красный…`) | The recipe's `baseline` command failed in the task's worktree, so the task did not go to a worker. Fix the main branch or the recipe; the next launch runs the baseline again in the same copy. |
| worktree preparation failed (`Подготовка worktree упала…`) | A recipe `setup` step failed; its output follows the message. |

Some of these messages are Russian only in version 0.4.0 regardless of `--lang`; the English text above is the meaning.

## A run failed

A failed run is never sent to review; the task goes back to ready, `crewboard status` marks it "last run failed", and the alarm (`crewboard attention --alarms`, the task panel) names the reason:

| Reason | What happened and what to do |
| --- | --- |
| "Claude usage limit reached — resets at HH:MM" | Claude Code refused the turn on your subscription limit (its last `result` had `is_error: true`). Nothing was done. Start the task again after the reset: `crewboard run <id>`. |
| any other text after a Claude run | Claude Code ended the last turn with `is_error: true`; the text is Claude's own error. |
| "the run's supervisor exited; its worker (pid N) was stopped" | The process that watched the run died (killed, machine asleep, disk full). Crewboard found the worker still running in the copy and stopped it. Check the copy before you start again. |
| "the run's supervisor exited; its worker (pid N) had already exited" | As above, but the worker was already gone. A run started by an older Crewboard, which did not record its worker, says only "the run's supervisor exited". |

While the worker of a run whose supervisor died is still alive, a new start is refused ("… its worker (pid N) is still working in the copy") so two workers never write to one copy. Crewboard stops it (SIGTERM, then SIGKILL after 5 s); start again once it is gone.

A finished run's Activity shows its steps from the run's event log. If none of them reach this feed, Activity points to the run ledger instead; it never claims the run did nothing.

## The worker I assigned is not the one that ran — or the run is refused instead of using another worker

A worker named with `-a` or saved on the task is never swapped for another one. If it cannot run, the launch is refused. An automatic pick is saved as the task's worker, so later runs use it too. Change it with `crewboard task set <id> --worker <other>` or `crewboard run <id> -a <other>`. See [how a worker is chosen](workers.md#how-a-worker-is-chosen).

## Claude Code is "older than … required by …"

The model needs a newer Claude Code. Run `claude update`, then `crewboard preflight -a <worker>`. See [CLI version preflight](workers.md#cli-version-preflight).

## `accept` says "Only a human in an interactive terminal can run this command"

This is intended. `accept`, `reject`, `supersede`, `plan approve`, and `worktree gc --force` need an interactive terminal and a `y` answer. Run them yourself, not through an agent or a pipe.

## The screen does not appear in dsh

- Check that the plugin is installed in the profile you start: `dsh plugin --profile web list`.
- Start the web profile (`dsh web`) and look for **Orchestration**: the graph icon (three linked dots) in the left column; its tooltip reads Orchestration.
- The screen needs a running dsh host; the CLI does not.
- **Verify in your dsh** whether your version loads plugin clients; the plugin's browser half targets the web client.

## "No repositories connected"

The plugin has no repositories to show. Press **+** next to **Repositories** and paste a folder path, or run `crewboard repo add` inside a repository. The plugin's `repos` setting and `CREWBOARD_REPOS=/abs/path/one:/abs/path/two` work too; relative paths are ignored. See [plugin setup](plugin-setup.md#connect-repositories).

## "Worker settings are damaged"

The screen found `~/.config/crewboard/profiles.json` unreadable, or its `routing.classes` missing a class. Repositories are still shown. A missing class runs on the default worker order until you save the worker order again in **Settings → Workers**; an unreadable file keeps worker choice and presets from resolving until you fix or remove it (Crewboard then writes the defaults).

## A plan made in the terminal is not on the screen

The place is in none of the lists the screen reads. A plan command says so after its output, with the fix: run `crewboard repo add` in that repository or worktree. `crewboard repo list` shows every place the screen shows and why. A Crewboard task copy (`<repo>-orch-<task>`) is never shown on purpose.

## Costs show "Awaiting usage" or "Unavailable"

For dsh workers, usage appears after dsh records the session, usually on the next `dsh web` start. For other workers, the source may not report the number at all. See [costs](costs.md).

## A worktree is not removed

Cleanup keeps unaccepted, running, dirty, and unmerged copies, and the three most recently accepted ones. `crewboard worktree gc` shows the reason for each copy. To remove one copy with changes in it, run `crewboard worktree gc --force <id>` yourself.

## My old `orch` setup

Nothing needs to be moved by hand. `orch` still works and is the same program. On first use, `~/.config/dsh-orchestra/` is copied to `~/.config/crewboard/` (the original stays), `ORCH_*` environment variables are still read, and a plugin configured under the old id `dsh-orchestra` keeps its `repos` list. Plan data in `.orchestration/` is unchanged.
