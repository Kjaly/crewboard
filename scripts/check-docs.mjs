import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Checks the public documentation: every relative link and image resolves, every `#anchor` into a
// Markdown file names a real heading, and each English guide in docs/en has a Russian twin in docs/ru.
// Screenshots are captured by hand from a live dsh host, so a listed shot that is not in the tree yet
// is reported as pending instead of failing; `--strict` (for a release) turns pending into an error.

const root = fileURLToPath(new URL('..', import.meta.url))
const strict = process.argv.includes('--strict')

/** The capture list from docs/notes/2026-09-24-release-research.md §5. */
export const SCREENSHOTS = ['hero-graph', 'work', 'review', 'sidebar-needs-you', 'task-panel', 'run-ledger', 'settings'].map((name) => `docs/assets/${name}.png`)

// Worker journals are local working notes and are not published.
const SKIP_DIRS = new Set(['docs/tmp'])

function markdownFiles() {
  const files = readdirSync(root).filter((name) => /^README(\.[a-z]+)?\.md$/.test(name) || name === 'CONTRIBUTING.md' || name === 'CHANGELOG.md')
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(rel)) walk(rel) }
      else if (entry.name.endsWith('.md')) files.push(rel)
    }
  }
  walk('docs')
  return files.sort()
}

/** Removes fenced blocks and inline code so example syntax is not read as a link. */
function prose(text) {
  return text.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '')
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
export function anchors(text) {
  const seen = new Map()
  const out = new Set()
  for (const match of prose(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    out.add(count ? `${base}-${count}` : base)
  }
  return out
}

export function links(text) {
  const out = []
  const body = prose(text)
  for (const match of body.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ target: match[1], image: match[0].startsWith('!') })
  for (const match of body.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) out.push({ target: match[1], image: true })
  return out
}

const errors = []
const pending = new Set()
const texts = new Map()
const read = (rel) => {
  if (!texts.has(rel)) texts.set(rel, readFileSync(path.join(root, rel), 'utf8'))
  return texts.get(rel)
}

for (const file of markdownFiles()) {
  for (const { target, image } of links(read(file))) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    const [rawPath, fragment] = target.split('#')
    const resolved = rawPath ? path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURI(rawPath))) : file
    if (resolved.startsWith('..')) { errors.push(`${file}: ${target} points outside the repository`); continue }
    if (!existsSync(path.join(root, resolved))) {
      if (image && SCREENSHOTS.includes(resolved)) pending.add(resolved)
      else errors.push(`${file}: ${target} does not exist`)
      continue
    }
    if (fragment && resolved.endsWith('.md') && statSync(path.join(root, resolved)).isFile() && !anchors(read(resolved)).has(fragment)) {
      errors.push(`${file}: ${target} has no heading #${fragment}`)
    }
  }
}

const guides = (lang) => existsSync(path.join(root, 'docs', lang)) ? readdirSync(path.join(root, 'docs', lang)).filter((name) => name.endsWith('.md')) : []
const en = new Set(guides('en'))
const ru = new Set(guides('ru'))
for (const name of en) if (!ru.has(name)) errors.push(`docs/en/${name} has no translation at docs/ru/${name}`)
for (const name of ru) if (!en.has(name)) errors.push(`docs/ru/${name} has no English source at docs/en/${name}`)

for (const shot of [...pending].sort()) {
  const line = `${shot} is referenced but not captured yet`
  if (strict) errors.push(line)
  else console.warn(`pending: ${line}`)
}
if (errors.length) {
  for (const line of errors) console.error(`✗ ${line}`)
  process.exit(1)
}
console.log(`docs: ${texts.size} files checked, ${en.size} guides in each language${pending.size ? `, ${pending.size} screenshots pending` : ''}`)
