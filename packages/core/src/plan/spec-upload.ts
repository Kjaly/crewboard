import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { CREWBOARD_DIR } from './store.js'

/** The draft pipeline reads a spec as UTF-8 text, so only text formats are accepted (no PDF). */
export const SPEC_EXTENSIONS = ['.md', '.markdown', '.txt', '.rst'] as const
/** Same ceiling the draft job applies when it reads a spec file. */
export const MAX_SPEC_BYTES = 256 * 1024
export const SPECS_DIR = `${CREWBOARD_DIR}/specs`

export class SpecUploadError extends Error {
  constructor(readonly code: 'unsupported_type' | 'too_large' | 'empty' | 'bad_name', message: string) {
    super(message)
    this.name = 'SpecUploadError'
  }
}

const CYRILLIC: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' }
const slugOf = (value: string) => [...value.toLowerCase()].map((char) => CYRILLIC[char] ?? char).join('').normalize('NFKD').replace(/\p{M}/gu, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '')

/**
 * Saves an uploaded or pasted spec as `.orchestration/specs/<date>-<slug>.<ext>` and returns its
 * repository-relative path. The name is only a label: any path part in it is refused, never followed.
 */
export async function saveUploadedSpec(root: string, input: { name?: string; text: string; now: Date }): Promise<string> {
  const name = input.name?.trim()
  if (name !== undefined && (!name || /[/\\\0]/.test(name) || name === '.' || name === '..')) throw new SpecUploadError('bad_name', 'The file name must not contain a path')
  const dot = name ? name.lastIndexOf('.') : -1
  const ext = name ? (dot > 0 ? name.slice(dot).toLowerCase() : '') : '.md'
  if (!(SPEC_EXTENSIONS as readonly string[]).includes(ext)) throw new SpecUploadError('unsupported_type', `Unsupported spec type: ${ext || 'none'}`)
  const bytes = Buffer.byteLength(input.text, 'utf8')
  if (bytes > MAX_SPEC_BYTES) throw new SpecUploadError('too_large', `The spec is ${bytes} bytes; the limit is ${MAX_SPEC_BYTES}`)
  if (!input.text.trim()) throw new SpecUploadError('empty', 'The spec is empty')
  const stem = name ? name.slice(0, dot) : input.text.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean) ?? ''
  const base = `${input.now.toISOString().slice(0, 10)}-${slugOf(stem) || 'spec'}`
  const dir = join(root, SPECS_DIR)
  await mkdir(dir, { recursive: true })
  // A symlinked `.orchestration` or `specs` must not carry the file outside the repository.
  const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)])
  const inside = relative(realRoot, realDir)
  if (!inside || inside.startsWith('..') || inside.split(sep)[0] !== CREWBOARD_DIR) throw new SpecUploadError('bad_name', 'The specs folder is outside the repository')
  for (let n = 1; n < 100; n++) {
    const file = `${base}${n > 1 ? `-${n}` : ''}${ext}`
    try {
      await writeFile(join(realDir, file), input.text, { flag: 'wx' })
      return `${SPECS_DIR}/${file}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new SpecUploadError('bad_name', 'Too many specs with this name today')
}
