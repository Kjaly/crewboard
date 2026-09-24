import { mkdir, mkdtemp, readdir, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_SPEC_BYTES, saveUploadedSpec } from '../src/plan/spec-upload.js'

const now = new Date('2026-09-24T10:00:00Z')
const repo = () => mkdtemp(join(tmpdir(), 'spec-upload-'))

describe('saveUploadedSpec', () => {
  it('saves into .orchestration/specs/<date>-<slug>.<ext> and never overwrites', async () => {
    const root = await repo()
    expect(await saveUploadedSpec(root, { name: 'Onboarding Spec v2.MD', text: '# Spec', now })).toBe('.orchestration/specs/2026-09-24-onboarding-spec-v2.md')
    expect(await saveUploadedSpec(root, { name: 'Onboarding Spec v2.md', text: '# Other', now })).toBe('.orchestration/specs/2026-09-24-onboarding-spec-v2-2.md')
    expect(await readFile(join(root, '.orchestration/specs/2026-09-24-onboarding-spec-v2.md'), 'utf8')).toBe('# Spec')
    expect(await saveUploadedSpec(root, { text: '\n## Экспорт отчётов\nтекст', now })).toBe('.orchestration/specs/2026-09-24-eksport-otchetov.md')
    expect(await saveUploadedSpec(root, { text: '!!!', now })).toBe('.orchestration/specs/2026-09-24-spec.md')
    expect(await saveUploadedSpec(root, { text: '# Export reports\ntext', now })).toBe('.orchestration/specs/2026-09-24-export-reports.md')
    expect(await saveUploadedSpec(root, { name: 'notes.txt', text: 'plain', now })).toMatch(/\.txt$/)
  })

  it('rejects unsupported types, oversize and empty specs, and names carrying a path', async () => {
    const root = await repo()
    for (const [input, code] of [
      [{ name: 'brief.pdf', text: 'x' }, 'unsupported_type'],
      [{ name: 'brief', text: 'x' }, 'unsupported_type'],
      [{ name: 'big.md', text: 'x'.repeat(MAX_SPEC_BYTES + 1) }, 'too_large'],
      [{ name: 'blank.md', text: '  \n' }, 'empty'],
      [{ name: '../escape.md', text: 'x' }, 'bad_name'],
      [{ name: 'a/b.md', text: 'x' }, 'bad_name'],
      [{ name: '..\\escape.md', text: 'x' }, 'bad_name'],
      [{ name: '', text: 'x' }, 'bad_name'],
    ] as const) await expect(saveUploadedSpec(root, { ...input, now })).rejects.toMatchObject({ code })
    expect(await readdir(join(root, '.orchestration/specs')).catch(() => [])).toEqual([])
  })

  it('refuses a specs folder that a symlink points outside the repository', async () => {
    const root = await repo()
    const outside = await repo()
    await mkdir(join(root, '.orchestration'), { recursive: true })
    await symlink(outside, join(root, '.orchestration', 'specs'))
    await expect(saveUploadedSpec(root, { name: 'x.md', text: '# x', now })).rejects.toMatchObject({ code: 'bad_name' })
    expect(await readdir(outside)).toEqual([])
  })
})
