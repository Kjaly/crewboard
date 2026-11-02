# Releasing

Crewboard is released as one npm package, `crewboard`, from `packages/crewboard`.

1. Make sure `main` is green: `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm release:check`.
2. Set the version in `packages/crewboard/package.json` and add the entry to `CHANGELOG.md`.
3. Commit, tag `v<version>` and push the tag. The release workflow verifies the tree again and publishes with npm trusted publishing; a version already on npm is skipped.

`pnpm release:check` packs the package and checks the tarball: the server and the worker runners, the screen, the readme and licence, and nothing from the sources.

Publishing and pushing are maintainer steps; nothing in the repository does them on its own.
