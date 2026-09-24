import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const src = fileURLToPath(new URL('../src', import.meta.url))

// The stylesheet ships in the always-loaded client bundle: a rule whose class no component renders any
// more is weight every dsh start pays for. Class families built at runtime (`orc-ev--${kind}`) count as
// used through their literal prefix.
it('keeps only stylesheet classes that some component renders', async () => {
  const styles = await readFile(join(src, 'client/styles.ts'), 'utf8')
  const css = /const CSS = `([\s\S]*?)`\n/.exec(styles)?.[1] ?? ''
  expect(css.length).toBeGreaterThan(1000)
  const files = (await readdir(src, { recursive: true })).filter((file) => /\.tsx?$/.test(file))
  const code = (await Promise.all(files.map((file) => readFile(join(src, file), 'utf8')))).join('\n').replace(css, '')
  const prefixes = [...code.matchAll(/(orc-[\w-]*)\$\{/g)].map((match) => match[1])
  const classes = new Set([...css.matchAll(/\.(orc-[\w-]+)/g)].map((match) => match[1]))
  const unused = [...classes].filter((name) => !new RegExp(`${name}(?![\\w-])`).test(code) && !prefixes.some((prefix) => name.startsWith(prefix)))
  expect(unused).toEqual([])
})
