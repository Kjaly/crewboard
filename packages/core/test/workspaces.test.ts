import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeWorkspaces, readDshWorkspaces } from '../src/workspaces/workspaces.js'

/** A throwaway HOME; `content === undefined` means «воркспейсов ещё нет». */
async function homeWith(content: string | undefined): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orch-ws-'))
  if (content !== undefined) {
    await mkdir(join(home, '.dsh', 'storages'), { recursive: true })
    await writeFile(join(home, '.dsh', 'storages', 'workspace.json'), content)
  }
  return home
}

describe('dsh workspaces', () => {
  it('reads the path and title of every workspace', async () => {
    const home = await homeWith(
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        tables: {
          workspaces: {
            w1: { path: '/Users/me/alpha', title: 'Alpha', sessionIds: ['s1'] },
            w2: { path: '/Users/me/beta', title: 'Beta' },
          },
        },
      }),
    )
    expect(readDshWorkspaces(home)).toEqual([
      { id: 'w1', path: '/Users/me/alpha', title: 'Alpha' },
      { id: 'w2', path: '/Users/me/beta', title: 'Beta' },
    ])
  })

  it('treats a missing or broken workspace.json as an empty list, never an exception', async () => {
    expect(readDshWorkspaces(await homeWith(undefined))).toEqual([])
    expect(readDshWorkspaces(await homeWith('{ this is not json'))).toEqual([])
    expect(readDshWorkspaces(await homeWith('{"tables":{"workspaces":"broken"}}'))).toEqual([])
  })

  it('merges workspaces with config repos and collapses duplicate paths', () => {
    const merged = mergeWorkspaces(
      [
        { id: 'w1', path: '/a', title: 'Alpha' },
        { id: 'w2', path: '/b', title: 'Beta' },
      ],
      ['/b', '/c', '/a'],
    )
    expect(merged).toEqual([
      { root: '/a', title: 'Alpha', sources: ['dsh', 'profile'] },
      { root: '/b', title: 'Beta', sources: ['dsh', 'profile'] },
      { root: '/c', sources: ['profile'] },
    ])
  })
})
