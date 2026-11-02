# The screen

**English** | [Русский](../ru/screen.md)

The screen is at http://127.0.0.1:4700/. It follows the lead's work live; there is nothing to refresh. It speaks English and Russian: it follows your browser's language, and the **RU** / **EN** button in the header switches it.

## Sidebar

Every repository Crewboard knows, with its goals underneath. Each goal is one conversation with the lead. A goal shows how many things wait for you, how much is in work, and **lead is offline** when its lead has been silent for 10 minutes. On a narrow screen the sidebar opens from the header.

**Waiting for you** in the header counts what waits for you across all projects and jumps to the first such node.

## Now

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/en/now-dark.png">
  <img alt="The Now screen with a question waiting for the owner." src="../assets/en/now-light.png">
</picture>

- **Summary**: how many nodes wait for you, wait for the lead, run, are queued and are finished.
- **Tree**: the goal at the root, assignments under whoever gave them. What waits for you comes first; finished work folds into **Finished N**. Under each node: what it is doing right now.
- **Context** of the selected node: the request or question if there is one, the actions, who assigned it, **Where it came from** (the owner's message) with **Open in history**, the criteria, the parts inside it, its history and its working copy.

On a phone the context opens as a sheet from the bottom.

<picture class="phone">
  <source media="(prefers-color-scheme: dark)" srcset="../assets/en/mobile-dark.png">
  <img alt="The Now screen on a phone: the context of a node waiting for the owner, as a sheet." src="../assets/en/mobile-light.png">
</picture>

### Statuses

| On screen | Meaning |
| --- | --- |
| Queued | assigned, not started yet; it may wait for another assignment |
| Running | a worker is at it |
| Waiting for the lead | the worker asked, reported, or its run failed: the lead's move |
| Waiting for you | the lead raised a question to you |
| Done | the lead closed it against the criteria |
| Cancelled | stopped, with the reason |
| Abandoned | its parent finished, or nothing happened for a day after its run ended |
| Paused | the goal's lead has been silent for a day |

## Requests from the tree

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/en/request-dark.png">
  <img alt="A request on a node: the lead declined it and the reason shows on the node." src="../assets/en/request-light.png">
</picture>

The actions follow the status:

| On screen | Offered when |
| --- | --- |
| Clarify, Stop, Hand over | the work runs or waits for the lead |
| Start sooner, Cancel | it is queued |
| Reopen | it is done |
| Bring back | it was cancelled or abandoned, and its parent is not finished |
| Discuss with the lead | always |

Each is a request to the lead. The node shows "Requested: …. The lead is deciding", then the result, or "The lead declined: …" with the reason.

**Discuss with the lead** copies a ready message about the node to paste into the chat, and lets the lead know.

**Emergency stop** appears only while the lead is away, and asks for a second click.

### Keys

With the tree focused: **↑ ↓** move, **U** clarify, **S** stop, **P** hand over, **C** discuss. **Esc** closes the sheet. The letters work on any keyboard layout.

## History

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/en/history-dark.png">
  <img alt="The History tab: the conversation with the lead and the assignments it handed out." src="../assets/en/history-light.png">
</picture>

The whole conversation with the lead, read from Claude Code's transcripts: your messages, the lead's answers, assignments as cards with their live status (a card opens the node), and the lead's other tool calls folded into a count. Text Claude Code injects itself (skill bodies, notifications, compaction summaries) is left out. Every chat that touched the goal is shown, in order.

When no transcript is found, the tab says so and lists the messages the assignments came from.

## Analytics

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/en/analytics-dark.png">
  <img alt="The Analytics tab: provider lanes over time and costs." src="../assets/en/analytics-light.png">
</picture>

For looking back: one lane per provider with each run over time, and costs by provider and by assignment. See [costs](costs.md).
