# Troubleshooting

**English** | [Русский](../ru/troubleshooting.md)

## The screen says "No connection to the server"

The server stopped. Start it again with `crewboard serve`; the screen reconnects by itself and reloads.

## The port is taken

`crewboard serve` says `port 4700 is in use` and exits. Another Crewboard may already be running: open http://127.0.0.1:4700/. Otherwise start on another port, `crewboard serve --port 4710`. Connect the lead to the same port: `claude mcp add --scope user --transport http crewboard http://127.0.0.1:4710/mcp`, and the lead's wait uses `--port 4710`.

## A worker is not ready

`crewboard doctor` shows, for each worker, the first check that failed and what to do: install the CLI, update it, sign in. The empty screen shows the same list.

## The lead does not see the tools

Check that the server runs and that your lead's client lists `crewboard`: `claude mcp list` in Claude Code, `codex mcp list` in Codex, the profile entry in dsh. After restarting the server, the lead reconnects on its next call; if it does not, restart the chat. In Claude Code, a server added without `--scope user` exists only in the folder where it was added: add it again with `crewboard connect claude` (it uses the user scope).

## A Claude assignment says "Run failed: … anthropic_api_key_missing"

This happens only with `CREWBOARD_CLAUDE_AUTH=isolated`: that route needs `ANTHROPIC_API_KEY` in the server's environment. Without the variable, Claude uses your own Claude Code sign-in. See [workers](workers.md#how-claude-signs-in).

## A Codex assignment fails with «model not supported»

The account cannot use that model. Ask the lead to pass another `model`, or check `codex` works on its own.

## History shows the course of the work, not the conversation

Crewboard reads the lead's transcripts from `~/.claude/projects` (Claude Code), `~/.codex/sessions` (Codex) and `~/.dsh/sessions` (dsh), for chats that ran in the repository or its subfolders and called Crewboard for this goal. It finds none when the lead is another client, ran in a folder outside the repository, or the transcripts were removed; then the tab shows the course of the work from Crewboard's journal. `CREWBOARD_CLAUDE_PROJECTS`, `CREWBOARD_CODEX_SESSIONS` and `CREWBOARD_DSH_SESSIONS` point it at other folders.

## The lead shows as away while it is working

The lead counts as present while it calls Crewboard or waits with `crewboard wait`. A lead that thinks for a long time without either shows **lead is offline** after 10 minutes; the next call fixes it.

## A goal is Paused

Its lead has been silent for a day. Open a chat in the repository and ask it to take the goal over; it calls `crewboard_adopt_goal`.

## `crewboard wait` exits with 1

The server is not running on that port, or the path is not inside a Git repository. The message says which.
