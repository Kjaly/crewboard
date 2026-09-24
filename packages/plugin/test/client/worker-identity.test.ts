import { expect, it } from 'vitest'
import { workerIdentity, identityLabel } from '../../src/client/provider.js'
import { workerOptions } from '../../src/client/workers.js'
import type { WorkerInfo } from '../../src/shared/types.js'

const workers: WorkerInfo[] = [
  { id: 'codex/gpt-6-astra', label: 'My review agent', provider: 'Codex', billing: 'подписка', main: true, usedIn: [] },
  { id: 'claude/new', label: 'Custom Claude', provider: 'Claude', billing: 'подписка', main: true, usedIn: [] },
]

it('uses the resolved catalog label for a renamed worker and its alias', () => {
  expect(identityLabel(workerIdentity('codex', workers))).toBe('My review agent')
})

it('builds the selectable list from the catalog and preserves an unknown current id', () => {
  expect(workerOptions('unregistered', workers)).toEqual(['unregistered', 'codex/gpt-6-astra', 'claude/new'])
})
