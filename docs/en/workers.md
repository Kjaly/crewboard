# Workers

**English** | [Русский](../ru/workers.md)

Workers are the agents that do assignments. Crewboard runs each through its own command-line tool, reads what it does, and passes its questions and results to the lead.

## Providers

| Provider | Runs as | Default model | Needs |
| --- | --- | --- | --- |
| Codex | `codex` CLI | `gpt-6.1-sol` | `codex login` |
| Claude | `claude` CLI | `sonnet` | `ANTHROPIC_API_KEY` |
| DeepSeek | `dsh`, DeepSeek Harness | `deepseek-flash` | `dsh` installed, DeepSeek key in its settings |

The lead may name another model per assignment (`model` in `crewboard_assign`).

### Claude needs an API key

Automated Claude Code runs go through an explicit `ANTHROPIC_API_KEY` against Anthropic's official endpoint, not through a signed-in subscription. Without a key, a Claude assignment does not start: the node says why, and the lead hears it in its inbox. Set the key in the environment Crewboard's server starts in.

### Replacing a command

`CREWBOARD_CLAUDE_COMMAND`, `CREWBOARD_CODEX_COMMAND` and `CREWBOARD_DSH_COMMAND` point Crewboard at another binary (a wrapper, a pinned version).

## Result kinds

| Kind | The worker is told to |
| --- | --- |
| `local` | change files in the repository and not commit; you look at the changes |
| `branch` | work in its own Git worktree under `.crewboard/worktrees/` and commit there |
| `answer` | change nothing and answer in its result |
| `decision` | change nothing and give a decision with its reasons |

## How a worker hands back

A worker ends its last message with one of three blocks:

```text
<crewboard-report>what was done and how to check it</crewboard-report>

<crewboard-question>the question

- option one
- option two</crewboard-question>

<crewboard-split>
- [codex] A part of the work | criterion; criterion
- Another part (runs on the worker's own provider)
</crewboard-split>
```

A worker that forgets the format is not stuck: its whole last message counts as the result.

## Splitting work

With `<crewboard-split>`, a worker turns its task into up to 8 child assignments under itself. Crewboard closes their results for it, cancels a child whose run fails (with the reason), and resumes the worker once every child has finished, with their results in its context. The parts of `branch` work run in the worker's own copy. Questions from the parts go to the lead, because the worker is not running while it waits.

## When a run fails to start

A missing CLI, a missing key or a refused model fails the run at once. Crewboard records it, shows **Run failed: …** with the reason on the node, tells the lead, and does not retry on its own. The lead can clarify (which relaunches) or cancel.
