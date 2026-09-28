# Release tarball size budget, re-measured 2026-09-28

Context: GitHub Actions run `36434571538` on `ed6feb0` passed install, build, types, all tests, i18n and lint, but failed `pnpm release:check`:

```
crewboard 217849 bytes (212.7 KiB)
Error: crewboard tarball is 217849 bytes; limit is 204800
```

`ed6feb0` has the same tree as this snapshot (`eac8eca`), so the failure reproduces here. `scripts/release-check.mjs` checks the CLI first, so the plugin tarball was never reached in that run; it is over its own ceiling too.

## Measurement

Real `pnpm pack` into isolated temp directories, after `pnpm build`, on the current macOS checkout (Node 24.16.0, pnpm 11.5.2):

```
pnpm --filter crewboard pack --pack-destination /tmp/.../cli
pnpm --filter dsh-crewboard pack --pack-destination /tmp/.../plugin
```

### `crewboard` — 217849 bytes = 212.7 KiB

| packed file | bytes | KiB | gzip -9 |
| --- | ---: | ---: | ---: |
| `dist/main.js` | 631951 | 617.1 | 178471 |
| `dist/dict-ru.js` | 69370 | 67.7 | 17949 |
| `dist/cli-runner-main.js` | 49902 | 48.7 | 14644 |
| `dist/runner-main.js` | 9751 | 9.5 | 3658 |
| `package.json`, `README.md`, `LICENSE` | 2845 | 2.8 | 1585 |

`dist/main.js` is ~82% of the compressed tarball by itself.

### `dsh-crewboard` — 926617 bytes = 904.9 KiB

| packed file | bytes | KiB | gzip -9 |
| --- | ---: | ---: | ---: |
| `lib/elk.js` (lazy layout engine) | 1460278 | 1426.1 | 439656 |
| `lib/index.js` (host, core inlined) | 703918 | 687.4 | 216830 |
| `lib/client.js` (always-loaded screen) | 355264 | 346.9 | 94510 |
| `lib/dict-ru.js` | 139005 | 135.7 | 33446 |
| `lib/screen-task.js` | 102776 | 100.4 | 27660 |
| `lib/dict-en.js` | 93876 | 91.7 | 26121 |
| `lib/screen-review.js` | 86864 | 84.8 | 25051 |
| `lib/cli-runner-main.js`, `lib/runner-main.js` | 59897 | 58.5 | 18412 |
| remaining `lib/screen-*.js`, previews, manifest, docs | 229239 | 223.9 | 49931 |

## What was checked before moving a ceiling

- Both tarballs contain exactly the expected files: no `src`, `test`, `node_modules`, `.env`, key or `*.pem` entries, and the CLI has no extra file beyond its four bundles plus manifest/README/LICENSE.
- The classic-zod guard and the CLI tree-shaking guard still hold: no `("Zod(String|Object|Type|Error)"` in any shipped bundle, `createExamplePlan` is absent from `dist/main.js`, and the Russian texts stay in `dist/dict-ru.js` rather than `dist/main.js`.
- The growth is feature content, not duplication or a stale build: `dist/` and `lib/` are swapped in whole by `buildAtomically`, and the per-bundle ceilings in `packages/cli/test/build.test.ts` and `packages/plugin/test/build.test.ts` were already raised for the 2026-09-28 merges (result attestation, API-only Claude policy, orchestrator usage) while `scripts/release-check.mjs` was last measured 2026-09-25. Every per-bundle guard holds at the current sizes:

| guard (build test) | measured | limit |
| --- | ---: | ---: |
| CLI `main.js` | 617.1 KiB | 618 |
| CLI `dict-ru.js` | 67.7 KiB | 69 |
| CLI `cli-runner-main.js` | 48.7 KiB | 50 |
| CLI `runner-main.js` | 9.5 KiB | 10 |
| plugin `index.js` | 687.4 KiB | 691 |
| plugin `client.js` | 346.9 KiB | 352 |
| plugin `cli-runner-main.js` | 48.9 KiB | 50 |
| plugin `runner-main.js` | 9.6 KiB | 10 |

## Decision

Only the two exceeded tarball ceilings are rebaselined to the measured size plus ~5% rounded up to whole KiB. No other budget moves, and the client ceiling stays at 352 KiB (measured 346.9 KiB, still under).

| package | measured 2026-09-28 | new ceiling | was |
| --- | ---: | ---: | ---: |
| `crewboard` | 212.7 KiB | 224 | 200 |
| `dsh-crewboard` | 904.9 KiB | 951 | 894 |

The expected file sets and the manifest, shebang, private-dependency and secret exclusions, the smoke installs and the canonical tests in `release:check` are unchanged.

## Scope

The sizes above are from a build on this macOS checkout; no Linux result is claimed. No npm publication or tag was made, and the plugin smoke install used a throwaway `DSH_HOME`, so no user dsh settings changed.
