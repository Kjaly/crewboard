import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

// dsh imports the plugin module by the `name` in its bundle patch; a name that differs from the
// package name makes the whole dsh boot fail with ERR_MODULE_NOT_FOUND (rename to Crewboard).
it('names the npm package in the bundle patch so dsh can import it', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; dsh?: { bundle?: { patch?: string } } }
  const patchPath = pkg.dsh?.bundle?.patch
  expect(patchPath).toBeTruthy()
  const patch = await readFile(new URL(`../${patchPath}`, import.meta.url), 'utf8')
  const names = [...patch.matchAll(/^\s+name:\s*(\S+)\s*$/gm)].map((m) => m[1])
  expect(names).toEqual([pkg.name])
})

it('registers the browser half under the package name', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const ids = [...client.matchAll(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1])
  expect(ids).toEqual([pkg.name])
})
