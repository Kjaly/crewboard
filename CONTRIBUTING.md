# Contributing

Thanks for helping improve Crewboard. Please follow the [code of conduct](CODE_OF_CONDUCT.md). Bug reports and small, focused pull requests are the most useful contributions; for a larger change, open an issue first so we can agree on the approach.

## Set up

Node.js 22.15 or newer, pnpm 11.5.2 and Git:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/crewboard/dist/main.js serve
```

| Package | Contents |
| --- | --- |
| `packages/crewboard` | the product: server, journal, supervisor, MCP tools, screen |
| `packages/core` | private, bundled: worker backends and run supervisors, event normalising, cost readers |

[Architecture](docs/architecture.md) explains how they fit together.

## Checks

Run these before submitting; CI runs the same set:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint          # Biome, plus the documentation check
pnpm release:check # packs crewboard and inspects the tarball
```

Tests are few and about behaviour: a new branch of behaviour is a row in an existing `it.each` table; fakes stand in at the boundary (a worker backend, time), not for internals. The screen is tested with Testing Library by role and visible text.

## Trying the screen

`node packages/crewboard/dist/main.js serve` with `CREWBOARD_HOME` and `CREWBOARD_CLAUDE_PROJECTS` pointing at temporary folders keeps your real data out. `scripts/seed-demo.mjs` fills a temporary repository with a demo goal in every state, without running any worker.

## Documentation

User guides live in [`docs/en/`](docs/en/getting-started.md) and [`docs/ru/`](docs/ru/getting-started.md) with matching file names. English is the source; the Russian text reads naturally rather than word for word. Every command and flag in the docs must exist in the built `crewboard`.

The same guides are published as a site with VitePress (`docs/.vitepress/`); a push to `main` deploys it to GitHub Pages. Preview it locally:

```sh
pnpm docs:dev
```

Screenshots and walkthroughs come from the live app on demo data in both languages, never mock-ups. After a visible change, rebuild and capture them again (needs Playwright with Chromium, and ffmpeg):

```sh
pnpm build
node scripts/capture-media.mjs
```

The screen's strings live in `packages/crewboard/src/ui/i18n/`: one dictionary per language, the same shape in each.

## Commits and pull requests

Conventional Commits without a scope: `feat: …`, `fix: …`, `docs: …`. In the pull request, list the checks you ran and anything you could not verify.
