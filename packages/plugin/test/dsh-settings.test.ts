import { mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { dshHomeOf, watchDshSettings } from '../src/host/dsh-settings.js'

it('finds dsh\'s home the way dsh does', () => {
  expect(dshHomeOf({}, '/home/me')).toBe('/home/me/.dsh')
  expect(dshHomeOf({ DSH_HOME: '~/work/dsh' }, '/home/me')).toBe('/home/me/work/dsh')
  expect(dshHomeOf({ DSH_HOME: ' ' }, '/home/me')).toBe('/home/me/.dsh')
})

it('V-pv1/refresh reports a replaced settings.yaml and ignores dsh\'s other files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pv1-dsh-home-'))
  const onChange = vi.fn()
  const stop = watchDshSettings(dir, onChange)
  try {
    await writeFile(join(dir, 'sessions.db'), 'x')
    await new Promise((r) => setTimeout(r, 150))
    expect(onChange).not.toHaveBeenCalled()
    // The Models page writes a temporary file and renames it over the document.
    await writeFile(join(dir, 'settings.yaml.tmp'), 'llm-pi-ai: {}\n')
    await rename(join(dir, 'settings.yaml.tmp'), join(dir, 'settings.yaml'))
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 })
  } finally {
    stop()
  }
  // A dsh that was never started has no home yet: nothing to watch, nothing thrown.
  expect(() => watchDshSettings(join(dir, 'absent'), onChange)()).not.toThrow()
})
