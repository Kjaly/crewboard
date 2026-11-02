# Getting started

**English** | [Русский](../ru/getting-started.md)

This guide takes you from a fresh checkout to a first goal that a worker finishes.

## 1. Install and start the server

You need Node.js 24 or newer, pnpm 11.5.2 and Git.

```sh
git clone https://github.com/Kjaly/crewboard.git
cd crewboard
pnpm install --frozen-lockfile
pnpm build
node packages/crewboard/dist/main.js serve
```

The server prints its address:

```text
crewboard http://127.0.0.1:4700  mcp: http://127.0.0.1:4700/mcp
```

`--port` picks another port. The server listens on 127.0.0.1 only.

To call it `crewboard` in this shell session, define a function with the checkout's absolute path. The rest of the docs write `crewboard`.

```sh
CREWBOARD_MAIN="$PWD/packages/crewboard/dist/main.js"
crewboard() { node "$CREWBOARD_MAIN" "$@"; }
```

## 2. Open the screen

Open http://127.0.0.1:4700/. With no goals yet, the screen shows the command that connects Claude Code, with a copy button.

## 3. Connect Claude Code as the lead

```sh
claude mcp add --transport http crewboard http://127.0.0.1:4700/mcp
```

Claude Code now has Crewboard's tools and reads its instructions on how to lead. You do not need to explain the protocol to it.

## 4. Set up at least one worker

Codex is the quickest: install the `codex` CLI and run `codex login`. Claude needs `ANTHROPIC_API_KEY`; DeepSeek needs `dsh` with a DeepSeek key. See [workers](workers.md).

## 5. Start your first goal

Open Claude Code inside one of your Git repositories and describe what you want, for example:

> Add a Usage section to the README. Ask Codex to draft it.

The lead asks what it needs, agrees on the criteria with you, starts a goal and assigns the work. On the screen the goal appears in the sidebar under your repository, and the tree shows the assignment with what the worker is doing right now.

The lead keeps `crewboard wait` running in the background, so it wakes up when a worker asks something or finishes. When the worker reports, the lead checks the result against the criteria and closes it; the node turns to **Done**.

## 6. If a worker asks you

When the lead cannot answer a worker's question itself, it raises it to you. **Waiting for you** in the header lights up; open it, pick an option or write your answer. The worker continues with it, and the lead hears your answer too.

## Where things are kept

- Each repository's goals live in `<repo>/.crewboard/` (ignored by Git through its own `.gitignore`).
- The list of known repositories is `~/.crewboard/projects.json`; `CREWBOARD_HOME` moves it.
- The history tab reads Claude Code's own transcripts from `~/.claude/projects` and never writes there.

Next: [the lead](lead.md) and [the screen](screen.md).
