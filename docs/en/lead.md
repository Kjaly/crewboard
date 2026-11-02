# The lead

**English** | [Русский](../ru/lead.md)

The lead is the chat you talk to: Claude Code connected to Crewboard over MCP. It turns what you want into a goal and assignments, answers workers, raises to you only what it cannot decide, and closes the work. Any MCP-capable chat can lead; Claude Code is the one Crewboard is built and tested with.

## Tools

| Tool | What it does |
| --- | --- |
| `crewboard_start_goal` | Starts a goal the owner agreed on. Returns `goalId`. |
| `crewboard_assign` | Hands a piece of work to a worker: title, criteria, result kind (`local`, `branch`, `answer`, `decision`), provider (`claude`, `codex`, `deepseek`), optional model, parent and `after` dependencies, and the owner's message it came from in `quote`. |
| `crewboard_inbox` | Reads and acknowledges what workers and the owner sent since the last call. |
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

It exits with 0 as soon as there is something in the lead's inbox, 2 after `--timeout` (10 minutes by default) with nothing new, and 1 when the server is not running. On exit the lead reads `crewboard_inbox`, acts, and starts the wait again. While a lead waits, it counts as present on the screen.

## Questions

A worker that cannot go on ends its run with a question. The lead answers it with `crewboard_answer`, or, when only the owner can decide, raises it with `crewboard_escalate` and tells you in chat. Your answer from the screen reaches both the worker and the lead's inbox.

## Results

A worker ends with a result. Crewboard shows the node as **Waiting for the lead**: the move is the lead's. It closes the work against the criteria or returns it with a note; returned work continues in the same working copy with the note in context.

## Requests from the owner

On the screen you can ask for something on a node: clarify, stop, hand over to another provider, start now, reopen, or discuss. Each arrives in the lead's inbox as `owner_requested`. The lead decides with `crewboard_decide_request`. Accepting carries the action out; declining needs a reason, which the screen shows on the node. The lead's decision is final; if you disagree, say so in chat.

One action does not wait for the lead: when the lead has not been seen for 10 minutes, the screen offers **Emergency stop** for running work. It stops at once and the lead learns about it from its inbox.

## Several chats, one goal

A goal outlives the chat that started it. A new Claude Code chat can take it over with `crewboard_adopt_goal`; the history then shows both conversations in order. A goal whose lead has been silent for a day shows **Paused** until a lead takes it.
