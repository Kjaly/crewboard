import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildAtomically } from '../../../scripts/atomic-output.mjs'

// Whitespace and syntax only, identifiers kept: an unexpected error prints its stack, and names are what
// make it readable. No source maps — see the plugin build for why.
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'bundle', minifyWhitespace: true, minifySyntax: true, logLevel: 'warning' }

// dist/ is published as is and `orch` runs from it while this builds: the bundles go into a fresh
// directory swapped in whole, so no leftover of an older build ships and dist/ is never empty.
await buildAtomically(fileURLToPath(new URL('../dist', import.meta.url)), async (dist) => {
  await build({ ...common, entryPoints: ['src/main.ts'], outfile: `${dist}/main.js` })

  // Runs are supervised by detached runner processes that core starts from files next to its own
  // module (`new URL('./cli-runner-main.js', import.meta.url)`). Bundled into dist/main.js, that
  // module is dist/, so the runners must sit there too — without them every `orch run` dies at once.
  for (const [entry, out] of [
    ['../core/src/dsh/runner-main.ts', 'runner-main.js'],
    ['../core/src/runs/cli-runner-main.ts', 'cli-runner-main.js'],
  ]) await build({ ...common, entryPoints: [entry], outfile: `${dist}/${out}` })
})
