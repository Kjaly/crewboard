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
| `effort` | the default effort level; an assignment or accepted handoff can override it. `crewboard_agents` lists accepted `efforts` (empty when the adapter takes none); omitting it uses the CLI default |
| `models` | suggested models as an array of `{ "id": "…", "label": "…", "note": "…" }`; `label` and `note` are optional. Each model may also set `"efforts": ["low", "medium", "high"]`; an empty list accepts no effort. Other model ids are still allowed |
| `label`, `color` | how the screen shows the agent |
| `icon` | a provider logo for the avatar: `claude`, `codex`, `deepseek`, `kimi`, `moonshot`, `qwen`, `zhipu`, `gemini`, `grok`, `cursor`, `devin`, `opencode`, `mistral`, `openai`, `xai` or `anthropic`; without it, the run and model choose the logo |
| `enabled` | `false` turns an agent off, built-in ones included |

An id is letters, digits, `.`, `-` or `_` (so a worker can name it in a split), and `lead` is reserved. An entry with the id of a built-in agent changes only the fields it names. The lead sees the list with `crewboard_agents` and hands work by `id`; a worker may split work onto any of them. A goal that used an agent you later removed still opens; new work for that agent is refused with the reason.

When queued work cannot start because the file is broken, the lead receives one event per goal with the registry path and error. The work stays queued and starts automatically after the file is fixed.

Assignment, handoff and launch checks use the selected model's `efforts` when declared, otherwise the adapter's levels. `crewboard_agents` and `/api/agents` include these model lists. Built-in `gpt-6.1-sol` excludes `none`. Omitting effort still uses the agent default, or the CLI default when the agent has none.

## Presets

The optional `presets` section in `~/.crewboard/agents.json` names reusable choices for the lead. Each entry is `{ "agent": "…", "model": "…", "effort": "…", "note": "…" }`; only `agent` is required. Names use the same characters as agent ids. An entry replaces the built-in preset with that name; `false` disables it.

| Built-in preset | Agent | Model | Effort | Use |
| --- | --- | --- | --- | --- |
| `cheap` | DeepSeek | agent default (`deepseek-flash` initially) | agent/CLI default | routine work |
| `normal` | Codex | `gpt-6.1-sol` | `medium` | everyday coding |
| `hard` | Codex | `gpt-6.1-sol` | `high` | difficult reasoning |
| `review` | Claude | `opus` | agent/CLI default | independent review |

```json
{
  "presets": {
    "cheap": false,
    "review": { "agent": "claude", "model": "opus", "note": "Check correctness and edge cases" },
    "quick": { "agent": "codex", "model": "gpt-6.1-sol", "effort": "low" }
  }
}
```

`crewboard_agents` returns `{ agents, presets }`: enabled agents with their capabilities, and enabled presets keyed by name. `crewboard_assign` accepts `preset` instead of `provider`; explicit `model` and `effort` override the preset. Missing preset fields inherit the agent's defaults. A disabled or unknown preset, or a preset pointing to a disabled agent, cannot be assigned. Settings never change a run's saved model/effort snapshot.

The [Settings tab](screen.md#settings) edits agent defaults and presets. `GET /api/agents-config` returns the raw configuration, its revision, all resolved agents (including disabled ones), presets and built-in preset defaults. `PUT /api/agents-config` takes `{ config, revision }`, validates with the same schema as disk reads, preserves model `efforts`, writes atomically and saves the exact previous file as `agents.json.bak`. A stale revision returns **409**. The screen reloads the file and asks you to apply your edits again. PUT requires same-origin JSON, like the screen's POST actions.

## Model catalog

The handoff model picker combines your `models` suggestions with a catalog from the worker's shell. It shows discovered models first, their source and, for OpenRouter, USD prices per million input/output tokens. Search appears above eight models; manual model entry is always available. A listed model is not a guarantee of account access or suitability for a coding worker.

| Worker | Catalog source |
| --- | --- |
| Codex | `codex debug models`, when supported and returning a JSON array or a `models`/`data` array of model IDs or objects (`id`, `slug` or `model`) |
| OpenCode | `opencode models`, normally one `provider/model` per line; JSON arrays are also accepted |
| dsh with an `openrouter/…` default model | Public `GET https://openrouter.ai/api/v1/models`; model IDs retain the `openrouter/` route prefix |
| Claude | Built-in aliases: `sonnet`, `opus`, `fable`, `haiku` |
| Other routes and shells | Registry suggestions only |

CLI discovery honours command overrides and stops waiting after 10 seconds. OpenRouter discovery has a 5-second limit, including the response body. It first requests the public list without credentials; only a 401/403 response may trigger a retry with `OPENROUTER_API_KEY` from the launch environment. Catalog discovery does not read saved credentials or log keys or source errors. An unavailable or unreadable source leaves suggestions usable and does not stop discovery for other agents.

Catalogs are cached for 10 minutes per agent. **Refresh** in the picker or `GET /api/models?agent=<id>&refresh=1` requests an update; `GET /api/models?agent=<id>` returns the full merged list. `/api/agents` and `crewboard_agents` include a compact `catalog` of at most 30 models per agent, discovered first. Registry edits merge immediately, including during the cache lifetime.

Each catalog model has `id`, `label`, `source` (`suggested` or `discovered`) and `discoveredAt` (an ISO timestamp, or `null` for a suggestion). Suggestions missing from a successfully read catalog have `status: "not_listed"`; this is informational and does not block manual selection. Failed or unsupported sources do not add that status. OpenRouter entries also include `pricing.prompt`/`pricing.completion` in USD per million tokens and `tools` when the response supplies those fields ([API reference](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)).

Set `CREWBOARD_NO_CATALOG=1` in Crewboard's launch environment to disable all external catalog commands and network calls. Registry suggestions and built-in Claude aliases remain available.

## Connect OpenRouter or your own API

Configure the endpoint and authentication in the worker's CLI, then register its model in `agents.json`. These recipes are checked against the linked upstream configuration references and Crewboard's adapters; they are not live API tests. Replace `MODEL_ID` everywhere with a full model ID from your provider, including any author prefix (for example, `author/model`). OpenRouter's base URL is `https://openrouter.ai/api/v1` ([quickstart](https://openrouter.ai/docs/quickstart)).

Two limits apply before you start:

- Crewboard rejects identified Anthropic/Claude models through third-party routes, including dsh and OpenCode. This is Crewboard's current [routing policy](https://github.com/Kjaly/crewboard/blob/main/packages/core/src/routing/anthropic-policy.ts), not an OpenRouter API restriction. Use the Claude worker for those models.
- The OpenRouter catalog can include models without tool support. Choose one with `tools` support in the [filtered catalog](https://openrouter.ai/models?supported_parameters=tools) and check tool calls with your CLI; being listed alone does not prove suitability for a coding worker ([tool-calling guide](https://openrouter.ai/docs/guides/features/tool-calling)).

### Through dsh

Crewboard starts `dsh --profile acp`. In that profile's `@deepseek-ai/dsh-llm-pi-ai` configuration, merge this provider into `providers` (normally in `$DSH_HOME/profiles/acp/cordis.patch.yml`; the default home is `~/.dsh`):

```yaml
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
        api: openai-completions
        baseURL: https://openrouter.ai/api/v1
        models:
          - id: MODEL_ID
```

Make `OPENROUTER_API_KEY` available in the environment of the process launching Crewboard. Then merge this entry into `~/.crewboard/agents.json` (or `$CREWBOARD_HOME/agents.json`):

```json
{
  "agents": {
    "router": { "label": "OpenRouter", "run": "dsh", "model": "openrouter/MODEL_ID" }
  }
}
```

For your own API, replace the route name `openrouter`, `baseURL`, key variable and model ID in both files. `openai-completions` selects Chat Completions; a Responses endpoint needs `openai-responses`. The `models` list replaces the route's catalog. Crewboard splits the model string at the first `/`, so `openrouter/author/model` selects route `openrouter`, model `author/model`. See the [dsh provider reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md) and [configuration guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md).

### Through OpenCode

Install OpenCode and merge the following into its global `~/.config/opencode/opencode.json` ([config reference](https://docs.opencode.ai/docs/config/)). `openrouter` is built in; `gateway` shows a custom Chat Completions provider:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openrouter": {
      "options": { "apiKey": "{env:OPENROUTER_API_KEY}" },
      "models": { "MODEL_ID": {} }
    },
    "gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://gateway.example/v1",
        "apiKey": "{env:GATEWAY_API_KEY}"
      },
      "models": { "MODEL_ID": { "name": "My model" } }
    }
  }
}
```

Keep the provider you need, replace the placeholders, and supply its key in Crewboard's launch environment. For a custom Responses endpoint use `@ai-sdk/openai` instead. Alternatively, run `/connect` in OpenCode, select OpenRouter and enter the key; omit `options.apiKey` when using that saved credential ([providers](https://docs.opencode.ai/docs/providers/)).

Register an OpenCode worker in Crewboard's `agents.json`:

```json
{
  "agents": {
    "router-opencode": { "run": "opencode", "model": "openrouter/MODEL_ID" },
    "gateway": { "run": "opencode", "model": "gateway/MODEL_ID" }
  }
}
```

`opencode models openrouter` lists configured models. For a live check, run `opencode run -m openrouter/MODEL_ID "Read the README and summarize this project"` in a test repository; this sends a paid request if the model is paid ([CLI reference](https://docs.opencode.ai/docs/cli/)).

### Codex: Responses API required

Codex custom providers go in user-level `~/.codex/config.toml`:

```toml
model_provider = "gateway"

[model_providers.gateway]
name = "My API"
base_url = "https://gateway.example/v1"
env_key = "GATEWAY_API_KEY"
wire_api = "responses"
```

Supply the key through the launch environment and register `"run": "codex", "model": "MODEL_ID"` in `agents.json`. Crewboard passes the model to Codex; the provider comes from Codex's configuration, not a provider prefix in the model string. The current Codex configuration only supports `wire_api = "responses"`: a Chat Completions-only server is insufficient. Check streaming, tool calls and session continuation against your gateway ([advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)).

### Where the key is stored

| Setup | Where the secret lives |
| --- | --- |
| dsh with `apiKeyEnv` | The example stores a reference in the profile and takes the secret from the launch environment. dsh can also resolve saved credentials; keys saved through its Models UI are written to `$DSH_HOME/.credentials.yaml` ([dsh guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)). |
| OpenCode with `{env:…}` | The example reads the secret from the launch environment; the config contains the variable reference. `/connect` and `opencode auth login` save credentials in `~/.local/share/opencode/auth.json` ([providers](https://docs.opencode.ai/docs/providers/), [CLI](https://docs.opencode.ai/docs/cli/)). |
| Codex with `env_key` | The example reads the named environment variable; TOML contains its name. Other authentication methods have their own credential storage ([authentication](https://learn.chatgpt.com/docs/auth?surface=cli)). |

If you put a key in a shell startup file or `.env`, it also lives in that file. Environment variables are inherited by child processes; they do not guarantee that a secret is never stored or exposed. Keep literal keys out of `agents.json`, prompts and version control.

## Result kinds

| Kind | The worker is told to |
| --- | --- |
| `local` | change files in the repository and not commit; you look at the changes |
| `branch` | work in its own Git worktree under `.crewboard/worktrees/` and commit there |
| `answer` | change nothing and answer in its result |
| `decision` | change nothing and give a decision with its reasons |

### dsh answers are not write-protected

For dsh agents, `answer` and `decision` are instructions in the prompt, **not a technical write prohibition**. `crewboard_agents` returns `readOnly: false` and `readOnlyReason: "dsh_unprotected"` for both built-in and registered dsh agents. Use an agent that advertises read-only support when the assignment must not change files. The existing dsh launch behavior is unchanged.

The following mechanisms were checked against core's ACP client, installed dsh CLI `0.1.5-rc.1` with base/workflow packages `0.1.5-rc.2`, and upstream documentation on 2026-11-03:

- [ACP permission requests](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md): Crewboard rejects every `session/request_permission`, including writes and commands that request approval. Ordinary allowed operations need not ask the client. ACP exposes neither session modes nor a sandbox configuration option.
- [Read-only sandbox policy](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/cordis.patch.yml): `DSH_PERMISSION_MODE=read-only` supplies a deployment default for filesystem and shell providers. [Saved permission presets](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/permission-presets/README.md) can replace it when a session starts. An environment variable alone cannot guarantee the effective mode.
- [The older workflow engine](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-rc.1/packages/workflow/workflow-worker-thread/README.md): the shipped worker-thread engine is not a security boundary; model scripts can reach Node filesystem APIs outside the shell sandbox. This was reproduced locally with read-only in the environment. Newer upstream [workflow-ptc](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow-ptc/README.md) describes sandboxed processes, but Crewboard does not yet pin or verify that composition.

A configuration overlay could pin the default and disable known unsafe tools in one version. Crewboard does not advertise that as protection across supported installations. Before enabling dsh read-only support, the adapter needs a verified minimum version and composition, an enforced session policy that saved settings cannot widen, and confinement of every model-controlled execution path (including workflows and descendants). dsh also needs to expose the effective policy and enforcement capability to the automation client, or provide an equivalent verifiable launch contract. Regression checks must cover direct file writes, shell commands and scripted tools, with failure when required confinement is unavailable.

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

Split parts inherit the parent’s actual model, effort, access and writable roots. Use `[agent]` for an agent’s defaults or `[preset:name]` for a lead preset; preset access cannot exceed the parent’s access. Unknown names are recorded in the journal and fall back to the parent.
