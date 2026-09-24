# Workers

[Documentation](../README.md) · **English** | [Русский](../ru/workers.md)

A worker is a coding agent CLI that Crewboard launches for a task: Claude Code, Codex, Devin, or a dsh agent (for example DeepSeek). Workers from different providers can take tasks in the same plan. Work that is unsafe to hand to a worker — integration on a stand, starting processes, the owner's database — is a `root` task: the orchestrator does it itself, and Crewboard never launches a worker for it (see [the CLI reference](cli.md#the-orchestrators-own-work)).

![Settings: the worker registry, availability, and the order per task class](../assets/settings.png)

*Crewboard settings in dsh: registered workers, their access check, and the order for each task class.*

## Supported worker CLIs

| Kind | CLI | Checked before a run |
| --- | --- | --- |
| `claude` | Claude Code, `claude` | `claude --version`; `claude auth status` must report a login. For a model with a known minimum, the Claude Code version is compared with it (see [below](#cli-version-preflight)). |
| `codex` | Codex CLI, `codex` | `codex --version`; `codex login status` must report a login; the subscription quota must be under 90 % used when it can be read through `codex app-server`. |
| `devin` | Devin CLI, `devin` | `devin --version` must report a `3000.x` release; `devin auth status` must report a login. |
| `dsh` | dsh, `dsh` | `dsh --version`; `dsh --profile acp --dump-config` must succeed; a DeepSeek API key (`DEEPSEEK_API_KEY`) must be set in the environment, in dsh's credential store (**Settings → Models**), or in `$DSH_HOME/.env`. Only its presence is checked, never its value. |

Each worker needs its own CLI installed and signed in; Crewboard does not handle accounts or keys. Preflight runs the same binary the launch runs, including one set through `CREWBOARD_<KIND>_COMMAND`. The welcome screen marks a worker **ready** only after this check passed. Check a worker with:

```sh
crewboard preflight -a claude/opus
crewboard preflight            # every enabled profile
```

A successful check is cached for five minutes in `.orchestration/preflight-cache.json`; a failed one is checked again on the next run.

## The registry

`crewboard workers` prints the registry and the order per class. On first use the registry, `~/.config/crewboard/workers.json`, is created with these entries:

| Worker id | Model | Billing |
| --- | --- | --- |
| `dsh/deepseek-flash` | DeepSeek V4 Flash via dsh | API |
| `claude/opus`, `claude/fable` | Claude Opus 5, Claude Fable 5.1 | subscription |
| `codex/gpt-6-astra`, `codex/gpt-6-sol`, `codex/gpt-6-luna` | Codex GPT-6 models | subscription |
| `codex/gpt-5.6-sol`, `codex/gpt-5.6-terra`, `codex/gpt-5.6-luna` | Codex GPT-5.6 models | subscription |

Short aliases also work, for example `codex` for `codex/gpt-6-astra` and `claude-opus` for `claude/opus`. A `claude/<model>` or `codex/<model>` id works without registering it first, for example `-a claude/opus-5-5`. Devin is used as `devin`; its model comes from the Devin profile.

Add, change, or remove workers:

```sh
crewboard workers add claude/sonnet --kind claude --model sonnet --label "Claude Sonnet"
crewboard workers disable claude/sonnet --reason "no seat on this machine"
crewboard workers enable claude/sonnet
crewboard workers rm claude/sonnet
```

A **disabled** worker stays in the registry but is never launched on this machine, whether it is chosen automatically, assigned to a task, or named with `-a`.

Worker profiles (model, transport, display name, enabled flag), aliases, and the machine-wide order are in `~/.config/crewboard/profiles.json`. If that file does not exist, the first run copies `~/.config/dsh-orchestra/` or imports an older porch configuration (`~/.config/porch/config.json`, or the file named by `PORCH_CONFIG`) and leaves the source unchanged.

## Classes and the order

Every task has a class: `code`, `design`, `review`, or `research`. Set it with `--class`; without it, a `review` or `research` kind uses that class and everything else is `code`.

Each class has an ordered list of workers. The machine-wide order is the built-in **All workers** preset:

```sh
crewboard workers route review codex/gpt-6-sol,claude/opus
```

An empty list means tasks of that class do not start automatically.

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
3. **All workers** — the machine-wide order.

Disabled workers and unknown ids are removed from whichever preset applies. Deleting a preset returns every repository and plan that used it to **All workers**.

## How a worker is chosen

The preset is the owner's decision. Who may pick a worker depends on who is asking:

- **A person** — on the dsh screen, or in an interactive terminal — may assign any worker, even one outside the preset. Such a task shows a «hand-picked» mark.
- **An agent** — an orchestrating agent calling the CLI without a terminal, or a chat agent using the Crewboard tools — may only name a worker that the effective preset allows for the task's class. Anything else is refused (exit code 2) with the list of allowed workers. Agents should normally name no worker at all and let the preset decide; if another worker is really needed, they ask the person.

When a task starts (`crewboard run <task>` or Start on the screen):

1. **`-a <worker>`**, if given, re-assigns the task (subject to the rule above).
2. **The task's assigned worker**, if any. A person's assignment runs even outside the preset. An agent's assignment runs only while the current preset still allows it; after a preset change it falls back to the preset, with a note in the task feed.
3. **The preset**: the effective preset's list for the task's class, in order. The first worker that has a profile and passes preflight runs. The preset's pick is not saved as the task's worker.

A named worker is checked like an automatic one — disabled, missing profile, failed preflight — and the run is **refused** with the reason; it is never silently replaced. `crewboard task set <id> --worker auto` clears an assignment so the preset decides again.

Each run records the actual worker, model, provider and who chose it (preset, person or agent), so the ledger shows who did every attempt even after the assignment changes.

## CLI version preflight

Some models need a recent CLI. Crewboard knows that Claude Opus 5.5 (`opus-5-5`) needs Claude Code **2.1.280** or newer. A registry entry can declare its own floor with a `minCliVersion` field in `workers.json`.

When a floor applies, preflight compares it with `claude --version`. For example, with an older Claude Code:

```text
✗ claude/opus-5-5
   ✓ binary: 2.1.216 (Claude Code)
   ✗ version: Claude Code 2.1.216 is older than 2.1.280 required by opus-5-5 → update the CLI (claude update)
```

The floor is checked before every run and by `crewboard preflight -a <worker>`. `crewboard preflight` without `-a` checks every enabled profile but does not apply version floors.

## dsh workers

A dsh worker runs a dsh agent over ACP: `-a dsh` uses dsh's default, `-a dsh/<model>` a specific model, for example `dsh/deepseek-flash`. It needs a working `acp` profile in dsh. Its cost comes from dsh's own billing records; see [costs](costs.md). **Verify in your dsh** that `dsh --profile acp --dump-config` succeeds before relying on dsh workers.
