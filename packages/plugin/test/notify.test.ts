import { expect, it } from 'vitest'
import type { Attention, RepoSnapshot } from '@crewboard/core'
import { createAttentionNotifier } from '../src/host/notify.js'

const repo = (attention: Attention[]): RepoSnapshot => ({
  root: '/r',
  goal: 'g',
  rev: 1,
  updatedAt: 't',
  tasks: [],
  ready: [],
  criticalPath: [],
  attention,
  degraded: false,
})
const snap = (...attention: Attention[]) => ({ generatedAt: 't', repos: [repo(attention)], workers: [] })

it('notifies only about attention that appeared after the first snapshot', () => {
  const sent: string[] = []
  const notifier = createAttentionNotifier((title, message) => {
    sent.push(`${title}|${message}`)
  })
  const a: Attention = { kind: 'stalled', severity: 'alert', taskId: 't1', runId: 'run_dsh-1', message: 'тишина 6 мин' }
  const b: Attention = { kind: 'stalled', severity: 'warn', taskId: 't2', runId: 'run_dsh-2', message: 'не отвечает' }
  expect(notifier(snap(a))).toEqual([])
  expect(sent).toEqual([])
  expect(notifier(snap(a, b))).toEqual([b])
  expect(sent).toEqual(['crewboard · t2|No recent worker activity.'])
  notifier(snap(a, b))
  expect(sent).toHaveLength(1)
  notifier(snap(b))
  notifier(snap(a, b))
  expect(sent).toHaveLength(2)
})

it('uses the selected language for notification toasts', () => {
  const sent: string[] = []
  const notifier = createAttentionNotifier((title, message) => { sent.push(`${title}|${message}`) }, () => 'ru')
  const item: Attention = { kind: 'failed', severity: 'alert', taskId: 't-ru', runId: 'r', message: 'ignored raw event' }
  notifier(snap())
  notifier(snap(item))
  expect(sent).toEqual(['crewboard · t-ru|Запуск воркера завершился с ошибкой.'])
})

it('stays silent while a browser client is present and resumes once it is gone', () => {
  const sent: string[] = []
  let quiet = false
  const notifier = createAttentionNotifier((title, message) => { sent.push(`${title}|${message}`) }, () => 'en', () => !quiet)
  const a: Attention = { kind: 'stalled', severity: 'alert', taskId: 't1', runId: 'run_1', message: 'stale' }
  const b: Attention = { kind: 'failed', severity: 'alert', taskId: 't2', runId: 'run_2', message: 'boom' }
  notifier(snap())
  quiet = true
  notifier(snap(a))
  // The hidden browser tab is showing it, so macOS must not.
  expect(sent).toEqual([])
  // The suppressed item is not replayed when the browser tab goes away.
  quiet = false
  notifier(snap(a))
  expect(sent).toEqual([])
  notifier(snap(a, b))
  expect(sent).toEqual(['crewboard · t2|The worker run failed.'])
})
