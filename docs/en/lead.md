# The lead

**English** | [Русский](../ru/lead.md)

The lead is the chat you talk to, connected to Crewboard over MCP: Claude Code, Codex, dsh or any other MCP client. It turns what you want into a goal and assignments, answers workers, raises to you only what it cannot decide, and closes the work. Crewboard learns which client leads from the MCP connection itself and shows it on the screen; a new lead chat can take a goal over with `crewboard_adopt_goal`.

## Tools

| Tool | What it does |
| --- | --- |
| `crewboard_start_goal` | Starts a goal the owner agreed on. Returns `goalId`. |
| `crewboard_agents` | Lists the agents work can go to, with what each can do. |
| `crewboard_assign` | Hands a piece of work to a worker: title, criteria, result kind (`local`, `branch`, `answer`, `decision`), provider (an agent id from `crewboard_agents`), optional model, parent and `after` dependencies, and the owner's message it came from in `quote`. |
| `crewboard_inbox` | Returns everything workers and the owner sent that the lead has not confirmed. Calling it again confirms the previous batch. |
| `crewboard_answer` | Answers a worker's question; the worker continues. |
| `crewboard_escalate` | Raises a worker's question to the owner, with `why`. |
| `crewboard_steer` | Adds a clarification to work in progress. |
| `crewboard_return` | Sends a result back with a note. |
| `crewboard_close` | Closes work that meets its criteria. |
| `crewboard_cancel` | Cancels an assignment and everything under it, stopping their runs. |
| `crewboard_decide_request` | Decides the owner's request from the screen: accepting carries it out, declining needs a reason the owner will read. |
| `crewboard_status` | The goal as a tree with every status and what it is doing now. |
| `crewboard_adopt_goal` | Takes over a goal another chat started. |

Every call names `project`: the absolute path of the repository the lead works in. Crewboard uses the top of that Git repository.

## Waking up for news

The lead keeps this running as a background command:

```sh
crewboard wait --project /path/to/repo
```

It exits with 0 as soon as there is something in the lead's inbox, 2 after `--timeout` (10 minutes by default) with nothing new, and 1 when the server is not running. On exit the lead reads `crewboard_inbox`, acts, and starts the wait again. Events stay in the inbox until the lead calls `crewboard_inbox` again, so a lead chat that drops out before acting does not lose them: the next lead gets them. While a lead waits, it counts as present on the screen.

## Questions

A worker that cannot go on ends its run with a question. The lead answers it with `crewboard_answer`, or, when only the owner can decide, raises it with `crewboard_escalate` and tells you in chat. Your answer from the screen reaches both the worker and the lead's inbox.

## Results

A worker ends with a result. Crewboard shows the node as **Waiting for the lead**: the move is the lead's. It closes the work against the criteria or returns it with a note; returned work continues in the same working copy with the note in context.

## Requests from the owner

On the screen you can ask for something on a node: clarify, stop, hand over to another provider, start now, reopen, or discuss. Each arrives in the lead's inbox as `owner_requested`. The lead decides with `crewboard_decide_request`. Accepting carries the action out; declining needs a reason, which the screen shows on the node. The lead's decision is final; if you disagree, say so in chat.

One action does not wait for the lead: **Emergency stop** on any running work. It stops the work and everything under it at once, and the lead learns about it from its inbox.

## Several chats, one goal

A goal outlives the chat that started it. A new Claude Code chat can take it over with `crewboard_adopt_goal`; the history then shows both conversations in order. A goal whose lead has been silent for a day shows **Paused** until a lead takes it.
