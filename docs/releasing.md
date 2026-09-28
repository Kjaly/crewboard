# Releasing Crewboard packages

Releases are published from `.github/workflows/release.yml` when a `v*` tag is pushed. The workflow runs the repository quality gates and `pnpm release:check`, then publishes `crewboard` and `dsh-crewboard` from their package directories. Package publication uses GitHub Actions OIDC trusted publishing and npm provenance.

## One-time npm setup

A trusted publisher is configured in the settings of a package that already exists on npm, so the first version is published by hand; the workflow publishes every later tag. The workflow skips a package whose version is already on npm, so tagging the hand-published version still runs the checks and does not fail.

First release, from a clean checkout of the tagged commit:

1. `pnpm install --frozen-lockfile && pnpm release:check` — it builds and packs both packages and checks the tarballs.
2. `npm login` with the npm account that will own the packages (two-factor authentication on).
3. `npm publish packages/cli/<crewboard tarball> --access public` and `npm publish packages/plugin/<dsh-crewboard tarball> --access public` (the paths `release:check` printed).

Then, for **each** package:

1. Create or claim the package on npm under the intended owner and grant the release maintainers access.
2. In npm package settings, configure a trusted publisher for GitHub Actions with repository owner `Kjaly`, repository `crewboard`, and workflow filename `release.yml`.
3. Confirm the package is public and that the trusted publisher is enabled. Do not create or add a long-lived npm automation token to GitHub secrets.
4. After the first tagged release, verify the package page, provenance/attestation, version, and installed tarball.

A maintainer can release by updating both package versions together, merging the change, creating a matching `v*` tag, and pushing that tag. Never tag until the matching commit has passed CI.

## Before the first public release

- Set the date of the `0.4.0` entry in [CHANGELOG.md](../CHANGELOG.md) to the tag date. Its introduction already says that the public history starts at this snapshot and that 0.1.0 and 0.2.0 were internal.
- Capture the screenshots listed in `scripts/check-docs.mjs` into `docs/assets/` from a live dsh host with demo data, then run `node scripts/check-docs.mjs --strict`. `pnpm lint` only reports missing screenshots as pending.
- In a disposable dsh profile, install the packed plugin and confirm the steps marked "verify in your dsh" in [plugin setup](en/plugin-setup.md): the sidebar entry, the `repos` setting location, and the native confirmation dialog.
- Enable GitHub private vulnerability reporting, which [SECURITY.md](../SECURITY.md) names as the reporting channel, and test it.

## Repository description and topics (proposal)

These are proposals for the GitHub repository settings of `Kjaly/crewboard`; the owner applies them by hand.

- **Description:** "See your coding agents at work, across projects: plans, runs, costs, and human review for AI coding workers."
- **Website:** `https://www.npmjs.com/package/crewboard`
- **Topics:** `ai-coding-agents`, `agent-orchestration`, `coding-agents`, `developer-tools`, `git-worktrees`, `deepseek-harness`, `cli`, `typescript`. Add a topic only if the released code matches it.
- **Social preview:** a 1280×640 crop of the real graph and sidebar with the product name; no invented numbers.
- **Release notes for v0.4.0:** one sentence of user value, install commands for both packages, three to five capabilities from the changelog, prerequisites (Node.js 24+, Git, dsh for the screen), known limits (macOS-only native confirmation, some CLI messages Russian only), and the migration note for `orch` and `~/.config/dsh-orchestra/`.
