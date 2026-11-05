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
- Choose the agent by the work: a strong model and higher effort for design and tricky changes, a cheaper model and lower effort for searches and mechanical edits. Effort must be one of the agent's levels; leave it out for an agent that takes none.
- Split work into pieces that do not edit the same files, so they can run in parallel. Use `after` for real dependencies only.

## While the work runs

- Keep `npx crewboard wait --project <path> --timeout 10m` running as a background command and restart it each time it ends. Exit 0 means news: call `crewboard_inbox`. Exit 2 means nothing new.
- Answer worker questions yourself when you can. Escalate to the owner only what is theirs to decide: taste, scope, money.
- Tell the owner in chat, briefly, when something they should know happens: a piece is done, a question waits for them, a run failed.

## Accepting results

- Check each result yourself before closing it: read the diff in the worker's worktree and run the project's checks. Workers' sandboxes may block parts of the test suite (local listeners, process listing), so their own test run is not proof.
- If a worker could not commit from its sandbox, it leaves the changes uncommitted: commit them in its worktree yourself, then merge its `crewboard/<id>-...` branch into yours.
- Close with a summary of what was verified, or send the work back with a note that says exactly what is missing.
- When the goal criteria are met, close the goal itself with `crewboard_close`, `assignmentId = goalId` and a summary; cancel an unneeded goal with `crewboard_cancel` and the same id. A `goal_idle` inbox event reminds you when all work is finished: close the goal or assign more work.
