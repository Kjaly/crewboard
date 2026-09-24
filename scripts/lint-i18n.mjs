import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
// Exact file paths keep new files visible.
export const exemptions = new Set([
  // The Russian worker protocol is deliberately preserved verbatim.
  'packages/plugin/src/host/prompt.ts',
])
const cyrillic = /[\u0400-\u04ff]/u
/**
 * Comments are not interface. A rule in the stylesheet may well be explained in Russian, and the
 * guard has no business there — it hunts text a reader sees on screen. Strings survive the strip,
 * so a hardcoded label still trips it.
 */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walk(absolute))
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(absolute)
  }
  return files
}

export async function scanI18n(base = root, allowed = exemptions) {
  const violations = []
  const checked = []
  for (const area of ['client', 'host']) {
    const dir = path.join(base, 'packages/plugin/src', area)
    let files = []
    try { files = await walk(dir) } catch { continue }
    for (const file of files) {
      const relative = path.relative(base, file).split(path.sep).join('/')
      if (relative === 'packages/plugin/src/client/dict/en.ts' || relative === 'packages/plugin/src/client/dict/ru.ts' || relative === 'packages/plugin/src/host/i18n.ts') continue
      const text = withoutComments(await readFile(file, 'utf8'))
      if (!cyrillic.test(text)) continue
      if (allowed.has(relative)) continue
      checked.push(relative)
      violations.push(relative)
    }
  }
  return { violations, checked }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootArg = process.argv.indexOf('--root')
  const base = rootArg >= 0 ? path.resolve(process.argv[rootArg + 1]) : root
  const allowed = new Set([...exemptions, ...process.argv.flatMap((arg, index) => arg === '--allow' ? [process.argv[index + 1]] : [])])
  const { violations } = await scanI18n(base, allowed)
  if (violations.length) {
    console.error(`i18n guard: hardcoded Cyrillic found in ${violations.length} file(s):\n${violations.map((f) => `  ${f}`).join('\n')}`)
    process.exitCode = 1
  } else {
    console.log(`i18n guard: passed; ${exemptions.size} explicit protocol exemption remains:\n${[...exemptions].map((f) => `  ${f}`).join('\n')}`)
  }
}
