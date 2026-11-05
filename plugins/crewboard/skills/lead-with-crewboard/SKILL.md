---
name: lead-with-crewboard
description: Lead coding work through Crewboard by handing pieces of it to other coding agents (Codex, Claude, DeepSeek or any agent registered in Crewboard) instead of doing everything yourself. Use when the owner asks to delegate, orchestrate, parallelise or hand work to Codex, DeepSeek or other agents, mentions Crewboard, or when the crewboard_* MCP tools are available and a task splits into independent pieces.
---

# Lead with Crewboard

Crewboard runs the work you hand out and shows the owner a live board at http://127.0.0.1:4700. The `crewboard_*` tools come from this plugin's MCP server; the server's own instructions describe each step of leading. This skill adds what makes leading go well.

## Before the first goal

- The tools need a running server. If a `crewboard_*` call fails to connect, ask the owner to run `npx crewboard serve` (Node.js 22.15 or newer) and keep it open, then try again. `npx crewboard doctor` shows which workers can run on this machine.
- `crewboard_goals` lists project goals, root status and work counts.
- `crewboard_assign` accepts `branch` for a new branch and `writableRoots` for existing absolute directories inside registered projects; read-only work ignores these grants.
- `crewboard_agents` lists the agents, their models and the effort levels each one takes. Pick from that list; do not guess ids.

## Handing out work

- Agree on the goal and its criteria with the owner first, in their language, then `crewboard_start_goal` with `project` set to the absolute path of the repository.
- The criteria are the whole brief the worker gets. Write them so a capable engineer who has never seen this repository can start: the context, the files to look at, what to build or answer, how to check it, and what not to touch.
- Choose `resultKind`: `branch` for code (the worker gets its own worktree and branch under `.crewboard/worktrees/`), `local` for small changes in place, `answer` for research, `decision` for a recommendation.
- When another stage needs data, pass an object JSON Schema in `crewboard_assign.schema` and name the fields it needs, for example `verdict` and `findings` for a review. Crewboard validates the schema and bounds its size. Questions and splits still work.
- Choose the agent by the work: a strong model and higher effort for design and tricky changes, a cheaper model and lower effort for searches and mechanical edits. Effort must be one of the agent's levels; leave it out for an agent that takes none.
- Split work into pieces that do not edit the same files, so they can run in parallel. Use `after` for real dependencies only.

## Work launched outside Crewboard

- When work for the current goal runs through Workflow, Agent, porch or another tool outside `crewboard_assign`, reflect it as an external node under the goal or the assignment it serves. Do this when starting the work or when you discover it is already running; do not create an ordinary assignment that would launch the same work again.
- Register one node with `crewboard_track`: `kind` (`workflow`, `agent`, `delegate` for porch, or `other`), `title`, and, when known, `model`, `phase` (phase or role) and `externalId`. `parentId` defaults to the goal. For a Workflow and its agents, use `crewboard_track_batch` with `nodes`: give the Workflow a unique `key` and its agents that `parentKey`, or use `parentId` for an existing parent. Keep the returned `assignmentId` for each node.
- Call `crewboard_track_update` with `project`, `goalId`, `assignmentId`, `text` and optionally `phase` when the phase changes, work is blocked, or new results arrive. Check the original source: Crewboard does not fetch progress or results from it. Keep `externalId` so another lead can find the run.
- After checking the outcome, call `crewboard_track_finish` with the same target, `outcome: "success"` or `"failure"` and `summary` covering the result, evidence and remaining work. Finish children before their parent. Record failures too. If work must stop, stop it through its original tool, verify that it stopped, then record the outcome and reason.
- Crewboard only tracks these nodes: it never launches, restarts or stops their processes. Emergency stop and worker control requests do not control external work; cancelling a parent may mark external descendants cancelled without stopping them. A day without updates makes a node stale; this does not mean its process stopped. Check the source and update or finish it. Reading status does not refresh it. Open external nodes, including stale ones, count as unfinished work and prevent `goal_idle`; reconcile them before closing the goal.

## While the work runs

- Keep `npx crewboard wait --project <path> --timeout 10m` running as a background command and restart it each time it ends. Exit 0 means news: call `crewboard_inbox`. Exit 2 means nothing new.
- Answer worker questions yourself when you can. Escalate to the owner only what is theirs to decide: taste, scope, money.
- Tell the owner in chat, briefly, when something they should know happens: a piece is done, a question waits for them, a run failed.

## Accepting results

- Check each result yourself before closing it: read the diff in the worker's worktree and run the project's checks. Workers' sandboxes may block parts of the test suite (local listeners, process listing), so their own test run is not proof.
- For an assignment with `schema`, read `reported.result` and check `schemaError` in the inbox; status exposes them too. Missing, invalid or oversized data produces `schemaError`: return it with a precise correction. A valid shape still needs review against the criteria. `after` dependants and a worker continuing after split receive the structured results in context; the node panel shows expandable JSON and any schema error.
- If a worker could not commit from its sandbox, it leaves the changes uncommitted: commit them in its worktree yourself, then merge its `crewboard/<id>-...` branch into yours.
- Close with a summary of what was verified, or send the work back with a note that says exactly what is missing.
- When the goal criteria are met, close the goal itself with `crewboard_close`, `assignmentId = goalId` and a summary; cancel an unneeded goal with `crewboard_cancel` and the same id. A `goal_idle` inbox event reminds you when all work is finished: close the goal or assign more work.

- For independent review, assign `resultKind: answer` with `reviewOf` set to the reported branch assignment. Check the review verdict, findings and freshness in `crewboard_status`; use `crewboard_return` with `reviewId` to send findings back, then assign another review after fixes. Closing warns about stale reviews or requested changes.
