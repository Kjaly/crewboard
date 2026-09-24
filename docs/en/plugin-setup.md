# Plugin setup

[Documentation](../README.md) · **English** | [Русский](../ru/plugin-setup.md)

The `dsh-crewboard` package adds the Crewboard screen, settings, notifications, and `orchestra_*` tools to [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh`). The CLI does not need it; install it when you want the visual board.

Steps marked **verify in your dsh** depend on your dsh version and profile; I could not check them against every installation.

## Requirements

- Node.js 24 or newer.
- dsh with a `web` profile. The plugin's browser half is built for the web client.
- The repositories you want to see, as absolute paths.

## Install

`dsh plugin` forwards its arguments to pnpm inside the profile directory, so installing the plugin is a package install into that profile:

```sh
dsh plugin --profile web add dsh-crewboard
```

Restart the profile (`dsh web`) and open **Orchestration** in the sidebar. **Verify in your dsh** that the entry appears; if it does not, see [troubleshooting](troubleshooting.md#the-screen-does-not-appear-in-dsh).

To update later:

```sh
dsh plugin --profile web update dsh-crewboard
```

## Connect repositories

The plugin shows repositories from three sources, merged and de-duplicated:

1. **The Crewboard repository list**, `~/.config/crewboard/repos.json`. This is the one you usually use, and the only one Crewboard writes:
   - on the screen, press **+** next to **Repositories** and paste an absolute folder path (`~/src/app` works too). The folder must be a Git repository or worktree and not listed yet; it appears at once, and a folder without a plan opens on the welcome screen;
   - in a terminal, `crewboard init` and `crewboard plan new` add the repository they run in, and `crewboard repo add [path]` adds one by hand (see [CLI: repositories on the screen](cli.md#repositories-on-the-screen)).
2. **dsh workspaces**: repositories open in dsh appear on their own.
3. **The plugin's `repos` setting** — a list of absolute paths in the `crewboard` plugin row of your dsh profile configuration (**verify in your dsh** where your profile keeps plugin settings) — and the `CREWBOARD_REPOS` environment variable, absolute paths separated by `:`, read when dsh starts:

   ```sh
   CREWBOARD_REPOS="$HOME/src/api:$HOME/src/web" dsh web
   ```

   Relative paths are ignored. `ORCH_REPOS` is still read as an older name for the same variable.

All three are read again on every refresh, so a repository added in any of them appears without restarting dsh.

**Worktrees.** For every listed repository the plugin also shows the plans in its Git worktrees (`git worktree list`): a checkout that holds `.orchestration/` appears under its repository with a **worktree** mark. Crewboard's own task copies (`<repo>-orch-<task>`) are never shown as separate plans.

**One folder, one row.** Paths are compared after symlinks resolve, so `/tmp/app` and `/private/tmp/app` on macOS, or a path with a trailing slash, are the same folder in every list. The row keeps the spelling it was first listed under.

**The repository row menu** («…» or right-click) has **New plan…** — type the goal and press Enter — and **Remove from list**. Removing forgets the folder in the Crewboard list only: files, plans, and worktrees are not touched. A dsh workspace or a `repos` path cannot be removed there; the menu item is disabled and says where to remove it. A listed folder that no longer exists stays in the tree marked **missing** until you remove it.

Other settings in the same row:

| Setting | Default | Meaning |
| --- | --- | --- |
| `repos` | `[]` | Absolute repository paths. |
| `refreshMs` | `30000` | How often snapshots are refreshed, in milliseconds; at least `5000`. File changes are also watched. |
| `notifications` | `true` | Notifications when work needs you. |

If you used the plugin under its older id `dsh-orchestra`, its `repos` list is still read as a fallback.

## What the plugin needs from dsh

- The screen, notifications, chat tools, and background supervision run only while the dsh host is running. The CLI works on the same plans without it.
- The plugin reaches dsh services through injection. If an optional service is missing in your dsh version, only the related feature is unavailable; the screen keeps working.
- Accept, send back, and supersede on the screen ask for a native macOS confirmation dialog. **Verify in your dsh** that the dialog appears before you rely on the screen for decisions; the CLI's interactive confirmation is always available.
- The screen follows dsh's language switch. Russian is added to dsh's language list if it is missing.

## First look

Open **Orchestration**. With no plan in the repository, the welcome screen offers an example plan, a plan draft from a specification, and worker setup. With a plan, you get the [Graph, Work, and Review views](getting-started.md#the-screen).

Settings are under **Crewboard** in dsh settings: workers and their access checks, the order per task class, presets, notifications, and worktree cleanup. The CLI and the screen read the same files in `~/.config/crewboard/`, so a change in one is visible in the other.
