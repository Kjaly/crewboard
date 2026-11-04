// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { AssignmentView } from '../src/model/types.js'
import { T, setLang } from '../src/ui/text.js'
import { useAnnouncements } from '../src/ui/use-announcements.js'
import { node } from './ui-fixtures.js'

setLang('ru')
afterEach(cleanup)

function Announcements({ project = '/repo', goalId = 'g', tree }: { project?: string; goalId?: string; tree?: AssignmentView }) {
  const announcement = useAnnouncements(project, goalId, tree)
  return <div role="status"><span key={announcement.id}>{announcement.text}</span></div>
}

it('announces questions and completions from tree changes without repeating unchanged states', () => {
  const tree = node('g', 'running', {}, [node('a', 'running'), node('b', 'done')])
  const { rerender } = render(<Announcements tree={tree} />)
  const status = screen.getByRole('status')
  expect(status.textContent).toBe('')

  const question = { ...tree, children: [node('a', 'waiting_owner'), node('b', 'done')] }
  rerender(<Announcements tree={question} />)
  expect(status.textContent).toBe(T.announceQuestion('a'))
  const spoken = status.firstChild
  rerender(<Announcements tree={structuredClone(question)} />)
  expect(status.firstChild).toBe(spoken)

  rerender(<Announcements tree={{ ...tree, children: [node('b', 'done'), node('a', 'done')] }} />)
  expect(status.textContent).toBe(T.announceFinished('a'))
  rerender(<Announcements tree={{ ...tree, children: [node('a', 'done'), node('b', 'cancelled')] }} />)
  expect(status.textContent).toBe(T.announceFinished('b'))
})

it('announces request decisions and newly visible outcomes once per state transition', () => {
  const request = { id: 'r', action: 'stop', state: 'pending' } as const
  const { rerender } = render(<Announcements tree={node('g', 'running', { request })} />)
  const status = screen.getByRole('status')
  expect(status.textContent).toBe('')
  rerender(<Announcements tree={node('g', 'running')} />)
  expect(status.textContent).toBe(`g: ${T.event.requestAccepted}`)

  for (const state of ['declined', 'failed'] as const) {
    rerender(<Announcements tree={node('g', 'running', { request })} />)
    rerender(<Announcements tree={node('g', 'running', { request: { ...request, state } })} />)
    expect(status.textContent).toBe(`g: ${state === 'declined' ? T.announceRequestDeclined : T.announceRequestFailed}`)
    const spoken = status.firstChild
    rerender(<Announcements tree={node('g', 'running', { request: { ...request, state, reason: 'more detail' } })} />)
    expect(status.firstChild).toBe(spoken)
  }

  const lastOutcome = status.firstChild
  rerender(<Announcements tree={node('g', 'running')} />)
  expect(status.firstChild).toBe(lastOutcome)
  rerender(<Announcements tree={node('g', 'running', { request: { ...request, id: 'new', state: 'failed' } })} />)
  expect(status.textContent).toBe(`g: ${T.announceRequestFailed}`)
  expect(status.firstChild).not.toBe(lastOutcome)
})

it('uses the first snapshot after every goal or project switch as a silent baseline', () => {
  const { rerender } = render(<Announcements tree={node('a', 'running')} />)
  const status = screen.getByRole('status')
  rerender(<Announcements tree={node('a', 'waiting_owner')} />)
  expect(status.textContent).toBe(T.announceQuestion('a'))
  const spoken = status.firstChild

  rerender(<Announcements goalId="other" />)
  rerender(<Announcements goalId="other" tree={node('a', 'done')} />)
  rerender(<Announcements tree={node('a', 'done')} />)
  rerender(<Announcements project="/other-repo" tree={node('a', 'waiting_owner')} />)
  expect(status.firstChild).toBe(spoken)
  rerender(<Announcements project="/other-repo" tree={node('a', 'cancelled')} />)
  expect(status.textContent).toBe(T.announceFinished('a'))
})
