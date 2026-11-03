import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildAtomically } from '../../../scripts/atomic-output.mjs'

/** `import logo from './x.svg?raw'` as text, the same form Vite gives the tests. */
const rawSvg = {
  name: 'raw-svg',
  setup(builder) {
    builder.onResolve({ filter: /\.svg\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)), namespace: 'raw-svg' }))
    builder.onLoad({ filter: /.*/, namespace: 'raw-svg' }, async (args) => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }))
  },
}

// Same settings as the CLI build: identifiers kept for readable stacks, UTF-8 output. Bundled CommonJS
// dependencies of the MCP SDK call `require`, which an ESM bundle only has through createRequire.
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const common = {
  define: { __CREWBOARD_VERSION__: JSON.stringify(version) },
  bundle: true, platform: 'node', format: 'esm', target: 'node22.15', packages: 'bundle', minifyWhitespace: true, minifySyntax: true, charset: 'utf8', logLevel: 'warning',
  banner: { js: "import { createRequire as __crewboardRequire } from 'node:module'; const require = __crewboardRequire(import.meta.url);" },
}

await buildAtomically(fileURLToPath(new URL('../dist', import.meta.url)), async (dist) => {
  await build({ ...common, entryPoints: ['src/main.ts'], outfile: `${dist}/main.js` })
  // Core starts detached run supervisors from files next to its own module; bundled, that module is dist/.
  for (const [entry, out] of [
    ['../core/src/dsh/runner-main.ts', 'runner-main.js'],
    ['../core/src/runs/cli-runner-main.ts', 'cli-runner-main.js'],
  ]) await build({ ...common, entryPoints: [entry], outfile: `${dist}/${out}` })

  // The screen: one browser bundle with React inlined, served by the same server from dist/ui.
  await mkdir(`${dist}/ui`, { recursive: true })
  await build({ entryPoints: ['src/ui/main.tsx'], outfile: `${dist}/ui/app.js`, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', minify: true, charset: 'utf8', logLevel: 'warning', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [rawSvg] })
  for (const file of ['index.html', 'styles.css']) await copyFile(`src/ui/${file}`, `${dist}/ui/${file}`)
})
