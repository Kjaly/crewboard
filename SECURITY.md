# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's
“Report a vulnerability” feature for this repository:
https://github.com/Kjaly/crewboard/security/advisories/new

Include the affected version or commit, a description of the issue, steps to
reproduce it, and any known impact. Please avoid filing public issues for
unfixed vulnerabilities. Private vulnerability reporting through GitHub is the reporting channel.

## Trust boundary

The plugin's HTTP routes rely on authentication provided by DeepSeek Harness;
the plugin does not provide an independent authentication layer for those
routes. Acceptance of orchestration actions is confirmed through a native
macOS dialog. These controls define the intended trust boundary and should not
be treated as protection against a compromised or misconfigured host.
