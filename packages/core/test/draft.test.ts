import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PlanDraftSchema, approveDraft, checkDraft, discardDraft, listDrafts, loadDraft, saveDraft, initPlan, listPlans, loadPlan } from '../src/index.js'

const now = new Date('2026-09-23T12:00:00Z')
const base = { id: 'spec-draft', goal: 'Ship', source: { name: 'spec.md', hash: 'abc' }, lanes: ['core'], tasks: [{ id: 'one', title: 'One', lane: 'core', class: 'code' as const, kind: 'implement' as const, deps: [], contract: 'Own src/one.ts\n', acceptance: ['works'], sources: ['§1'] }], decisions: [] }

describe('plan drafts', () => {
  it('refuses colliding task ids with a named reason', () => {
    const result = PlanDraftSchema.safeParse({ ...base, tasks: [base.tasks[0], base.tasks[0]] })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.message).toContain('duplicate_task_id: one')
  })

  it('reports every structural finding with codes and data', () => {
    const draft = PlanDraftSchema.parse({ ...base, tasks: [
      { ...base.tasks[0], deps: ['two', 'missing'], contract: ' ', acceptance: [] },
      { ...base.tasks[0], id: 'two', deps: ['one'], contract: 'Own src/one.ts' },
      { ...base.tasks[0], id: 'three', deps: [], contract: 'Own src/one.ts' },
    ] })
    expect(checkDraft(draft).map((f) => f.code)).toEqual(expect.arrayContaining(['cycle', 'missing_dependency', 'missing_acceptance', 'empty_contract', 'file_collision']))
    expect(checkDraft(draft).every((f) => typeof f.data === 'object')).toBe(true)
  })

  it('stores, lists, discards, and approves into a separate plan with contracts and provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'draft-'))
    await initPlan(root, 'Existing', now)
    await saveDraft(root, base)
    expect(await listDrafts(root)).toMatchObject([{ id: 'spec-draft' }])
    expect(await loadDraft(root, 'spec-draft')).toMatchObject(base)
    expect((await listPlans(root)).map((p) => p.id)).toEqual(['main'])
    const plan = await approveDraft(root, 'spec-draft', now)
    expect(plan).toMatchObject({ goal: 'Ship', draftSource: base.source, tasks: [{ id: 'one', contract: '.orchestration/contracts/one.md', acceptance: ['works'], sources: ['§1'] }] })
    expect(await readFile(join(root, '.orchestration/contracts/one.md'), 'utf8')).toBe(base.tasks[0].contract)
    expect((await loadPlan(root, 'main')).goal).toBe('Existing')
    expect((await loadPlan(root, 'spec-draft')).tasks).toHaveLength(1)
    expect(await listDrafts(root)).toEqual([])
    await saveDraft(root, base)
    await discardDraft(root, 'spec-draft')
    expect(await listDrafts(root)).toEqual([])
  })

  it('refuses to approve a draft whose graph cannot run, and leaves nothing behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'draft-blocked-'))
    for (const deps of [['one'], ['missing']]) {
      await saveDraft(root, { ...base, tasks: [{ ...base.tasks[0], deps }] })
      await expect(approveDraft(root, 'spec-draft', now)).rejects.toMatchObject({ name: 'DraftError', reason: 'draft_invalid' })
      expect(await listPlans(root)).toEqual([])
      await expect(readFile(join(root, '.orchestration/contracts/one.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await listDrafts(root)).toMatchObject([{ id: 'spec-draft' }])
    }
  })

  it('lets the human approve a draft whose findings are only advisory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'draft-findings-'))
    await saveDraft(root, { ...base, tasks: [{ ...base.tasks[0], contract: '', acceptance: [] }] })
    expect(checkDraft(await loadDraft(root, 'spec-draft')).map((f) => f.code).sort()).toEqual(['empty_contract', 'missing_acceptance'])
    await approveDraft(root, 'spec-draft', now)
    expect((await loadPlan(root, 'spec-draft')).tasks).toHaveLength(1)
  })
})
