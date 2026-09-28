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
| needs a contract (`Task … needs a contract…`) | Write one from the template: `crewboard task set <id> --template`, then fill in the result and the checks; or attach your own: `crewboard task set <id> --contract <file>`, or run with `--contract <file>`. |
| `Warning: the contract of … has no checks` / `… does not ask for the result line` | The run starts, but the report has nothing to be compared with, or will read as disputed. Add a `<checks>` block and a report section with the line `Result: received \| negative \| blocked`. |
| "Contract not found: …" | The path is relative to the repository root; check it. |
| "The task is waiting for: …" | A dependency is not accepted yet. See `crewboard status`. |
| "This is a human decision…" | A `decision` task is closed with `crewboard accept`, not run. |
| "Worker … is disabled on this machine" | Enable it (`crewboard workers enable <id>`) or choose another worker with `-a`. |
| "Preflight for … failed" with a `✗` list | Fix what the list says — install the CLI, sign in, update it — or pick another worker. `crewboard preflight -a <worker>` repeats the check. |
| "No worker is available for …" | No worker the effective preset may use passes preflight. The message lists the installed workers that could do the class — ready ones outside a saved preset, and ones a check stopped, with the reason — and the command that routes the class to one, `crewboard workers route <class> <worker>`. Sign in, pick another preset, or route the class. |
| "The baseline run is red…" | The recipe's `baseline` command failed in the task's worktree, so the task did not go to a worker. The message shows the last lines; the full output is in the file it names. Fix the main branch or the recipe; the next launch runs the baseline again in the same copy. The task panel keeps it as the **Last attempt** (see below). |
| "Worktree preparation failed: recipe step failed: …" | A recipe `setup` step failed; the message names the step and shows the last lines, the full output is in the file it names. The task panel keeps it as the **Last attempt**. |
| "The copy of … holds N uncommitted change(s) from the previous run" | See [Starting again on a copy with changes](#starting-again-on-a-copy-with-changes). |

Messages follow the interface language: `--lang`, else the locale; on the screen, the language of dsh.

## "waiting for a check slot (N ahead)"

A baseline, `crewboard verify <id> --run-checks`, or a worker's own long command run through `crewboard slot -- <command…>` is waiting for a free machine-wide check slot — several worktrees or workers are testing at once and the machine's slot count is full. It prints the line and waits; nothing is wrong, and the command runs with its exit code and output unchanged once a slot frees up. `crewboard slot` shows the current slot count, `crewboard slot --set <n>` raises or lowers it (default: a quarter of the machine's cores, at least one). If a slot never frees, look for a crashed process still holding one under `~/.config/crewboard/slots/`: a holder whose process is gone is taken over at once, so this should be rare.

## A run failed

A failed run is never sent to review; the task goes back to ready. Every failed attempt records a reason code next to its text, and the task panel shows it as the **Last attempt** block in Overview — how the attempt ended, the reason in words, when, and the one action that fits; **Start** stays available as the secondary button. `crewboard status` puts the same on the task's row (`last attempt failed: … → …`, and `lastAttempt` in `--json`), and `crewboard attention --alarms` names the reason.

| Reason (code) | What happened | What to do |
| --- | --- | --- |
| Usage limit reached — resets at HH:MM (`rate_limited`) | The worker's subscription refused the turn on its limit: Claude's last `result` had `is_error: true`, Codex reported a usage limit, or an API answered 429. Nothing was done. | **Try again** after the reset: `crewboard run <id>`. |
| The worker is not logged in, or its login expired (`auth_expired`) | The worker's CLI is logged out, its token expired, or the API key was refused. | For Codex or Devin, **Log in** runs nowhere by itself: it copies `codex login` or `devin auth login` to run in a terminal, then **Try again**. For dsh, check the API key in dsh Settings → Models. For an automated Claude run, the current API-only guard needs a working `ANTHROPIC_API_KEY` against the official Anthropic endpoint — a subscription re-login does not fix it. The CLI may still print the legacy `claude auth login` hint because the failure message has not been updated; do not treat a subscription re-login as the fix. |
| The run's supervisor exited (`interrupted`) | The process that watched the run died (killed, machine asleep, disk full). With a pid: Crewboard found the worker still running in the copy and stopped it, or it had already exited. | Check the copy, then **Try again**. |
| No space left on the disk (`disk_full`) | A write failed with ENOSPC — in the worker, in its supervisor or while preparing the copy. | Free some disk space, then **Try again**. |
| Preparing the copy failed: `<step>` (`setup_failed`) | A recipe `setup` step (or `git worktree add`) failed; no worker started. | **Show output** shows the last lines and the file with the full output. Fix the recipe or the environment, then **Start**. |
| The baseline run is red: `<command>` (`baseline_red`) | The recipe's `baseline` command failed in the copy; the task was not sent to a worker. | **Show output** shows the last lines and the file. Fix the main branch or the recipe, then **Start**; the baseline runs again in the same copy. |
| The worker failed (`worker_error`) | Anything else. The block quotes the worker's own `Error:` line rather than the first bytes of its output. | Read the line and the run's Activity, then **Try again** or start with another worker. |

A run that ended without handing its work in is not a failure: its **Last attempt** is "Ended unfinished" with **Continue** (`crewboard continue <id>`). A run you stopped is "Stopped" with **Try again**.

A worker running a long command is not by itself a failure: the card and `crewboard status` show "command running N min — pnpm test…" while a command is in flight (Claude, Codex and dsh, which pair a command's start with its result; Devin's events do not, so it is never read as in flight), or "quiet for N min" once it goes quiet — both information, not an alarm. **Needs you** lists a running task only once a command outlasts 30 minutes or a quiet spell outlasts 20, tagged "may be stuck" (with **Stop** and **Give direction**), or once its worker process is gone, tagged "worker gone"; a run that actually failed still reads "failed". **Stop** in the task panel ends it.

While the worker of a run whose supervisor died is still alive, a new start is refused ("… its worker (pid N) is still working in the copy") so two workers never write to one copy. Crewboard stops it (SIGTERM, then SIGKILL after 5 s); start again once it is gone.

A finished run's Activity shows its steps from the run's event log. If none of them reach this feed, Activity points to the run ledger instead; it never claims the run did nothing.

## Starting again on a copy with changes

When the previous run left uncommitted changes in the task's copy, a new start asks first: **Continue with the changes** keeps them for the next worker, **Reset the copy** discards the uncommitted changes and untracked files (the worker's commits and ignored files such as dependencies stay). In a terminal `crewboard run <id>` asks the same question; `--keep-changes` or `--reset-copy` answers it in advance. The choice is a person's: an agent, or a command run without an interactive terminal, is refused with both commands named. **Continue**, a relaunch and `steer --relaunch` carry the previous run's changes by design and ask nothing.

## The worker I assigned is not the one that ran — or the run is refused instead of using another worker

A worker named with `-a` or saved on the task is never swapped for another one. If it cannot run, the launch is refused. An automatic pick is saved as the task's worker, so later runs use it too. Change it with `crewboard task set <id> --worker <other>` or `crewboard run <id> -a <other>`. See [how a worker is chosen](workers.md#how-a-worker-is-chosen).

## Claude Code is "older than … required by …"

The model needs a newer Claude Code. Run `claude update`, then `crewboard preflight -a <worker>`. See [CLI version preflight](workers.md#cli-version-preflight).

## `accept` says "Only a human in an interactive terminal can run this command"

Manual acceptance needs an interactive terminal. For ordinary checked work, an orchestrator can use `crewboard accept <id> --auto`, then `crewboard merge <id> --auto`. Decisions, disputed results, and contracts with `<human_review>` remain with a person. `reject`, `supersede`, `plan approve`, and `worktree gc --force` also need a person.

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

## When something went wrong

### The plan is damaged: "plan.json is damaged and cannot be read"

A plan file broken by hand or by a crash is left in place, and a copy of it is saved next to it (`plan.json.corrupt-…`). Every save keeps the version it replaced as `plan.json.prev` (`plans/<id>.json.prev` for other plans), so the message offers a way back when that version exists:

```sh
crewboard plan restore --plan <id>
```

Only a person in a terminal can run it, after a confirmation that shows the revision, time and task count of the version it brings back. The file as it is now becomes the previous version, so a second `plan restore` undoes the first. Anything saved after that version is not in it; check `crewboard status` afterwards. With no previous version, the command says so and changes nothing.

### "The plan is busy: … is held by process …"

Saves take `.orchestration/plan.lock`, which records the process id, the host and the time. A lock left by a process that is gone is taken over at once. A live one is waited for a few seconds; after that the command stops and names the holder. Let it finish or stop it, and run the command again. A lock from another host or from an older Crewboard is taken over once it is older than ten seconds.

### "No space left on the disk for …", "No permission to write …", "… is on a read-only disk"

Crewboard could not write a state file under `.orchestration/` and names it. A plan save writes nothing in that case: the plan stays as it was. Free some space, fix the owner or permissions of the folder, or run the command where the repository is writable, then run it again. `crewboard status`, `attention` and `events` still answer on such a disk: runs that finished meanwhile are shown, and recorded on the next command that can write.

## My old `orch` setup

Nothing needs to be moved by hand. `orch` still works and is the same program. On first use, `~/.config/dsh-orchestra/` is copied to `~/.config/crewboard/` (the original stays), `ORCH_*` environment variables are still read, and a plugin configured under the old id `dsh-orchestra` keeps its `repos` list. Plan data in `.orchestration/` is unchanged.
