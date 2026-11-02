# Workers

**English** | [Русский](../ru/workers.md)

Workers are the agents that do assignments. Crewboard runs each through its own command-line tool, reads what it does, and passes its questions and results to the lead.

## Built-in agents

| Agent | Runs as | Default model | Needs |
| --- | --- | --- | --- |
| Codex | `codex` CLI | `gpt-6.1-sol` | `codex login` |
| Claude | `claude` CLI | `sonnet` | your Claude Code sign-in |
| DeepSeek | `dsh`, DeepSeek Harness | `deepseek-flash` | `dsh` installed, DeepSeek key in its settings |

These three work without any setup file. The lead may name another model per assignment (`model` in `crewboard_assign`); [your agents](#your-agents) add more.

### How Claude signs in

A Claude worker is the official Claude Code binary running as you: with your own sign-in (a Claude subscription or an API key, whichever Claude Code uses when you run it yourself) and your settings, `CLAUDE.md`, skills and MCP servers. Crewboard never reads, stores or forwards your Claude credentials.

As checked on 2026-11-02, `claude -p` signed in with a Claude plan draws from the plan's limits ([Anthropic support](https://support.claude.com/en/articles/15036540)), and those limits assume ordinary, individual use ([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). Many parallel Claude workers all day may go beyond that, and Anthropic has paused, not cancelled, a change that would bill this usage separately.

`CREWBOARD_CLAUDE_AUTH=isolated` brings back the isolated route: `claude --bare` with an explicit `ANTHROPIC_API_KEY` against Anthropic's official endpoint, none of your settings, and a refusal with the reason when the key is missing or another credential is set.

### Replacing a command

`CREWBOARD_CLAUDE_COMMAND`, `CREWBOARD_CODEX_COMMAND` and `CREWBOARD_DSH_COMMAND` point Crewboard at another binary (a wrapper, a pinned version).

## Your agents

Any agent Crewboard's adapters can run joins with an entry in `~/.crewboard/agents.json` (or `$CREWBOARD_HOME/agents.json`). No rebuild, no restart: the file is read on every use.

```json
{
  "agents": {
    "kimi": { "label": "Kimi", "run": "dsh", "model": "moonshot/kimi-k3", "color": "#8b5cf6" },
    "glm": { "label": "GLM", "run": "opencode", "model": "zai/glm-5.2" },
    "codex": { "model": "gpt-6.1-terra" },
    "deepseek": { "enabled": false }
  }
}
```

| Field | Meaning |
| --- | --- |
| `run` | the adapter: `claude`, `codex`, `dsh`, `opencode`, `cursor`, `gemini`, `grok` or `devin` |
| `model` | the default model; for `dsh`, `<route>/<model>` picks a route of your dsh profile |
| `label`, `color` | how the screen shows the agent |
| `enabled` | `false` turns an agent off, built-in ones included |

An id is letters, digits, `.`, `-` or `_` (so a worker can name it in a split), and `lead` is reserved. An entry with the id of a built-in agent changes only the fields it names. The lead sees the list with `crewboard_agents` and hands work by `id`; a worker may split work onto any of them. A goal that used an agent you later removed still opens; new work for that agent is refused with the reason.

A broken file is reported with its path when work starts, and the lead hears why.

### Models by API, through dsh

A model reached by API (Kimi, GLM, Qwen and others) needs a harness that gives it tools; Crewboard uses dsh for that. Crewboard starts dsh with its `acp` profile, so describe the route there: the profile's `@deepseek-ai/dsh-llm-pi-ai` settings take a `providers` map with the endpoint, the API protocol, the environment variable that holds the key, and the models. See that package's README in your dsh profile for every field. For example, a route named `moonshot`:

```yaml
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      moonshot:
        apiKeyEnv: MOONSHOT_API_KEY
        api: openai-completions
        baseURL: https://api.moonshot.ai/v1
        models:
          - id: kimi-k3
```

Take the endpoint and the model id from your provider's documentation. Then `"model": "moonshot/kimi-k3"` in `agents.json` reaches it. The key stays in your environment; neither dsh's settings nor Crewboard store it.

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

With `<crewboard-split>`, a worker turns its task into up to 8 child assignments under itself. A child's result goes to the worker, not to the lead, and the child shows **Reported** until the lead closes the parent; that close covers every part under it. Crewboard cancels a child whose run fails (with the reason) and resumes the worker once every child has reported or finished, with their results in its context. The parts of `branch` work run in the worker's own copy. Questions from the parts go to the lead, because the worker is not running while it waits.

## When a run fails to start

A missing CLI, a missing key or a refused model fails the run at once. Crewboard records it, shows **Run failed: …** with the reason on the node, tells the lead, and does not retry on its own. The lead can clarify (which relaunches) or cancel.
