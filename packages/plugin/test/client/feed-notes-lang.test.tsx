// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { eventNote } from '../../../core/src/plan/notes.js'
import type { Note } from '../../../core/src/plan/schema.js'
import { setLang } from '../../src/client/i18n.js'
import { noteText } from '../../src/client/note-text.js'
import { NotesTab } from '../../src/client/panel/tabs.js'
import type { TaskDetail } from '../../src/shared/types.js'

const AT = '2026-09-24T10:00:00.000Z'
// Written by the real writers' helper, so the screen reads what core stores.
const NOTES: Note[] = [
  eventNote(AT, 'check', { kind: 'check_due' }),
  eventNote(AT, 'check', { kind: 'checked', by: 'orchestrator', note: 'gates green' }),
  eventNote(AT, 'accept', { kind: 'accepted', evidence: 'e.json' }, { verdict: { kind: 'disputed', why: 'blocked' } }),
  eventNote(AT, 'reject', { kind: 'rejected', reason: 'нет тестов' }),
  eventNote(AT, 'comment', { kind: 'superseded', by: 'b2' }),
  eventNote(AT, 'comment', { kind: 'launched_outside_preset', worker: 'codex' }),
  eventNote(AT, 'comment', { kind: 'preset_fallback', stale: 'dsh/flash', worker: 'claude', preset: 'Only Claude' }),
  eventNote(AT, 'comment', { kind: 'worktree', outcome: 'kept_unmerged' }),
  { at: AT, type: 'comment', text: 'вытеснена задачей b1' },
]
const detail = { id: 'a', title: 'A', kind: 'implement', status: 'in_review', deps: [], dependents: [], runs: [], notes: NOTES, steers: [], events: [], changedFiles: [] } as unknown as TaskDetail
const lines = () => screen.getAllByRole('listitem').map((item) => item.querySelector('.orc-ev__text')?.textContent)

it('renders the notes Crewboard wrote in the UI language and follows a live switch', () => {
  setLang('en')
  render(<NotesTab detail={detail} />)
  expect(lines()).toEqual([
    'check: check due: the orchestrator checks the work before it waits for you',
    'check: checked (orchestrator): gates green',
    'acceptance: verdict: Disputed — work is blocked; accepted by a person; evidence: e.json',
    'sent back: нет тестов',
    'note: superseded by task b2',
    'note: Launched by hand outside the preset “All workers”: codex',
    'note: Worker dsh/flash, chosen by an agent, is no longer in the preset “Only Claude” for this class — ran by the preset order instead: claude. The assignment was cleared.',
    'note: Worktree kept: branch is not merged yet.',
    // An older note stored as text is shown as written.
    'note: вытеснена задачей b1',
  ])
  act(() => setLang('ru'))
  expect(lines()).toEqual([
    'проверка: ждёт проверки: оркестратор проверит работу, прежде чем она дойдёт до вас',
    'проверка: проверено (orchestrator): gates green',
    'приёмка: вердикт: Спорно — работа заблокирована; принято человеком; доказательства: e.json',
    'возврат: нет тестов',
    'заметка: вытеснена задачей b2',
    'заметка: Запущено вручную вне пресета «Все воркеры»: codex',
    'заметка: Воркер dsh/flash, выбранный агентом, больше не входит в пресет «Only Claude» для этого класса — запущен по порядку пресета: claude. Назначение снято.',
    'заметка: Рабочая копия сохранена: ветка ещё не влита.',
    'заметка: вытеснена задачей b1',
  ])
})

it('has a line in both languages for every event kind', () => {
  const events: Note['event'][] = [
    { kind: 'check_taken' }, { kind: 'check_returned', findings: 'f' }, { kind: 'check_skipped' },
    ...(['delivered', 'refused', 'failed', 'abandoned'] as const).map((delivery) => ({ kind: 'steer' as const, delivery, steerId: 's', message: 'm' })),
    ...(['removed', 'kept_recent', 'kept_unmerged'] as const).map((outcome) => ({ kind: 'worktree' as const, outcome })),
  ]
  for (const lang of ['en', 'ru'] as const) {
    setLang(lang)
    for (const event of events) expect(noteText({ text: '', event })).not.toMatch(/feed\.note|panel\./)
  }
  setLang('en')
  // A mismatch is a full sentence; inside the note line it ends before the next part, not with «.;».
  expect(noteText({ text: '', event: { kind: 'accepted' }, verdict: { kind: 'disputed', mismatch: 'no_files' } })).toBe('verdict: Disputed — A result was claimed, but no files changed; accepted by a person')
})
