import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? new URL('../src', import.meta.url).pathname)
const exempt = new Set(['client/dsh.ts', 'host/boundary.ts'])
const violations = []
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { await walk(path); continue }
    if (!/\.tsx?$/.test(entry.name) || exempt.has(relative(root, path))) continue
    const lines = (await readFile(path, 'utf8')).split('\n')
    let block = false
    lines.forEach((line, index) => {
      let code = ''
      for (let i = 0; i < line.length; i++) {
        if (block) { if (line.slice(i, i + 2) === '*/') { block = false; i++ } continue }
        if (line.slice(i, i + 2) === '/*') { block = true; i++; continue }
        if (line.slice(i, i + 2) === '//') break
        code += line[i]
      }
      if (/\bctx\s*\?*\.\s*(layout|locale|settings)\b/.test(code)) violations.push(`${relative(root, path)}:${index + 1}: direct service read`)
    })
  }
}
await walk(root)
if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1 }
