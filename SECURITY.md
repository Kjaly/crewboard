# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's "Report a vulnerability" feature for this repository: https://github.com/Kjaly/crewboard/security/advisories/new

Include the affected version or commit, a description, steps to reproduce and the known impact. Please do not file public issues for unfixed vulnerabilities.

## Trust boundary

- The server listens on 127.0.0.1 only and has **no login of its own**. Any process on the machine that can reach the port can call the API and the lead's MCP tools, and so can start workers in any Git repository the user can read. Run it only on a machine you trust.
- The screen's write routes (answers, requests, emergency stop) accept only JSON requests from the server's own origin, so a web page on another site cannot post to them from the browser.
- Workers run with the permissions of the user who started the server, in the repository or in worktrees under `.crewboard/worktrees/`. What a worker does is bounded by its own CLI's sandbox and permission settings.
- Crewboard never reads, stores or forwards Claude credentials: it runs the official Claude Code binary as you, with your own sign-in. In the isolated mode (`CREWBOARD_CLAUDE_AUTH=isolated`) runs use an explicit `ANTHROPIC_API_KEY`, which never reaches journals or run records.
- The history tab reads Claude Code's transcripts under `~/.claude/projects` and never writes there.
