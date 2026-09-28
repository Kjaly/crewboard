# Review and decisions

[Documentation](../README.md) · **English** | [Русский](../ru/review.md)

A finished run is not an accepted task. The orchestrator checks its report, changed files and contract checks. A clean positive result can be accepted and merged with `orchestra_close`; decisions, disputed results, conflicts, contracts marked `<human_review>`, and failures the orchestrator cannot repair remain for a person.

![Review: a finished run with its verdict, checks, and the Accept and Send back buttons](../assets/review.png)

*A run waiting for review: the verdict, its facts, and the decision actions.*

## What waits on you

Everything that waits on a person — a review, a decision, a failed or stalled run, accepted work not merged yet — is counted once, by one rule, and the canonical queue reads the same number in the sidebar's **Review queue** heading, the browser tab title and the favicon dot, the Orchestration icon badge, the board's **Review queue · N** chip, the band at the top of Review, and `crewboard attention`. (Current screen text says **Review queue**; older text, some captions and `crewboard help all` still call it **Needs you** — the same queue. The **Work** board groups by its own "needs attention" rule, so its **To review** column can count differently; the [2026-09-28 documentation audit](../audits/2026-09-28/documentation.md) records that known discrepancy.) A background plan counts by the tasks that wait in it, not as one row; the example plan is listed while you look at it but never counted.

Routine checked work can also leave this queue without a person: when the orchestrator accepts and merges it automatically, the row stops waiting once its branch is in the base. Decisions, disputed or negative results, conflicts and contracts with `<human_review>` do not leave by themselves, and a failure the orchestrator cannot repair comes to you.

A number always says its scope: «in this plan 7 · all 13» — the open plan, and everything across your repositories. `crewboard attention` says «in this plan 7 · in this repository 9», since it reads one repository (`--all` reads them all and says «all 13»).

The **Review queue** in the sidebar groups the work by repository and plan. Each group starts with a summary — «6 tasks wait for review · 1 decision» — and each row has a tag with its reason:

| Tag | Why it waits |
|---|---|
| review | A worker's task finished and waits for your acceptance. |
| check off | The same, in a plan where the orchestrator does not check finished work. |
| blocked | The worker reported it could not go on; it needs your answer. |
| decision | A decision task waits for you to choose. |
| failed | A run failed, or another run alarm that is not a stall. |
| may be stuck | A command has been running 30 minutes, or the run has been quiet 20; the row offers **Stop** and **Give direction**. |
| worker gone | The worker's process is gone. |
| not merged | Accepted work is still on its branch. |

A group shows its first five rows and «N more»; a row's tooltip has the full title. A plan you are not looking at is one row with its summary; clicking it opens that plan.

### Notifications

When work starts to wait on you, Crewboard tells you once per change, grouped by plan and reason: «3 tasks wait for review · 1 decision in “Ship the release”», never one notification per task. A burst that arrives within a few seconds is one notification. The in-app toast says the same; its **Open** button, like a click on a browser notification, opens that plan's review queue. The notification goes to the browser (Settings → Crewboard → notifications) or, when no browser tab has taken it, to macOS; the macOS banner does not carry a click action. Accepted work waiting for a merge is your own last move and does not notify. There is no external channel (webhook, phone push).

## The four decisions

| Decision | CLI | Screen | Effect |
| --- | --- | --- | --- |
| Accept | `crewboard accept <id>` | **Accept** | The result is taken. The verdict is stored with the decision. The work is still on the task's branch: dependent tasks start once you merge it (see [After acceptance: merge](#after-acceptance-merge)). |
| Send back | `crewboard reject <id> --reason "…" [--rerun [-a <worker>]]` | **Send back**, or **Send back and rerun** | The task returns with your reason. The reason goes into the next run's prompt; with rerun that run starts at once (see [Send back and rerun](#send-back-and-rerun)). |
| Supersede | `crewboard supersede <id> --by <other>` | task menu, **Supersede with a task…** | The task is closed because another variant won. |
| Drop | `crewboard drop <id> --reason "…"` | task menu, **Close as not needed…** | The task is closed as not needed. The reason stays in its history; it never becomes ready again and leaves the critical path. |

**Routine checked work can be accepted and merged by the orchestrator.** Decisions, disputed results, conflicts, contracts with `<human_review>`, and failures it cannot repair remain with a person.

- For ordinary checked work, a Codex chat uses `crewboard accept <id> --auto` followed by `crewboard merge <id> --auto`; a dsh chat uses `orchestra_close` with `action=both`. A Codex chat does not receive dsh host tools when dsh restarts.
- Automatic acceptance and merge require receipts for every mandatory check at the current worktree HEAD and contract revision. If HEAD changes, rerun checks and review; renew any existing attestation. If the contract changes since launch, rerun checks and explicitly attest the current result. Automatic merge applies these rules even after manual acceptance.
- Manual acceptance and the other judgment decisions still ask for a person in an interactive terminal.
- The screen asks for a native macOS confirmation before the host applies the decision. Several tasks can be accepted together with **Accept in batch** (the review queue, Work and the board open the same sheet); the confirmation lists them. Decisions are never part of a batch — each is confirmed one by one in its task panel. **Verify in your dsh** that the dialog appears.
- A run marked `incomplete` with preserved changes because files were uncommitted or its answer's result line was not recognized can be taken over without a worker rerun. After reviewing and committing its copy, the orchestrator supplies its own positive report with `crewboard verify <id> --done --note "…" --report <file>`. Crewboard preserves the original incomplete outcome and binds the new report to the checked commit. Automatic acceptance still requires the copy to remain clean and listed contract checks to be green on that commit.

A task of kind `decision` has no run at all; it exists so that a person closes it with `crewboard accept`, or so that the orchestrator records an answer the person already gave in chat with `crewboard decision answer <id> --answer "…" --basis "…"` (tool: `orchestra_decision_answer`) — no second Accept is asked for. The record shows the answer and the basis it was taken from, attributed to the orchestrator, who answers for the basis matching what the person wrote; nothing checks the message's authenticity and other chats are not read. «Study it and propose» is not an answer: `crewboard decision prepare <id> --reason "…"` (tool: `orchestra_decision_prepare`) returns the open decision to the orchestrator's preparation — the question leaves your queue until it is prepared again, and its dependents stay blocked. The open questions of an approved plan draft become such tasks, each titled as its question; the graph lists them under **Open questions to you**, and `crewboard attention` groups them the same way.

## Send back and rerun

A reason you give when you send work back is meant for the worker. Crewboard puts it into the prompt of the task's next run, after the contract, in the part of the prompt that changes from run to run — whoever starts that run: you, the orchestrator, or `crewboard run`. A run that already read it does not get it again.

- **Send back and rerun** in the task panel's Send back form, or `crewboard reject <id> --reason "…" --rerun`, sends the task back and starts the next run at once, in the same worktree, with the previous run's worker. Pick another worker from the preset in the form, or with `-a <worker>` in the CLI. One confirmation covers both steps.
- Plain **Send back** (`reject` without `--rerun`) only sends the task back; the panel then says «Sent back: “…”. The reason goes into the next run's prompt.»
- A decision or a root task has no worker run to repeat: rerun is not offered for them, and `--rerun` is refused before anything is sent back. If the launch itself is refused after the send back (preflight, a red baseline), the task stays sent back and ready to start.
- The rerun keeps the first attempt in view: the task panel shows the earlier run folded as «Run 1 (returned)» with its worker, how it ended and your reason, and a link to its activity.
- The **Changes** tab marks each file `A` (added), `M` (modified) or `D` (deleted), with `+`/`−` line counts when git gives them.

## The orchestrator hears your decisions

When a plan has a dsh chat bound to it, the host wakes that chat with a short `[crewboard] …` message for a check that is due, work waiting for you, and each of your decisions — accept, send back with its reason, a decision answered, drop, merge, mark as merged — once per decision. This works for every plan with a bound chat, not only the plan open on the screen; a muted chat stays quiet. The latest decision of each task is also in the orchestrator's `orchestra_plan` tool and in `crewboard status --json` as `lastDecision`: `{by, at, verdict, reason}` — plus `answer` and `basis` on an answer recorded from chat — where `verdict` is `accepted`, `answered`, `sent_back`, `dropped`, `superseded`, `merged` or `marked_merged`.

## The orchestrator's check

Between "the worker finished" and "waiting for you" there can be one more step: the orchestrator checks the work first. The orchestrator is the dsh chat that runs the plan, or an agent that calls the CLI. It runs the gates, looks at the result, and then hands the task to you with a short note or returns it to the worker. Agents may do all of this; the check never accepts anything.

| Step | CLI | dsh chat tool | Effect |
| --- | --- | --- | --- |
| Take | `crewboard verify <id>` | `orchestra_verify`, `action=take` | The orchestrator takes a finished task for checking. The screen shows "The orchestrator is checking". Taking a task it already checked changes nothing: the task stays with you. |
| Reopen | `crewboard verify <id> --reopen` | `action=reopen` | The orchestrator takes a checked task back from you to check it again. |
| Done with a note | `crewboard verify <id> --done --note "…"` | `action=done` with `note` | Checked. The task now waits for you, with the note above **Accept**. The note is required. The orchestrator first sees the verdict you will see; a disputed verdict or no changed files needs its confirmation (`--confirm`, or `confirm: true` in the tool). Routine checked work can then be auto-accepted and merged (see [the four decisions](#the-four-decisions)); decisions, root tasks and exceptions still wait for you. |
| Return with findings | `crewboard verify <id> --return "findings"` | `action=return` with `note` | Back to the worker: a new run starts in the same worktree with the findings. `--skip-preflight` skips the availability check. |
| Run the checks | `crewboard verify <id> --run-checks` | `action=checks` | Crewboard runs the contract's `<checks>` in the task's worktree and records the outcome as the orchestrator's (see [Checks run by Crewboard](#checks-run-by-crewboard)); the tool answers with each command's outcome. |

### Independently attest a worker result

For a completed worker run in review, record an explicit orchestrator judgement with:

```sh
crewboard verify <id> --attest --verdict result|negative|disputed --report <file> --note "…"
```

The proof file must carry a matching primary `Result:` claim: `Result: received` (or another positive value) for `result`, and `Result: negative` or `Result: blocked` for `negative`. The `disputed` verdict currently has a report-parsing limitation: a bare `Result: disputed` is not recognized, so `--verdict disputed` cannot be recorded from that line (see the [known limitations](../audits/2026-09-28/documentation.md#known-limitations)). The equivalent dsh tool call is `orchestra_verify` with `action=attest`, `verdict`, `report` (repo-relative proof path) and `note`.

An attestation is stored beside the worker report and does not rewrite the worker's run or evidence. It binds the latest run, proof hash, orchestrator, time, current worktree HEAD and current contract revision. A positive attestation additionally requires a clean committed copy and passing Crewboard receipts for every mandatory contract check at that HEAD and revision. Historical words such as “blocked” or “browser NOT RUN” in the proof do not override its structured verdict; declared deviations remain visible.

Details, acceptance and merge recheck freshness. A changed or unreadable proof, run, HEAD, contract or mandatory receipt makes a pending positive attestation stale; re-review and attest the current state before positive acceptance or merge. `verify --done --note` records only the ordinary check note; it does not promote the result. Existing `<human_review>` requirements still require a person.

Only an ordinary finished task in review can be taken, checked, attested or run through `--run-checks`; `--takeover` works on a ready task whose incomplete run preserved uncommitted work. `--done` and `--return` work with or without a take first, and `--done --report` also finishes a root task or prepares a decision.

While a check is due or in progress, the task stays out of the **Review queue**. In dsh, the plan's chat is told when finished work waits for its check. You can still decide early: the confirmation then says "The orchestrator has not checked … yet — accept anyway?".

Work the orchestrator does itself — a `root` task, such as integration on a stand — and decisions follow the same rule without a worker run: the orchestrator reports a root task with `crewboard verify <id> --done --note "…" [--report <file>]` (tool: `orchestra_verify`, `action=done` with `note` and `report`) and prepares a decision the same way, and only then do they reach you — the report shows where a worker's does (see [the CLI reference](cli.md#the-orchestrators-own-work)). A root task's verdict is computed the same way as a worker's; a decision has none — see [Decisions have no verdict](#decisions-have-no-verdict). **Accept in batch** names every root task in the batch the orchestrator has not checked before it asks; a batch never holds a decision.

### The setting

**Orchestrator checks finished work** is set per repository, and a plan can override it. The value in force is the plan's own, else the repository's, else the default: **on while the plan has a chat** (a dsh chat bound to the plan as its orchestrator), off otherwise. So a plan run only from the terminal sends finished work straight to you unless you turn the check on.

On the screen, the setting sits next to the preset choice. In the terminal:

```sh
crewboard verify --setting on                 # this plan (the current one, or --plan <id>)
crewboard verify --setting off --scope repo   # the repository; asks a person to confirm
crewboard verify --setting default            # clear the stored value
```

Turning the check off asks for a person in an interactive terminal, because finished work then reaches you unchecked. Work that was waiting for a check when it was turned off goes straight to you. The repository value is stored in `.orchestration/settings.json`.

### Where the check stands

Every worker's task in review says where its check stands, in the same words on the graph card, in Work, in the **Review queue**, in the task panel, in `crewboard status` and in `crewboard attention`:

| State | Meaning |
| --- | --- |
| Waiting for the orchestrator's check | The check is on and due; the task is the orchestrator's, not yours yet. |
| The orchestrator is checking | The orchestrator took it. |
| Checked by the orchestrator | Done, with the orchestrator's note. A check the orchestrator ran with the setting off reads the same. |
| No orchestrator check — off for this plan (no orchestrator chat) | The setting is not stored and the plan has no orchestrator chat, so finished work comes straight to you. A plan run from a terminal or from a Claude Code session is in this state. |
| No orchestrator check — turned off for this plan / for this repository | Someone turned the setting off there. |

The "off" line on the task panel links to the setting. The accept confirmation, on the screen and in `crewboard accept`, starts with one line about the check: checked, not checked yet (accept anyway), or no check for this plan and why; **Accept in batch** groups its tasks under the same lines. `crewboard run` and **Start** on the task panel say once when the check is off for the plan: "The orchestrator check is off for this plan (no orchestrator chat); `crewboard verify --setting on` turns it on." Nothing is switched for you. In JSON (`crewboard status --json`, `crewboard attention --json`) each task carries `check: {state, source}`: `state` is `pending`, `checking`, `checked` or `off`, and `source` is where the setting comes from — `plan`, `repository`, `chat`, or `default` (no chat).

### Waiting for check steps

`crewboard wait --for check` returns when a check step happens: a check becomes due (`pending`), is taken (`checking`), is done (`checked`, with the note), or sends the work back (`returned`). `--for any` includes these steps. Exit codes are those of `wait`: `0` on an event, `2` on timeout, `1` on error.

## The verdict

The task panel shows the verdict immediately before the next action. The verdict is one of three kinds:

| Verdict | When | What it means for you |
| --- | --- | --- |
| **Result received** | The worker claims a result and the facts do not contradict it. | Check the changes against the contract as usual. |
| **Negative result** | The worker says it could not produce the result, or is blocked. | **Send back** keeps the task open and records a correction; you may start another run in the same worktree. **Accept without result** closes it and may leave dependent work blocked. The native confirmation names that consequence. A blocked report alone is not a question for you. |
| **Verdict disputed** | The claim and the facts do not match. | Look at the named mismatch before deciding. |

### Who acts next

| State | Next step |
| --- | --- |
| Worker running or orchestrator check pending | The worker or orchestrator acts. The panel shows progress; early human review is tucked under **Review before check**. |
| Checked, clean positive result with a bound chat | The orchestrator tries to accept and merge it after the required checks. The panel says it is closing; **Review manually** is available if needed. |
| Blocked, negative, disputed or deviating result | The orchestrator first checks whether it can repair the task or resolve a prerequisite. If it hands the exception to you, **Send back** is primary; accepting the exception is secondary and confirmed. |
| Prepared decision or a contract requiring human review | You choose after reading the recommendation and evidence. The confirmation records the choice. |
| Accepted branch still outside its base | The orchestrator tries the merge when the latest run has its check. A conflict or unsafe merge remains for review. |

The panel keeps the next action and verdict visible. Its worktree, routing and dependency details are under **Task context**; the orchestrator note, check logs and full report expand on demand. A reported check and a check Crewboard ran are separate facts: “Worker did not run contract checks” can coexist with “2/2 passed” from Crewboard.

The claim is the line `Result: received`, `Result: negative`, or `Result: blocked` (the Russian `Результат: получен | отрицательный | заблокирован` works too). It is read from the first five non-empty lines of the worker's final answer, or from the first line under a report heading (`## Report`, `## Отчёт`, `## Итог`), so a report that starts with its heading and puts the claim right under it counts. List, quote, bold and code marks around the line are ignored, and so is anything after the value (`Result: received — all checks green`). A claim quoted in the middle of a sentence or buried in prose does not count. Ask for this line in your contracts; when the plugin's chat agent writes a contract, it asks for it.

### Decisions have no verdict

A decision is your own choice, not a worker's claim, so Crewboard computes no verdict for it, even when the orchestrator stored a report with it. Its panel shows the checklist and **Where to look** (the results of the tasks it depends on), without worker, model or task-class lines, and the accept question — on the screen and in `crewboard accept` — asks you to close the decision instead of naming a mismatch.

A verdict is **disputed** when:

- the worker claims a result, but the run failed or was stopped;
- the worker claims a result, but no files changed;
- the run finished without a report;
- the report has no result line.

A disputed verdict points at a mismatch. It does not decide, and a "result received" verdict is not a guarantee.

The verdict and its short reason also show on the graph card, on the Work card, in the **Review queue**, in `crewboard status` and in `crewboard attention` (`verdict` in their JSON), so you can see a blocked or disputed task before you open it. They are read from the run's recorded evidence; a run recorded before this had no verdict there.

A result whose report declares a deviation from the contract — a line such as `Deviation: …` or a `## Deviations` section that does not say "none" — is not shown as a clean result: it reads **Result received · deviation declared** in amber, the deviation is a fact under the verdict, and **Accept in batch** does not pre-select it.

### Accepting in batch

**Accept in batch · N** is the one way to accept several tasks at once; the review queue, Work and the board open the same sheet. It reads each task's verdict first and pre-selects only clean work: a received result. Decisions are not part of the sheet — each one is opened from the queue and confirmed in its task panel. Negative, disputed and unchecked work, and work whose verdict could not be read, sits in a separate **Open first** group without ticks, each row with its reason; you can still tick it on purpose. The sheet and the macOS confirmation count what you chose: «Accept 10 tasks? 1 clean, 9 at risk.» Each row of the review queue shows its verdict too.

### Unfinished runs

A run whose worker stopped without handing its work in does not reach review. When its worktree has uncommitted changes and the answer has no recognized result line, the run ends **unfinished** (`incomplete`): the task stays ready and the Review queue names the reason. **Continue** starts another run in the same copy when substantive worker work remains. If the changes are already ready for orchestrator review, `crewboard verify <id> --takeover --note "reason"` preserves that copy and avoids a rerun just for a claim or commit; the orchestrator must still verify, commit, and report the result.

An unfinished run is not checked by the orchestrator: there is nothing handed in to check. `crewboard wait` reports its finish as `(incomplete)`, and the orchestrator continues it with `orchestra_run` on the task (or `crewboard continue <id>`); the check starts when the continued run finishes.

The usual cause is a worker that started long checks in the background and ended its turn to wait for them. Crewboard tells every worker to run long checks in the foreground, and a Claude Code run stays open while the worker's own background work runs: its completion is delivered to the worker as a new turn, and the run ends after that turn. After an hour of waiting the worker is told to stop waiting and report.

The worker is also told to send long check output to a file and read back only the failing part or the tail. Every worker prompt has one order, the steady part first, so a prompt cache can reuse it: the worker rules (the same for every run), the task's contract (the same for every run of the task), then what changes per run — the previous run, the step to continue from, the person's or orchestrator's note, the **Continue** direction.

### Facts shown with the verdict

- files changed, or no changes;
- a line of the report that mentions tests or checks, marked when it reports a failure;
- a mention of the deviations journal;
- how long the run took;
- the checks from the contract's `<checks>` block: how many the report says were run, not run, or does not mention;
- a deviation from the contract the worker declares;
- changed files outside the paths the contract names in a `<paths>` block (one directory, file or `*` glob per line), listed;
- the checks Crewboard ran itself, once someone asked it to (see below): «Checks run by Crewboard: 3/3 passed», or how many failed and which;
- a mismatch, in red: the worker claims a result, but Crewboard saw a check fail that the worker did not declare as not run.

On its own, "run" means the report mentions the command together with an outcome (for example "passed", "green", "ok", "✓", "5 tests", or the Russian «прошёл», «зелёный», «пройдены», «упал», «9 тестов»); it is the worker's statement, not a re-run.

### Checks run by Crewboard

To check the worker's statement, have Crewboard run the contract's checks itself: **Run checks here** on the task panel of a task in review, or `crewboard verify <id> --run-checks` in a terminal (the orchestrator may run it too). Crewboard runs each command of the contract's `<checks>` block in the task's worktree, one after another, with the recipe's environment (the variables it unsets) and its timeout per command. Only the commands of the contract run — nothing from the worker's report. A contract without a `<checks>` block says so, and the button is replaced by that sentence.

Each command's full output goes to a file under `.orchestration/output/<task>/`; the panel and `crewboard task show` show how many passed, and for each failure its exit code (or the timeout), its last 20 lines and the file. The result is stored as `.orchestration/runs/<run>/checks.json`, next to the run's evidence and apart from the worker's claim; running the checks again replaces it. The verdict is not rewritten: the checks add facts, and a failure the worker called passed is a red mismatch fact. `crewboard verify <id> --run-checks` exits `1` when a check failed. Checks run only for a task whose last run has finished.

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
4. If the report does not convince you, **Run checks here** (or `crewboard verify <id> --run-checks`) and read what Crewboard saw beside the worker's claim.
5. Accept, or send back with a reason the next run can act on.

After acceptance, the worktree may be removed, depending on the cleanup setting (**after acceptance**, **on request**, or **never remove**). Copies with uncommitted or unmerged changes are kept either way.

## After acceptance: merge

Accepting does not change your base branch. The work stays on the task's branch (`orch/<id>-…`) until it is merged. A person can use **Merge** in the task panel or `crewboard merge <id>` in a terminal (see [Merge from Crewboard](#merge-from-crewboard)). The orchestrator can merge routine accepted work with `crewboard merge <id> --auto` when the automatic checks permit it. You can also merge by hand with the commands the panel shows.

- **Merged** means the task's work is in the base branch — the task's recorded base, the repository's [default base](cli.md#base-branch) at the time its copy was made (never whatever branch happened to be checked out in the main repository at that moment, unless a person chose one on purpose) — and the copy holds nothing uncommitted. The work counts as in the base when any of these holds:
  1. the branch is an ancestor of the base (a merge commit or a fast-forward);
  2. merging the branch would change nothing (`git merge-tree` yields the base's own tree): a squash or rebase merge;
  3. a commit on the base made since the fork, no older than the branch tip, names the branch (`Merge branch 'orch/a-x'`) or quotes the branch tip's hash (the default message of `git merge --squash`): a squash merge whose conflicts were resolved by hand;
  4. one commit on the base carries the branch's whole net change (same `git patch-id`).

  Once the work has reached the base, a later revert does not make the task unmerged again: that is a separate decision. A squash merge edited while merging, whose message names neither the branch nor its tip, is not recognised — the task stays «Accepted, not merged» and shows the commands. Crewboard checks this on every refresh and records when it saw the merge. A branch that is gone together with its copy counts as merged: cleanup removes only merged copies, and `git branch -d` refuses an unmerged branch.
- Until then the task is **Accepted, not merged**: in the **Review queue**, on the **Work** board, in the Review band, in `crewboard status` and in `crewboard attention`. Its panel offers **Merge** and **Squash and merge** and lists the exact commands with **Copy commands**; `crewboard accept` prints the same commands and names `crewboard merge`.
- A dependency counts as done only when it is merged. Before that the dependent task shows "waiting for X to be merged", and `crewboard run` (and the chat's run tool) refuses with the commands. A copy started earlier would not contain the dependency's work. A person who wants to start anyway runs `crewboard run <id> --allow-unmerged` in an interactive terminal; agents cannot.
- A task closed with a negative result has nothing to merge and never holds its dependents. Decisions and root tasks have no branch.

**Uncommitted work.** A worker may leave its changes in the copy without a commit. The branch then does not contain the result, and `git merge` answers "Already up to date". The verdict shows "N files not committed — not on the branch", and the accept confirmation says so before you decide. After acceptance, the commands start by committing those files on the task branch:

```sh
git -C /work/repo-orch-api add -A
git -C /work/repo-orch-api commit -m 'crewboard: api'
git -C /work/repo merge --no-ff orch/api-extract-the-api
```

Crewboard prints these commands instead of committing for you: the responsible reviewer must choose what goes into the commit (generated files, stray artefacts). When the contract assigns commits to the orchestrator, it inspects and commits before acceptance. **Merge** refuses such a task until those files are committed. If the files were already carried into the base by hand, see [Work landed by hand](#work-landed-by-hand).

### Merge from Crewboard

**Merge** in the panel of an accepted, not merged task, or `crewboard merge <id>` in an interactive terminal, merges the task's branch into its base in the main repository. Before it asks you anything it checks:

- the base branch is checked out in the main repository — the task's recorded base (for copies made before Crewboard recorded it: the repository's [default base](cli.md#base-branch), `origin/HEAD` else `main` or `master`). Another branch or a detached HEAD is refused with the command to switch;
- the main repository has no uncommitted changes to tracked files (Crewboard's own `.orchestration/` aside);
- the task's copy holds nothing uncommitted;
- the merge would not conflict: Crewboard tries it with `git merge-tree --write-tree`, which changes no files. A conflict is refused with the conflicting paths, and nothing changes.

The default is a merge commit (`--no-ff`) whose message names the task branch: `Merge branch 'orch/a-x' (crewboard: a — …)`. **Squash and merge** (`--squash`) makes one commit whose message names the branch and its tip. After the merge the task records `merged` with the new commit, the task feed says so, and its copy gets the same cleanup as after acceptance and `worktree gc`: it is removed under **after acceptance** unless it is one of the three most recently accepted copies. A squash-merged branch is kept (`git branch -d` refuses it); Crewboard deletes only branches git itself calls merged.

Merging needs a person: the screen asks in a native dialog, the CLI asks `[y/N]` (`--yes` skips the question) and refuses without an interactive terminal. There is no agent tool for it. Git 2.38 or newer is needed for the trial merge.

### Work landed by hand

Sometimes the work reaches the base without the task's branch: a worker left its changes uncommitted, and the orchestrator copied the files into the main checkout and committed them there — often on a hub with a detached HEAD, and often edited again by later tasks. Git has no branch commit to follow, so two ways out exist.

**Landed by content.** An accepted task whose branch work is in the base but whose copy holds uncommitted changes counts as merged when every changed or added file in the copy is byte-identical to the same file at the tip of the base, and every file deleted in the copy is absent there. The journal folder `docs/tmp/` and Crewboard's own `.orchestration/` are ignored. Crewboard checks this on every refresh like any other merge and writes «merged into … by content» in the task feed. One file that differs — say a later task edited it again — keeps the task «Accepted, not merged». Files are compared as bytes on disk: a file git would normalise on commit (line endings) differs, and the task stays unmerged.

**Mark as merged by a person.** When the work is in the base but no longer byte for byte, or was merged in another clone, a person records it: **Mark as merged…** next to the merge commands in the task panel, or in an interactive terminal:

```sh
crewboard mark-merged api --reason "carried into the hub by hand, then edited by api-fix"
```

It asks for a confirmation (a native dialog on the screen, `[y/N]` in the terminal), touches nothing in git and works on a detached HEAD. The task is recorded as merged by a person, the reason stays in its feed, it leaves «Accepted, not merged» and its dependents may start. There is no agent tool for it, and the CLI refuses a caller without a terminal. Use it only after you checked that the work is really in the base: dependents start from the base as it is.

When the main checkout has a detached HEAD, the panel names the base as «the current commit of <path> (detached)» instead of a bare hash.

## Conflicts before acceptance

While a task waits in review, Crewboard tries to merge its branch into its base and into every other task waiting in review, with the same `git merge-tree` trial — no files change. A conflict shows before you accept:

- in the task panel, next to the verdict: «conflicts with main in src/a.ts», «conflicts with task b in src/a.ts», with **Send back with this text**, which fills Send back with a ready request to bring the branch up to date with the base;
- on the queue row in Review;
- in `crewboard status`: on the task's line, and under «Conflicts in review» with a ready `crewboard reject <id> --reason "…"`; `--json` adds `conflicts` and `sendBack` per task.

The answer is kept per pair of commits, so it is computed again only when a branch or the base moves — a task reaching review, a new commit on the base, a worker's new commit. A conflict between two tasks in review means the second one merged will need an update; sending one of them back is your call.
