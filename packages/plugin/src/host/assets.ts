import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Route } from './dsh.js'

/** Directory of the built host bundle (lib/); the lazily loaded layout engine lib/elk.js sits next to it. */
export const HOST_LIB_DIR = fileURLToPath(new URL('.', import.meta.url))
export const ELK_ASSET_PATH = '/crewboard/assets/elk.js'
export const DXF_ASSET_PATH = '/crewboard/assets/preview-dxf.js'
export const STRUCTURED_ASSET_PATH = '/crewboard/assets/preview-structured.js'
export const VENDOR_ASSET_PREFIX = '/crewboard/assets/vendor/'
export const VENDOR_LIST_PATH = '/crewboard/assets/vendors.json'

/**
 * Vendor marks are the owner's own files: drop `<vendor>.svg` into `packages/plugin/assets/vendors/`
 * (deepseek.svg, claude.svg, codex.svg, devin.svg) and the screen uses them; with no file the node
 * keeps its two-letter mark. We ship none: those are other companies' trademarks, and which of them
 * may be used, and how, is the owner's call — not ours.
 */
const VENDOR_DIR = fileURLToPath(new URL('../assets/vendors/', import.meta.url))
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/

// dsh serves a plugin's declared client bundle only (combined /plugins/??…&rev= request), so any extra
// client file has to be served by the plugin host itself.
export function assetRoutes(libDir: string = HOST_LIB_DIR, vendorDir: string = VENDOR_DIR): Route[] {
  return [
    ...(['en', 'ru'] as const).map((lang): Route => ({
      kind: 'exact', path: `/crewboard/assets/dict-${lang}.js`,
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405).end(); return }
        const body = await readFile(join(libDir, `dict-${lang}.js`)).catch(() => undefined)
        if (!body) { res.writeHead(404).end(); return }
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(body)
      },
    })),
    ...(['review', 'welcome', 'settings', 'draft', 'ledger', 'trace', 'task'] as const).map((name): Route => ({
      kind: 'exact', path: `/crewboard/assets/screen-${name}.js`,
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405).end(); return }
        const body = await readFile(join(libDir, `screen-${name}.js`)).catch(() => undefined)
        if (!body) { res.writeHead(404).end(); return }
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(body)
      },
    })),
    {
      kind: 'exact', path: STRUCTURED_ASSET_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405).end(); return }
        const body = await readFile(join(libDir, 'preview-structured.js')).catch(() => undefined)
        if (!body) { res.writeHead(404).end(); return }
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'max-age=3600' })
        res.end(body)
      },
    },
    {
      kind: 'exact', path: DXF_ASSET_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405).end(); return }
        const body = await readFile(join(libDir, 'preview-dxf.js')).catch(() => undefined)
        if (!body) { res.writeHead(404).end(); return }
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'max-age=3600' })
        res.end(body)
      },
    },
    {
      kind: 'exact',
      path: ELK_ASSET_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('method not allowed')
          return
        }
        const body = await readFile(join(libDir, 'elk.js')).catch(() => undefined)
        if (!body) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('elk.js is not built')
          return
        }
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'max-age=3600' })
        res.end(body)
      },
    },
    {
      kind: 'exact',
      path: VENDOR_LIST_PATH,
      handler: async (_req, res) => {
        const names = await readdir(vendorDir).catch(() => [] as string[])
        const vendors = names.filter((name) => name.endsWith('.svg')).map((name) => name.slice(0, -4)).filter((name) => SAFE_NAME.test(name))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'max-age=60' })
        res.end(JSON.stringify({ vendors }))
      },
    },
    {
      kind: 'prefix',
      path: VENDOR_ASSET_PREFIX,
      handler: async (req, res) => {
        const file = (req.url ?? '').slice(VENDOR_ASSET_PREFIX.length).split('?')[0] ?? ''
        const name = file.endsWith('.svg') ? file.slice(0, -4) : file
        const body = SAFE_NAME.test(name) ? await readFile(join(vendorDir, `${name}.svg`)).catch(() => undefined) : undefined
        if (!body) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('vendor mark not found')
          return
        }
        res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'max-age=3600' })
        res.end(body)
      },
    },
  ]
}
