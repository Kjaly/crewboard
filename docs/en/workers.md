# Workers

[Documentation](../README.md) · **English** | [Русский](../ru/workers.md)

A worker is a coding agent CLI that Crewboard launches for a task: Claude Code, Codex, Devin, or a dsh agent (for example DeepSeek). Workers from different providers can take tasks in the same plan. Work that is unsafe to hand to a worker — integration on a stand, starting processes, the owner's database — is a `root` task: the orchestrator does it itself, and Crewboard never launches a worker for it (see [the CLI reference](cli.md#the-orchestrators-own-work)).

### Who commits a worker's changes

By default, a worker commits on its task branch before reporting. For Codex in a linked Git worktree, Crewboard grants its sandbox write access to that repository's Git metadata and to the shared check-slot directory, so `git commit` and `crewboard slot` can work. A contract that assigns commits to the orchestrator must contain a line `<commit_owner>orchestrator</commit_owner>`. In that mode Crewboard tells the worker to leave the worktree intact, does not ask for a worker commit, and sends a reported result to the orchestrator's check even when files remain uncommitted. The orchestrator checks, fixes if needed, and commits in the same task worktree before `verify --done`; routine checked work can be accepted and merged by the orchestrator; merging still requires a clean copy.

For a run marked incomplete with preserved changes because a worker commit was expected, or because the answer's result line was not recognized, `crewboard verify <id> --takeover --note "reason"` transfers its copy to the orchestrator's **checking** state without relaunching the worker. The run itself remains incomplete. The orchestrator reviews and commits the work in that copy, runs the required checks on the commit, then uses `crewboard verify <id> --done --note "…" --report <file>` with a positive report. Automatic acceptance still requires the same clean commit and green checks. A run without preserved changes or evidence cannot use this command.

![Settings: the worker registry, availability, and the order per task class](../assets/settings.png)

*Crewboard settings in dsh: registered workers, their access check, and the order for each task class.*

## Claude automation, subscriptions, and account safety

Crewboard adopts a conservative **API-only policy for automated Claude workers**. Subscription or unknown authorization is blocked; it must not silently become a paid API run. This is a product policy, not a claim that Anthropic bans every subscription CLI workflow. The [Agent SDK support update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says the announced billing changes are paused.

**Implemented guard:** policy revision anthropic-api-only-2026-09-28. Update Crewboard to activate it. The initial supported route is official Claude Code 2.1.281 or newer with bare capability, explicit ANTHROPIC_API_KEY and the direct Anthropic API endpoint. Unknown credential/header/routing overrides are refused. Other commercial methods can be unsupported by this adapter without violating Anthropic terms. API key presence alone does not prove validity or balance.

Use Crewboard's redacted preflight reason to choose a supported channel or another worker. Do not paste keys, tokens, cookies or account identifiers into reports. Existing copies and history are preserved; interactive Claude Code outside Crewboard is unaffected. API charges, CLI estimates and subscription quota remain separate.

See the [dated source record and implementation limitations](../notes/2026-09-28-anthropic-automation-policy.md). The reported account restriction has no established cause; no account-access guarantee is made.

## Supported worker CLIs

| Kind | CLI | Checked before a run |
| --- | --- | --- |
| `claude` | Claude Code, `claude` | API-only policy, version/bare capability and explicit API-key environment; subscription login is not used. For a model with a known minimum, the Claude Code version is compared with it (see [below](#cli-version-preflight)). |
| `codex` | Codex CLI, `codex` | `codex --version`; `codex login status` must report a login; the subscription quota must be under 90 % used when it can be read through `codex app-server`. |
| `devin` | Devin CLI, `devin` | `devin --version` must report a `3000.x` release; `devin auth status` must report a login. |
| `opencode` | OpenCode, `opencode` | `opencode --version`; `opencode auth list` must show the provider of the model (`<provider>/<model>`) connected. |
| `cursor` | Cursor Agent, `cursor-agent` | `cursor-agent --version`; `cursor-agent status` must not report «Not logged in». |
| `gemini` | Gemini CLI, `gemini` | `gemini --version`. Gemini CLI has no auth-status command, so the check reads its credential stores (`GEMINI_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_APPLICATION_CREDENTIALS`, `~/.gemini/.env`, `security.auth.selectedType` in `~/.gemini/settings.json`, `~/.gemini/oauth_creds.json`, the gcloud ADC file) and reports what was found. A miss only warns — a sign-in held only in the OS keychain cannot be read, and an unsigned run reports the auth error itself. Not verified on an installed CLI. |
| `grok` | Grok CLI, `grok` | `grok version`; `grok models` must succeed — listing the account's models needs a login (both commands per docs.x.ai/build/cli/reference). The CLI is not installed on the development machine — this check is verified against fakes only. |
| `dsh` | dsh, `dsh` | `dsh --version`; `dsh --profile acp --dump-config` must succeed. For a model of dsh's DeepSeek route, a DeepSeek API key (`DEEPSEEK_API_KEY`) must be set in the environment, in dsh's credential store (**Settings → Models**), or in `$DSH_HOME/.env`; only its presence is checked, never its value. Another provider's key is dsh's alone and is not checked. An Anthropic model routed through dsh is refused by the API-only Claude policy (below), not launched. |

Each worker needs its own CLI installed and signed in; Crewboard does not handle accounts or keys. Preflight runs the same binary the launch runs, including one set through `CREWBOARD_<KIND>_COMMAND` (`CREWBOARD_CURSOR_COMMAND` overrides the `cursor-agent` binary name). The welcome screen marks a worker **ready** only after this check passed. Check a worker with:

```sh
crewboard preflight -a claude/opus
crewboard preflight            # every enabled profile
```

A successful check is cached for five minutes in `.orchestration/preflight-cache.json`; a failed one is checked again on the next run.

## The registry

`crewboard workers` prints the workers in [three sections](#the-workers-screen-three-sections) and the order per class. On first use the registry, `~/.config/crewboard/workers.json`, is created with these entries:

| Worker id | Model | Billing |
| --- | --- | --- |
| `dsh/deepseek-flash` | DeepSeek V4 Flash via dsh | API |
| `claude/opus`, `claude/fable` | Claude Opus 5, Claude Fable 5.1 | API (Claude API key) |
| `codex/gpt-6-astra`, `codex/gpt-6.1-sol`, `codex/gpt-6-sol`, `codex/gpt-6-luna` | Codex GPT-6 models | subscription |
| `codex/gpt-5.6-sol`, `codex/gpt-5.6-terra`, `codex/gpt-5.6-luna` | Codex GPT-5.6 models | subscription |

Short aliases also work, for example `codex` for `codex/gpt-6-astra` and `claude-opus` for `claude/opus`. A `claude/<model>` or `codex/<model>` id works without registering it first, for example `-a claude/opus-5-5`. Devin is used as `devin`, with the model of the Devin profile, or as `devin/<model>` once added for one model (see [below](#subscriptions-add-models)). Models that dsh serves are not stored in the registry at all: see [models from dsh](#models-from-dsh).

Add, change, or remove workers:

```sh
crewboard workers add claude/sonnet --kind claude --model sonnet --label "Claude Sonnet"
crewboard workers disable claude/sonnet --reason "no seat on this machine"
crewboard workers enable claude/sonnet
crewboard workers rm claude/sonnet
```

A **disabled** worker stays in the registry but is never launched on this machine, whether it is chosen automatically, assigned to a task, or named with `-a`.

## The Workers screen: three sections

**Settings → Crewboard → Workers** lists every worker exactly once, in one of three sections. The section follows the transport a worker runs on — never its id. Billing follows the transport too, with one exception: automated Claude Code runs are API-only, so the Claude block still sits under the legacy **Subscriptions** heading while its billing reads **API**. The three sections are **Subscriptions** (a signed-in CLI: Codex, Devin and the other subscription CLIs), **Via dsh (API)**, and **Other / imported**.

1. **Subscriptions** — one block per CLI: Claude, Codex and Devin always, and any other subscription CLI an older tool's profile runs on (OpenCode, Cursor Agent, Gemini CLI, Grok CLI) once one of its workers is in use. The block shows the CLI's status — **signed in**, **sign-in needed** or **not installed** — from a local check that runs when the screen opens and again on **Check access**, the sign-in command, and **Add models** once signed in. A CLI that is not signed in or not installed shows no model table, only its status and the action. A model registered at several efforts is **one row** with an effort chip per effort; each chip is still its own worker, with its own **Used in** and its own **Enabled** switch. Every CLI this block knows has a runner — OpenCode, Cursor Agent, Gemini CLI and Grok CLI run tasks like the other three. Should a CLI ever be listed without a runner, its block says «Crewboard does not run tasks on X yet — models listed for reference», its models get no **Enabled** switch, and no picker offers them — a list that still names one marks it «does not run on this machine».
2. **Via dsh (API)** — the models of dsh's catalog, grouped by dsh provider ([models from dsh](#models-from-dsh)), under «Keys and models live in dsh.» and **Open dsh settings**. A model dsh no longer lists shows **Blocked in dsh**, and its switch is disabled. With no models: «No models yet. Configure them in dsh → Settings → Models.», and the built-in `dsh/deepseek-flash` route shows as one line, «The built-in DeepSeek V4 Flash route is waiting for a key in dsh.», not as a blocked row; the built-in preset skips it at launch until dsh lists the model. The id stays, so older plans and presets that name it keep working.
3. **Other / imported · N** — folded by default, with «Picked up automatically from your CLIs or dsh. Not required — safe to leave collapsed.» N is the number of its entries:
   - **duplicates**: workers that run the same transport, model and effort as another one, whatever their ids — `claude-code` and `claude-sonnet`, both «Claude Sonnet 5 · high». The copy that stays in its section is the registered one, else one not imported, else one a list names. Choose the one to keep under **Keep one**, then **Remove the rest**; the others leave every list that names them.
   - **imported**: an older tool's profile (`origin: porch-import`) that no list names. **Add as worker** makes it your own — it moves to its CLI's section, and the default preset may pick it — or **Remove** deletes it.
   - **stale ids**: an id a class, a preset or a switch names but nothing on this machine defines, such as `codex-reserve`. **Remove** takes it out of the routing, its switches and every saved preset.

The switch column is **Enabled**: whether the orchestrator may use the worker. **Used in** lists compact chips, «routing · code #2» or «Claude · review #1»; a chip opens that preset with its class in view. A preset entry that points to a switched-off, blocked or unknown worker, or to one whose CLI is not signed in, stays in the list, marked **not available on this machine**, and links back to the worker's row.

Every provider block — each CLI under **Subscriptions** and each dsh provider under **Via dsh (API)** — folds to one line: its name, its status, «N models · M in presets» and its main action (**Check access**, or **Add models** once signed in); a click on the line opens it. A provider whose models the routing or a preset uses starts open, the others folded, and the choice you make for a provider is remembered in this browser. **Expand all** / **Fold all** sit at the head of each section.

`crewboard workers` prints the same three groups, one summary line per provider, followed by the order per class; `crewboard workers --all` lists every model under its provider, a model's efforts on one line.

## Subscriptions: add models

Claude, Codex, Devin, OpenCode, Cursor Agent, Gemini CLI and Grok CLI run on the person's own subscription or account: each CLI is signed in on the machine (`claude auth login`, `codex login`, `devin auth login`, `opencode auth login`, `cursor-agent login`, `grok login`; Gemini CLI signs in inside `gemini` — *Sign in with Google* — or through `GEMINI_API_KEY`, it has no login subcommand), and Crewboard never handles the account. Automated Claude runs are the exception: they do not use a subscription sign-in but require an explicit `ANTHROPIC_API_KEY` against the official Anthropic endpoint (see [Claude automation](#claude-automation-subscriptions-and-account-safety)); the Claude block's `claude auth login` is for interactive use outside Crewboard. In the settings, each of them has a block under **Subscriptions** with **Check access**; once the check says the CLI is signed in, **Add models** lists the models that CLI offers. Tick the models and, where the CLI takes one, the efforts: Crewboard adds one worker per model and effort — the same workers `crewboard workers add … --effort` makes — without editing a file. A worker id that already exists is left as it is, so a name you changed survives.

Where the list comes from:

| CLI | Model list |
| --- | --- |
| Codex | `codex debug models --bundled`: the catalog shipped with the installed Codex, read offline; the efforts each model takes come with it. |
| Devin | `devin models list --format json`: the models of the signed-in account. Devin takes no effort, so each model is one worker, `devin/<model>`. |
| Claude | Claude Code has no command that lists models, so Crewboard lists the current ones: `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5`, `claude-haiku-4-5`. Any other model still works through `crewboard workers add`. |
| OpenCode | `opencode models`: one `<provider>/<model>` id per line. |
| Cursor Agent | `cursor-agent --list-models`: the models of the signed-in account. |
| Gemini CLI | No listing command is verified on an installed CLI (none installed here), so Crewboard lists the documented `--model` aliases — `auto` (the CLI's default), `pro`, `flash`, `flash-lite`; a concrete version like `gemini-3-pro-preview` also works through `crewboard workers add`. |
| Grok CLI | `grok models` is documented but its output is unverified on an installed CLI, so Crewboard lists `grok-4.7`; any other model works through `crewboard workers add`. |

The same from the CLI:

```sh
crewboard workers models codex
crewboard workers models opencode
crewboard workers add-models claude --models claude-sonnet-5,claude-opus-5-5 --effort high,medium
crewboard workers add-models devin --models swe-2-high
crewboard workers add-models opencode --models deepseek/deepseek-flash --effort high
```

The ids follow `<kind>/<model>[-<effort>]`, with Claude's `claude-` prefix dropped: `claude/sonnet-5-high`, `codex/gpt-6-astra-medium`, `devin/swe-2-high`, `opencode/deepseek/deepseek-flash-high`. An OpenCode model id keeps its `<provider>/<model>` form inside the worker id.

## How the CLIs run (rb1)

OpenCode, Cursor Agent and Grok CLI are driven like Codex: one process per turn, and a queued or interrupting direction continues the session (OpenCode `--session`, Cursor Agent `--resume`) or — for Grok, which has no verified resume flag — starts a fresh one-shot turn. Gemini CLI is deliberately driven one-shot: each turn is a `gemini --output-format json` whose prompt goes on stdin (a piped, non-TTY stdin selects headless mode upstream — the documented `cat file | gemini` shape), and a direction always waits for the running turn to finish. Its `stream-json` mode exists per docs but is unused — one object at exit is the smallest contract to keep honest on a CLI nobody here can run. Adding another CLI of either shape is a row in the runner's table plus its stream parser, not a new backend.

- OpenCode: `opencode run --pure --format json --auto --agent build|plan -m <provider>/<model> [--variant <effort>] [--session <id>] --dir <cwd>` — verified live against 1.18.30.
- Cursor Agent: `cursor-agent --print --output-format stream-json --stream-partial-output --force|--mode plan [--model <model>] [--resume <chatId>]` — verified live against 2026.01.23 `--help`; a real signed-in run was not possible on the development machine (no login), so the stream shape is covered by fakes.
- Grok CLI: `grok --output-format streaming-json --verbatim --always-approve|--sandbox read-only -m <model> [--reasoning-effort <effort>] --prompt-file <file>` — verified against the older tool's adapter (probed on Grok Build 0.2.112) and fakes only; the CLI is not installed here.
- Gemini CLI: `gemini --output-format json --approval-mode yolo|plan -e none --allowed-mcp-server-names "" [--model <model>]` with the prompt on stdin — verified against current CLI docs and upstream source only; not installed here. Its `plan` mode is docs-verified, so a draft (which must not write) gets a throwaway worktree instead of trusting the flag.

## Models from dsh

Every model available by API comes from dsh: dsh holds the providers and their keys, and Crewboard only names a provider and a model. The settings list every model configured in dsh's **Settings → Models** as a worker «<Model> · via dsh», grouped by dsh provider. The list follows dsh's configuration: a provider or model added or removed there appears or disappears in Crewboard's settings without a restart. Crewboard never reads or stores a key.

A dsh model's worker id is `dsh/<provider>/<model>`, for example `dsh/deepseek-official/deepseek-v4-pro` or `dsh/openrouter/qwen/qwen-4`; the model part may itself contain `/`. It needs no registering: switch it on or off, route it, put it in presets, or name it with `-a` like any worker. The older `dsh/<model>` stays an alias for a model of dsh's DeepSeek route (`deepseek-official`): `dsh/deepseek-flash` is the same worker as `dsh/deepseek-official/deepseek-flash` and is listed once, under the old id, so routes, presets and plans that name it keep working.

A model removed from dsh is not dropped from routes or presets. If one of them still names it, the settings keep its row and mark it **Blocked in dsh**, with its switch disabled; its runs fail with dsh's error until the model is back in dsh or you remove it from the lists. A provider that failed to list its models is named under the list, and its models are not marked missing.

dsh's model catalog reaches Crewboard through the dsh host (its session controller). The CLI does not have it: `crewboard workers` prints only the dsh workers that are saved or named in a list, under **Via dsh (API)**, and claims nothing about models dsh no longer lists; `-a dsh/<provider>/<model>` works in the CLI all the same.

Worker profiles (model, transport, display name, effort, enabled flag), aliases, and the machine-wide order are in `~/.config/crewboard/profiles.json`. If that file does not exist, the first run copies `~/.config/dsh-orchestra/` or imports an older porch configuration (`~/.config/porch/config.json`, or the file named by `PORCH_CONFIG`) and leaves the source unchanged.

## Effort

A worker can carry an **effort**: how hard its model thinks. Crewboard passes it to the CLI on every run of that worker:

| Kind | How it reaches the CLI | Accepted levels |
| --- | --- | --- |
| `claude` | `claude --effort <level>` | `low`, `medium`, `high`, `xhigh`, `max` |
| `codex` | `codex exec -c model_reasoning_effort="<level>"` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `persistent` (the models decide which of these they honour) |
| `opencode` | `opencode run --variant <level>` | `minimal`, `low`, `medium`, `high`, `max` — the common set; variants are provider-specific, so a provider may take more |
| `grok` | `grok --reasoning-effort <level>` | `low`, `medium`, `high` (docs-verified, not installed here) |
| `devin`, `dsh`, `cursor`, `gemini` | not passed: these CLIs take no effort flag | — |

A worker without an effort runs at the CLI's default, including Codex's `model_reasoning_effort` in `~/.codex/config.toml`. An effort the CLI does not accept is refused before the run, with the levels it takes:

```text
✗ effort: Claude Code does not accept effort “minimal”; it takes low, medium, high, xhigh, max
```

To use one model at several efforts, register it once per effort. Each is a separate worker with its own id, and routes, presets and assignments treat it like any other worker:

```sh
crewboard workers add claude/sonnet-5-high --kind claude --model claude-sonnet-5 --label "Claude Sonnet 5" --effort high
crewboard workers add claude/sonnet-5-medium --kind claude --model claude-sonnet-5 --label "Claude Sonnet 5" --effort medium
crewboard presets add sonnet --label "Sonnet by class" \
  --code claude/sonnet-5-medium --design claude/sonnet-5-high --review claude/sonnet-5-high --research claude/sonnet-5-medium
```

Wherever workers are listed — `crewboard workers`, the settings, preset pickers and the task panel's worker line — the effort follows the name: «Claude Sonnet 5 · high». Each run records the effort it was launched with next to its model, so the cost and review screens show which effort ran. A Devin or dsh worker registered with an effort shows no effort, since none reaches its run.

## Classes and the order

Every task has a class: `code`, `design`, `review`, or `research`. Set it with `--class`; without it, a `review` or `research` kind uses that class and everything else is `code`.

Each class has an ordered list of workers. The machine-wide order is the built-in preset, **Default: workers that pass checks**:

```sh
crewboard workers route review codex/gpt-6-sol,claude/opus
```

The built-in preset tries the class's list first and then every other worker in the registry: the first one that passes its preflight check runs. So a machine with only Codex signed in still starts `code` tasks, and an agent may name any installed worker under this preset. A worker that was passed over is named in the `crewboard run` output and in the task's feed, for example `claude/opus skipped: not logged in → codex/gpt-6-luna`. A saved preset is exactly its lists: an empty list there means tasks of that class do not start automatically.

## Presets

A preset is a named order for all four classes. Use one to say, for example, "this repository uses only subscription workers":

```sh
crewboard presets add subs --label "Subscriptions" \
  --code claude/opus,codex --design codex/gpt-6-sol --review codex --research claude/fable
crewboard repo preset subs       # for this repository
crewboard plan preset subs       # for the current plan only
crewboard plan preset --clear    # the plan follows the repository again
crewboard presets list           # effective preset and where it comes from
```

The effective preset is chosen in this order:

1. the plan's preset;
2. the repository's preset (`.orchestration/preset.json`);
3. **Default: workers that pass checks** — the machine-wide order, then every other installed worker.

Disabled workers and unknown ids are removed from whichever preset applies. Deleting a preset returns every repository and plan that used it to the default preset.

## How a worker is chosen

The preset is the owner's decision. Who may pick a worker depends on who is asking:

- **A person** — on the dsh screen, or in an interactive terminal — may assign any worker, even one outside the preset. Such a task shows a «hand-picked» mark.
- **An agent** — an orchestrating agent calling the CLI without a terminal, or a chat agent using the Crewboard tools — may only name a worker that the effective preset allows for the task's class. Anything else is refused (exit code 2) with the list of allowed workers. Agents should normally name no worker at all and let the preset decide; if another worker is really needed, they ask the person.

When a task starts (`crewboard run <task>` or Start on the screen):

1. **`-a <worker>`**, if given, re-assigns the task (subject to the rule above).
2. **The task's assigned worker**, if any. A person's assignment runs even outside the preset. An agent's assignment runs only while the current preset still allows it; after a preset change it falls back to the preset, with a note in the task feed.
3. **The preset**: the effective preset's list for the task's class, in order. The first worker that has a profile and passes preflight runs. The preset's pick is not saved as the task's worker.

A named worker is checked like an automatic one — disabled, missing profile, failed preflight — and the run is **refused** with the reason; it is never silently replaced. `crewboard task set <id> --worker auto` clears an assignment so the preset decides again.

Each run records the actual worker, model, effort, provider and who chose it (preset, person or agent), so the ledger shows who did every attempt even after the assignment changes.

## CLI version preflight

Some models need a recent CLI. Claude Opus 5.5 (`opus-5-5`) declares a floor of Claude Code **2.1.280**, and every automated Claude run also needs the API-only bare mode, so the effective floor is **2.1.281** — the higher of the two applies. A registry entry can declare its own floor with a `minCliVersion` field in `workers.json`.

When a floor applies, preflight compares it with `claude --version`. For example, with an older Claude Code:

```text
✗ claude/opus-5-5
   ✓ binary: 2.1.216 (Claude Code)
   ✗ version: Claude Code 2.1.216 is older than 2.1.281 required by opus-5-5 → update the CLI (claude update)
```

An automated run additionally requires `--bare` support and the API-key policy from [Claude automation](#claude-automation-subscriptions-and-account-safety). The floor is checked before every run and by `crewboard preflight -a <worker>`. `crewboard preflight` without `-a` checks every enabled profile but does not apply version floors.

## dsh workers

A dsh worker runs a dsh agent over ACP: `-a dsh` uses dsh's default, `-a dsh/<provider>/<model>` a model of any provider dsh has (see [models from dsh](#models-from-dsh)), and `-a dsh/<model>` a model of dsh's DeepSeek route, for example `dsh/deepseek-flash`. The run selects that provider and model in a `dsh --profile acp` process, which reads the same providers as the dsh screen. It needs a working `acp` profile in dsh. Its cost comes from dsh's own billing records; see [costs](costs.md). **Verify in your dsh** that `dsh --profile acp --dump-config` succeeds before relying on dsh workers.
