# Contributing

Thanks for helping improve Crewboard. Please follow the [code of conduct](CODE_OF_CONDUCT.md) in issues, reviews, and discussions. Bug reports and small, focused pull requests are the most useful contributions; for a larger change, open an issue first so we can agree on the approach.

## Set up

Use Node.js 24 or newer, pnpm 11.5.2, and Git. From a fresh checkout, install the dependencies recorded in `pnpm-lock.yaml`:

```sh
pnpm install --frozen-lockfile
pnpm build
```

The workspace has three packages:

| Package | Published as | Contents |
| --- | --- | --- |
| `packages/core` | not published; bundled into the CLI and the plugin | Plan engine, runs, routing, evidence, costs, worktrees. |
| `packages/cli` | [`crewboard`](https://www.npmjs.com/package/crewboard) (bins `crewboard` and `orch`) | Command-line interface. |
| `packages/plugin` | [`dsh-crewboard`](https://www.npmjs.com/package/dsh-crewboard) | dsh host plugin and browser screen. |

Run the source-tree CLI after a build:

```sh
node packages/cli/dist/main.js --help
```

The main checkout can be rebuilt while `orch`, its runs or dsh use it. The CLI and plugin builds write into a fresh directory next to `packages/cli/dist/` and `packages/plugin/lib/` and swap it in whole, so those directories always hold one complete build, old or new, and a failed build leaves the previous one in place. The swap uses `python3` to reach the kernel's directory exchange; without it the build warns and replaces the directory with two renames, which leaves it missing only for that instant. A build killed midway can leave a `.dist-next-*` or `.lib-next-*` directory behind; it is ignored by Git and safe to delete.

Running workers requires the corresponding worker CLI and account. The plugin requires a dsh installation.

## Checks

Run these from the repository root before submitting a change; CI runs the same set:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint:i18n
pnpm lint          # Biome, plus the documentation link check
pnpm release:check # packs both packages and inspects the tarballs
```

`pnpm lint` also runs `scripts/check-docs.mjs`: every relative link and image in the READMEs and `docs/` must resolve, and every guide in `docs/en/` needs a twin in `docs/ru/`. Screenshots that are listed but not captured yet are reported as pending; `node scripts/check-docs.mjs --strict` fails on them.

## Documentation

User documentation lives in [`docs/en/`](docs/en/getting-started.md) and [`docs/ru/`](docs/ru/getting-started.md) with matching file names, indexed in [docs/README.md](docs/README.md). English is the source text. When you change behaviour that a guide describes, update both languages in the same pull request; the Russian text should read naturally rather than word for word. Every command and flag in the docs must exist in the built CLI — check it with `node packages/cli/dist/main.js --help` and, where safe, by running it in a temporary repository.

Screenshots go to `docs/assets/<name>.png` and must be captured from a real dsh host with demo data; do not use generated or mocked images. Remove local paths, account names, and tokens before committing.

## Visual changes

For screen changes, run the real plugin host and built client in the stand:

```sh
pnpm --filter dsh-crewboard stand
```

Open `http://127.0.0.1:4640/` for the main screen or `http://127.0.0.1:4640/?screen=settings&lang=ru` for Russian settings. Stop the stand with Ctrl+C. It reads repositories from dsh workspaces; pass `-- --repo /absolute/path` to choose one. The stand uses a simulated shell and refuses native confirmation, so review interactions there cannot accept work. Check changes to dsh service integration or native dialogs in a live dsh as well, and say in the pull request what you could not check.

## Working on this repository with Crewboard

This repository manages many of its own changes with Crewboard. A person or an orchestrating agent writes a task contract with the desired result and checks, adds the task to a plan in `.orchestration/`, and runs a worker in a separate worktree. `crewboard wait` pauses supervision until a run finishes or a decision is needed. A person reviews the evidence and accepts, returns with a reason, or supersedes the task; agents do not make those decisions.

[Architecture](docs/architecture.md) explains the package boundaries, data flow, and dsh integration. Tests live next to each package under `test/`.

## Commits and pull requests

Use Conventional Commits with no scope: `feat: add graph navigation`, `fix: preserve review verdict`, `docs: explain worker routing`. Keep the subject imperative and describe the user-visible effect or reason. In the pull request, list the checks you ran and anything you could not verify, such as live dsh behaviour.
