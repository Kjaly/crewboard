import { flatten } from '../../model/project.js'
import type { AssignmentView, Status } from '../../model/types.js'
import { T } from '../text.js'

export type Counts = { waiting_owner: number; waiting_lead: number; running: number; queued: number; finished: number }

const BUCKET: Partial<Record<Status, keyof Counts>> = { waiting_owner: 'waiting_owner', running: 'running', waiting_answer: 'waiting_lead', queued: 'queued', done: 'finished', cancelled: 'finished', abandoned: 'finished' }

export function countTree(root: AssignmentView): Counts {
  const counts: Counts = { waiting_owner: 0, waiting_lead: 0, running: 0, queued: 0, finished: 0 }
  for (const n of flatten(root)) {
    const b = n.parentId === null ? undefined : BUCKET[n.status]
    if (b) counts[b] += 1
  }
  return counts
}

export function Summary(props: { counts: Counts; onWaiting: () => void }) {
  const { counts } = props
  return (
    <section className="summary" aria-label={T.summary}>
      {counts.waiting_owner > 0 && (
        <button type="button" className="warn press" onClick={props.onWaiting}>
          {T.waitingYou(counts.waiting_owner)}
        </button>
      )}
      {counts.waiting_lead > 0 && <span>{T.waitingLead(counts.waiting_lead)}</span>}
      <span>{T.running(counts.running)}</span>
      <span>{T.queued(counts.queued)}</span>
      <span>{T.finished(counts.finished)}</span>
    </section>
  )
}
