# Releasing

Crewboard is released as one npm package, `crewboard`, from `packages/crewboard`.

1. Make sure `main` is green: `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm release:check`.
2. Set the version in `packages/crewboard/package.json` and add the entry to `CHANGELOG.md`.
3. Commit, tag `v<version>` and push the tag. The release workflow verifies the tree again and publishes with npm trusted publishing; a version already on npm is skipped.

`pnpm release:check` packs the package and checks the tarball: the server and the worker runners, the screen, the readme and licence, and nothing from the sources. It then unpacks the tarball and runs `crewboard --help` and `crewboard doctor` from it, without this repository's `node_modules`, the way `npx` will.

The package's README is the repository's `README.md`, written into `packages/crewboard/README.md` before every pack and publish (`prepack`, `scripts/package-readme.mjs`) with its relative links made absolute, so npm shows what GitHub shows. The generated file is not kept in git; `release:check` fails if the packed README differs or keeps a relative link.

The tag workflow publishes only once npm trusted publishing is set up for the `crewboard` package (the package's settings on npmjs.com: repository `Kjaly/crewboard`, workflow `release.yml`). Without it, publish by hand from `packages/crewboard` after `pnpm build`: `npm publish --access public`, adding `--auth-type=web` when your second factor is a passkey or a security key (npm opens the browser to confirm), or `--otp=<code>` for an authenticator app. Push the tag after that; the workflow sees the version on npm and skips it.

1.1.0, the first version on npm, was published by hand on 2026-11-02; npm put a `0.0.0-stage` placeholder before it while it created the package.

After a release, check the published package the way a new user meets it:

```sh
npx crewboard@<version> --help
npx crewboard@<version> doctor
```

Publishing and pushing are maintainer steps; nothing in the repository does them on its own.
