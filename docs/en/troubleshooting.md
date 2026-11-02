# Troubleshooting

**English** | [Русский](../ru/troubleshooting.md)

## The screen says "No connection to the server"

The server stopped. Start it again with `crewboard serve`; the screen reconnects by itself and reloads.

## The port is taken

`crewboard serve --port 4710`. Connect the lead to the same port: `claude mcp add --transport http crewboard http://127.0.0.1:4710/mcp`, and the lead's wait uses `--port 4710`.

## Claude Code does not see the tools

Check `claude mcp list` shows `crewboard`, and that the server runs. After restarting the server, Claude Code reconnects on its next call; if it does not, restart the chat.

## A Claude assignment says "Run failed: … anthropic_api_key_missing"

Automated Claude runs need `ANTHROPIC_API_KEY` in the server's environment. See [workers](workers.md#claude-needs-an-api-key).

## A Codex assignment fails with «model not supported»

The account cannot use that model. Ask the lead to pass another `model`, or check `codex` works on its own.

## History says "The full conversation is unavailable"

Crewboard looks for transcripts in `~/.claude/projects`, in the folders for the repository and its subfolders, and shows the chats that called Crewboard for this goal. It finds nothing when the lead was not Claude Code, ran in a folder outside the repository, or the transcripts were removed. `CREWBOARD_CLAUDE_PROJECTS` points it at another transcripts folder.

## The lead shows as away while it is working

The lead counts as present while it calls Crewboard or waits with `crewboard wait`. A lead that thinks for a long time without either shows **lead is offline** after 10 minutes; the next call fixes it.

## A goal is Paused

Its lead has been silent for a day. Open a chat in the repository and ask it to take the goal over; it calls `crewboard_adopt_goal`.

## `crewboard wait` exits with 1

The server is not running on that port, or the path is not inside a Git repository. The message says which.
