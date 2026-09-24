import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('rejects direct ctx service reads, including optional chaining, but permits props', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-boundary-'))
  try {
    await mkdir(join(root, 'client'))
    const file = join(root, 'client', 'screen.tsx')
    const lint = (text: string) => {
      return writeFile(file, text).then(() => {
        try { execFileSync('node', ['scripts/lint-dsh-boundary.mjs', root], { cwd: process.cwd(), stdio: 'pipe' }); return true }
        catch { return false }
      })
    }
    expect(await lint('const title = props.locale; const panel = session.layout')).toBe(true)
    expect(await lint('const face = ctx?.locale;')).toBe(false)
    expect(await lint('const face = ctx.layout;')).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
