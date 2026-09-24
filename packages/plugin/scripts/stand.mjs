// A visual stand for the plugin, without dsh.
//
// Workers cannot start dsh (it wants a login token), and jsdom applies no CSS, so layout defects —
// container queries, popovers, wrapping — passed every test and reached the owner. The stand runs the
// REAL host (`lib/index.js`) against the owner's real repositories, serves the routes it registers
// with a plain HTTP server, and mounts the built client (`lib/client.js`) in a page that plays the
// shell: React from a CDN, the module loader, and the slots the client registers into.
//
//   node packages/plugin/scripts/stand.mjs [--port 4640] [--repo <root> ...]
//   open http://127.0.0.1:4640/            the orchestration screen
//   open http://127.0.0.1:4640/?screen=settings&lang=ru
//
// Nothing here writes on its own: the native dialogs answer «no», so accepting from the stand is
// refused exactly as a declined macOS confirmation would be.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'lib')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1]) || 4640
const repos = args.flatMap((a, i) => (a === '--repo' ? [args[i + 1]] : []))

const { apply } = await import(join(lib, 'index.js'))

const routes = []
const noop = () => () => {}
const ctx = {
  effect: (fn) => { fn() },
  inject: (names, fn) => fn({
    ...ctx,
    ...(names.includes('webServer') ? { webServer: { register: (r) => { routes.push(r); return () => {} } } } : {}),
  }),
  tools: { register: noop },
  systemPrompt: { section: noop },
}
const native = {
  confirm: async (_title, question) => { console.log(`[stand] confirm refused: ${question.split('\n')[0]}`); return false },
  notify: async () => {},
}
apply(ctx, { repos, refreshMs: 5000, notifications: false }, { native })

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>orchestra stand</title>
<style>html,body{margin:0;height:100%;background:#151517;color:#f9fafb;font:13px/1.4 system-ui,sans-serif}
#main{position:fixed;inset:0;display:flex}#main>*{flex:1;min-width:0}
#settings{max-width:900px;margin:24px auto;padding:0 16px}</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
</head><body><div id="main"></div><div id="settings"></div>
<script>
const params = new URLSearchParams(location.search)
const lang = params.get('lang') === 'ru' ? 'ru' : 'en'
const jsxRuntime = { jsx: (t, p, k) => React.createElement(t, k === undefined ? p : { ...p, key: k }), Fragment: React.Fragment }
jsxRuntime.jsxs = jsxRuntime.jsx
const modules = { react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': ReactDOM, 'react-dom/client': ReactDOM }
let plugin
window.__ModuleLoader__ = { load: ({ factory }) => { plugin = factory((name) => modules[name]) } }
</script>
<script src="/stand/client.js"></script>
<script>
const registered = {}
// Switch live from the console: standLocale('ru') — plays dsh's Language row.
let active = lang
const localeListeners = new Set()
const locale = { getSnapshot: () => ({ active }), subscribe: (fn) => { localeListeners.add(fn); return () => localeListeners.delete(fn) }, addLanguage: () => () => {} }
window.standLocale = (id) => { active = id; localeListeners.forEach((fn) => fn()) }
const slots = { inject: (_slot, fn) => fn(), register: (opts, Component) => { registered[opts.name] = Component; return () => {} } }
const ctx = {
  get: (name) => (name === 'slots' ? slots : undefined),
  inject: (names, fn) => fn({ locale, effect: () => {} }),
  on: () => {},
}
plugin.apply(ctx)
const screen = params.get('screen') === 'settings' ? 'settings.section' : 'main'
const target = document.getElementById(screen === 'main' ? 'main' : 'settings')
ReactDOM.createRoot(target).render(React.createElement(registered[screen]))
</script></body></html>`

const match = (url) => {
  const path = url.split('?')[0]
  return routes.find((r) => (r.kind === 'exact' ? r.path === path : path.startsWith(r.path)))
}

createServer(async (req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
    return
  }
  if (req.url.startsWith('/stand/client.js')) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(await readFile(join(lib, 'client.js')))
    return
  }
  const route = match(req.url)
  if (!route) { res.writeHead(404).end('no route'); return }
  try { await route.handler(req, res) } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)) }
}).listen(port, '127.0.0.1', () => console.log(`[stand] http://127.0.0.1:${port}/  (${routes.length} routes, repos: ${repos.join(', ') || 'dsh workspaces'})`))
