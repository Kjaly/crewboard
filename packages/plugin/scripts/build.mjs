// Builds the dsh plugin: host half as a self-contained ESM bundle (core inlined, node builtins external),
// browser half as CJS wrapped in the dsh client module loader with React provided by the shell.
import { readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build, transform } from 'esbuild'
import { buildAtomically } from '../../../scripts/atomic-output.mjs'

// dsh loads the browser half by package name; the loader id must match it exactly.
const PACKAGE_NAME = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).name
const SHELL_MODULES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']
// Host and client carry the same id, so the screen can tell when dsh still runs an older host.
const BUILD_DEFINE = { __CREWBOARD_BUILD__: JSON.stringify(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`) }

/**
 * `minify: true` compresses the code around a template literal but never the CSS inside it, so the
 * stylesheet would ship with every comment and newline it is written with. Squeezing the source by
 * hand buys the same bytes and costs the comments that say why a rule exists — the build is where
 * that trade belongs. The literal is matched, not parsed: one `const CSS = \`…\`` per file, and a
 * file that stops matching fails the build loudly instead of silently shipping unminified.
 */
const minifyCssLiteral = {
  name: 'minify-css-literal',
  setup(build) {
    build.onLoad({ filter: /\/client\/styles\.ts$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8')
      const match = /const CSS = `([\s\S]*?)`\n/.exec(source)
      if (!match) throw new Error(`${args.path}: no \`const CSS = \`…\`\` literal to minify`)
      const { code } = await transform(match[1], { loader: 'css', minify: true })
      return { contents: source.replace(match[1], code.trim()), loader: 'ts' }
    })
  },
}

/**
 * Node halves (host, run supervisors) are minified without renaming: whitespace and syntax only. dsh
 * loads the host on every start, so the bytes matter, but a crash in a user's dsh is reported as a stack
 * trace, and with identifiers kept `at loadPlan (index.js:1:48213)` still says where it broke. Source
 * maps are not built: shipped they would double the tarball, and kept out of it they would describe a
 * build no user has. Full minification stays for the browser bundles, where nobody reads a stack.
 */
const NODE_MINIFY = { minifyWhitespace: true, minifySyntax: true }

// dsh loads lib/ while this builds: everything goes into a fresh directory swapped in whole, so lib/ is
// never empty or half-written and nothing from an older build survives.
await buildAtomically('lib', async (lib) => {
  await build({
    entryPoints: ['src/host/index.ts'],
    define: BUILD_DEFINE,
    outfile: `${lib}/index.js`,
    bundle: true,
    ...NODE_MINIFY,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    banner: { js: "import { createRequire as __orchCreateRequire } from 'node:module';\nconst require = __orchCreateRequire(import.meta.url);" },
    logLevel: 'warning',
  })

  // Detached run supervisors. The host bundle inlines core, and core spawns `node <dir of import.meta.url>/…-main.js`;
  // inside the bundle that directory is lib/, so the entries are built there as self-contained bundles.
  for (const [entry, out] of [
    ['../core/src/dsh/runner-main.ts', `${lib}/runner-main.js`],
    ['../core/src/runs/cli-runner-main.ts', `${lib}/cli-runner-main.js`],
  ]) {
    await build({
      entryPoints: [entry],
      outfile: out,
      bundle: true,
      ...NODE_MINIFY,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      banner: { js: "import { createRequire as __orchCreateRequire } from 'node:module';\nconst require = __orchCreateRequire(import.meta.url);" },
      logLevel: 'warning',
    })
  }

  await build({
    entryPoints: ['src/client/index.tsx'],
    define: BUILD_DEFINE,
    outfile: `${lib}/client.cjs`,
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    charset: 'utf8',
    jsx: 'automatic',
    external: SHELL_MODULES,
    // The screen is served as one file on every dsh load: minify it like the layout engine.
    minify: true,
    plugins: [minifyCssLiteral],
    logLevel: 'warning',
  })

  for (const lang of ['en', 'ru']) {
    await build({
      entryPoints: [`src/client/dict-${lang}-entry.ts`], outfile: `${lib}/dict-${lang}.js`,
      bundle: true, platform: 'browser', format: 'iife', target: 'es2022', minify: true, charset: 'utf8',
      logLevel: 'warning',
    })
  }

  // The layout engine is its own bundle: three megabytes of elkjs must never sit in the screen's
  // first byte. `lib/elk.js` publishes the constructor on `window.__orchElk` and is fetched on demand.
  await build({
    entryPoints: ['src/client/views/graph/elk-entry.ts'],
    outfile: `${lib}/elk.js`,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
    logLevel: 'warning',
  })

  await build({
    entryPoints: ['src/client/panel/preview-dxf-entry.ts'],
    outfile: `${lib}/preview-dxf.js`,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
    logLevel: 'warning',
  })

  await build({
    entryPoints: ['src/client/panel/preview-structured-entry.ts'],
    outfile: `${lib}/preview-structured.js`,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
    logLevel: 'warning',
  })

  // Screens are separate CJS bundles, executed by a script tag with the same shell require
  // that dsh gives the main client. Shared live modules retain one store and locale subscription.
  // Matching resolves the specifier to an absolute path: basename matching alone would mistake
  // `views/graph/layout.js` for the shell layout module.
  const sharedClientModules = new Map(
    ['i18n', 'store', 'layout', 'styles', 'attention'].map((name) => [`${resolve('src/client')}/${name}`, name]),
  )
  const sharedClientPlugin = {
    name: 'shared-client-modules',
    setup(build) {
      build.onResolve({ filter: /\.js$/ }, (args) => {
        const base = resolve(args.resolveDir, args.path).replace(/\.js$/, '')
        const name = sharedClientModules.get(base)
        if (name) return { path: `__orchShared/${name}`, external: true }
      })
    },
  }
  for (const name of ['review', 'welcome', 'settings', 'draft', 'ledger', 'trace', 'task']) {
    const outfile = `${lib}/screen-${name}.cjs`
    await build({
      entryPoints: [`src/client/screen-${name}-entry.ts`],
      outfile,
      bundle: true,
      platform: 'browser',
      format: 'cjs',
      target: 'es2022',
      charset: 'utf8',
      jsx: 'automatic',
      external: SHELL_MODULES,
      minify: true,
      plugins: [sharedClientPlugin, minifyCssLiteral],
      logLevel: 'warning',
    })
    const content = await readFile(outfile, 'utf8')
    await writeFile(`${lib}/screen-${name}.js`, `globalThis.__orchScreenBundles ??= {};\nglobalThis.__orchScreenBundles[${JSON.stringify(name)}] = (function(require) { var module = { exports: {} }; var exports = module.exports;\n${content}\nreturn module.exports; })(globalThis.__orchScreenRequire);\n`)
    await rm(outfile)
  }

  const body = await readFile(`${lib}/client.cjs`, 'utf8')
  await writeFile(
    `${lib}/client.js`,
    `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(PACKAGE_NAME)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${body}\n\t\treturn module.exports;\n\t}\n});\n`,
  )
  await rm(`${lib}/client.cjs`)
})
