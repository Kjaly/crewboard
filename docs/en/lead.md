# The lead

**English** | [Русский](../ru/lead.md)

The lead is the chat you talk to, connected to Crewboard over MCP: Claude Code, Codex, dsh or any other MCP client. It turns what you want into a goal and assignments, answers workers, raises to you only what it cannot decide, and closes the work. Crewboard learns which client leads from the MCP connection itself and shows it on the screen; a new lead chat can take a goal over with `crewboard_adopt_goal`.

## Tools

| Tool | What it does |
| --- | --- |
| `crewboard_start_goal` | Starts a goal the owner agreed on. Returns `goalId`. |
| `crewboard_agents` | Returns `{ agents, presets }`: available agents with their capabilities and enabled presets. |
| `crewboard_assign` | Hands a piece of work to a worker: title, criteria, result kind (`local`, `branch`, `answer`, `decision`), optional `schema` for an object result, `preset` or provider (an agent id from `crewboard_agents`), optional model and `effort` (one of the agent's `efforts`; omit when empty), parent and `after` dependencies, and the owner's message it came from in `quote`. |
| `crewboard_track` | Records one external node without launching work. Returns `assignmentId`. |
| `crewboard_track_batch` | Records 1–100 external nodes in `nodes`; `key` and `parentKey` link parents within the batch. Returns their keys and `assignmentId`s. |
| `crewboard_track_update` | Updates an external node's progress `text` and optional `phase`. |
| `crewboard_track_finish` | Finishes an external node with `outcome` (`success` or `failure`) and `summary`. Finish its open children first. |
| `crewboard_inbox` | Returns everything workers and the owner sent that the lead has not confirmed. Calling it again confirms the previous batch. |
| `crewboard_answer` | Answers a worker's question; the worker continues. |
| `crewboard_escalate` | Raises a worker's question to the owner, with `why`. |
| `crewboard_steer` | Adds a clarification to work in progress. |
| `crewboard_return` | Sends a result back with a note. |
| `crewboard_close` | Closes work that meets its criteria. |
| `crewboard_cancel` | Cancels an assignment and everything under it, stopping runs managed by Crewboard. External processes must be stopped through their original tool. |
| `crewboard_decide_request` | Decides the owner's request from the screen: accepting carries it out, declining needs a reason the owner will read. |
| `crewboard_goals` | Lists project goals with root status and work counts. |
| `crewboard_status` | The goal as a tree with every status and what it is doing now. |
| `crewboard_adopt_goal` | Takes over a goal another chat started. |

Every call names `project`: the absolute path of the repository the lead works in. Crewboard uses the top of that Git repository.

## Choosing a preset

For `crewboard_assign`, optional `branch` names a new branch for a `branch` result; optional `writableRoots` lists existing absolute directories inside registered projects to grant a Codex workspace-write worker. Read-only work ignores these grants.

Read `crewboard_agents` before assigning: user settings may replace or disable any [preset](workers.md#presets). The built-in choices are `cheap` (DeepSeek) for routine work, `normal` (Codex `gpt-6.1-sol`, medium) for everyday coding, `hard` (the same model, high) for difficult reasoning, and `review` (Claude opus) for an independent review. Pass `preset` instead of `provider` to `crewboard_assign`; explicit `model`/`effort` take priority. `note`, when present, gives the lead guidance.

## Work launched outside Crewboard

The lead may start work for the goal through Workflow, Agent, porch or another tool outside `crewboard_assign`. Reflect that work as external nodes so the owner can see it in the same goal tree. Register it when starting the work, or when you discover an existing run. An ordinary assignment would launch another worker; use external tracking for work already launched elsewhere.

Pass `project` and `goalId` to each tracking call:

1. **Register the work.** Call `crewboard_track` with `title` and `kind`: `workflow` for Workflow, `agent` for Agent, `delegate` for porch delegation, or `other`. Include `model`, `phase` (phase or role) and `externalId` when known, so the next lead can find the original run. `parentId` defaults to the goal; set it to an existing assignment or external node to nest the work. For a Workflow with ten agents, use `crewboard_track_batch` with `nodes`: give the Workflow a unique `key` and each agent that `parentKey`. Use either `parentId` or `parentKey` per node. Keep the returned `assignmentId`s for updates.
2. **Update progress.** Read the original tool's status, then call `crewboard_track_update` with `assignmentId`, `text` and optionally `phase` when the phase changes, a blocker appears, or results arrive. State what the work is doing and what it needs next. Crewboard only knows what the lead records; it does not poll the external tool or import its logs automatically.
3. **Record the outcome.** Check the external result, then call `crewboard_track_finish` with `assignmentId`, `outcome: "success"` or `"failure"`, and `summary`. Include where to find the result, what was verified and any remaining work; for a failure, explain the cause. Finish the individual agents before their Workflow. Both outcomes finish tracking; a failure still needs assessing against the goal criteria. If work must stop, stop it through the original tool, confirm it has stopped, and record the outcome and reason.

Crewboard displays these nodes but does not manage their processes: it never launches, restarts or stops them. Emergency stop and requests to control a worker do not control external runs. The lead must carry out such actions through Workflow, Agent, porch or the tool that launched them. Cancelling a goal or parent can mark external descendants cancelled on the board while their processes keep running; stop them separately at the source. For an external node itself, use `crewboard_track_update` and `crewboard_track_finish` rather than the worker control tools.

After a day without a progress update, an open node is marked stale. That means its status needs checking; it does not prove the process has stopped or failed. Check the original source and update or finish the node. Only `crewboard_track_update` on that node refreshes it; reading status or updating other nodes does not. Open external nodes, including stale ones, count as unfinished work and prevent `goal_idle`. Before closing the goal, reconcile every external node and verify its outcome against the goal criteria.

## Waking up for news

The lead keeps this running as a background command:

```sh
crewboard wait --project /path/to/repo
```

Without `--timeout`, it waits until there is news and exits with 0. Repeat `--project` to wait for several repositories; the output identifies the projects whose inboxes have news. With `--timeout`, it exits with 2 if there is nothing new by the deadline. It retries a temporarily unavailable server and exits with 1 if the server remains unreachable. On exit the lead reads `crewboard_inbox`, acts, and starts the wait again. Events stay in the inbox until the lead calls `crewboard_inbox` again, so a lead chat that drops out before acting does not lose them: the next lead gets them. While a lead waits, it counts as present on the screen.

## Questions

A worker that cannot go on ends its run with a question. The lead answers it with `crewboard_answer`, or, when only the owner can decide, raises it with `crewboard_escalate` and tells you in chat. Your answer from the screen reaches both the worker and the lead's inbox.

## Results

A worker ends with a result. Crewboard shows the node as **Waiting for the lead**: the move is the lead's. It closes the work against the criteria or returns it with a note; returned work continues in the same working copy with the note in context.

For a result that later work needs to read as data, pass an object JSON Schema in `crewboard_assign.schema`. For example, add this field to a review assignment:

```json
{
  "schema": {
    "type": "object",
    "properties": {
      "verdict": { "type": "string", "enum": ["approve", "changes"] },
      "findings": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["verdict", "findings"],
    "additionalProperties": false
  }
}
```

Crewboard checks the schema when assigning and limits the size of both schema and result. Codex and Claude receive it through their CLI's structured output support; other agents receive it in the prompt. Questions and splits still work. A successful `reported` event keeps the text summary and adds a validated object in `result`, for example `{"verdict":"approve","findings":[]}`. A missing, invalid or oversized result produces `schemaError`; check that field and return the work with a correction when needed.

The lead receives the data in `crewboard_inbox` and `crewboard_status`. Assignments with `after` receive their dependencies' structured results in context; a worker continuing after its split receives its parts' results too. Schema validation checks the data's shape; the lead still checks the work against the criteria. The node panel shows the latest report, its schema error when present, and expandable JSON.

When the goal criteria are met, the lead closes the goal itself with `crewboard_close`, `assignmentId = goalId` and a summary. If the goal is no longer needed, it uses `crewboard_cancel` with the same id. A `goal_idle` inbox event reminds the lead when all work is finished: close the goal or assign more work.

## Requests from the owner

On the screen you can ask for something on a node: clarify, stop, hand over to another provider, start now, reopen, or discuss. Each arrives in the lead's inbox as `owner_requested`. The lead decides with `crewboard_decide_request`. Accepting carries the action out; declining needs a reason, which the screen shows on the node. The lead's decision is final; if you disagree, say so in chat.

A handoff request is also available for queued work. Accepting changes its agent/model/effort while keeping it queued with the same dependencies; it does not launch a run. On a handoff, `effort: null` removes the assignment's effort override, including for the same agent: the next run uses the agent default, or its CLI default. Omitting `effort` keeps the current choice when staying with the same agent. Previous run snapshots and any pending next-run choices remain separate.

One action does not wait for the lead: **Emergency stop** on work running under Crewboard's control. It stops its managed runs, including those under it, at once, and the lead learns about it from its inbox. External processes must be stopped through their original tool.

## Several chats, one goal

A goal outlives the chat that started it. A new Claude Code chat can take it over with `crewboard_adopt_goal`; the history then shows both conversations in order. A goal whose lead has been silent for a day shows **Paused** until a lead takes it.

Dependencies in `after` must already exist in the same goal and cannot be cancelled. If a dependency is cancelled later, the lead receives a `blocked_dependency` event and can cancel the waiting assignment or use `start_now`.

For independent review, assign `resultKind: answer` with `reviewOf` set to a reported `branch` assignment ID. The reviewer works read-only in its worktree and receives the commit range, criteria and report. Return JSON with `verdict` (`approve` or `changes`) and `findings` (`severity`, `file`, `line`, `problem`, `scenario`). Status and the screen show the reviewed version and freshness. `crewboard_return` with `reviewId` sends findings to the worker; assign another review after fixes. Closing warns about a stale review or `changes`.
