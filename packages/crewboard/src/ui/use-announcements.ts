import { useEffect, useRef, useState } from 'react'
import { flatten } from '../model/project.js'
import type { AssignmentView } from '../model/types.js'
import { T } from './text.js'

type Snapshot = { key: string; nodes: Map<string, Pick<AssignmentView, 'status' | 'request'>> }

/** Compare successive tree snapshots locally; each goal visit starts with a silent baseline. */
export function useAnnouncements(project: string | undefined, goalId: string | undefined, tree: AssignmentView | undefined) {
  const previous = useRef<Snapshot>()
  const [announcement, setAnnouncement] = useState({ id: 0, text: '' })
  useEffect(() => {
    if (!project || !goalId) {
      previous.current = undefined
      return
    }
    const key = JSON.stringify([project, goalId])
    if (previous.current?.key !== key) previous.current = undefined
    if (!tree) return
    const before = previous.current
    const nodes = flatten(tree)
    previous.current = { key, nodes: new Map(nodes.map((node) => [node.id, { status: node.status, request: node.request ? { ...node.request } : undefined }])) }
    if (!before) return

    const messages: string[] = []
    for (const node of nodes) {
      const old = before.nodes.get(node.id)
      if (node.status !== old?.status) {
        if (node.status === 'waiting_owner') messages.push(T.announceQuestion(node.title))
        if (node.status === 'done' || node.status === 'cancelled') messages.push(T.announceFinished(node.title))
      }
      const request = node.request
      if (request && (request.id !== old?.request?.id || request.state !== old?.request?.state)) {
        if (request.state === 'declined') messages.push(`${node.title}: ${T.announceRequestDeclined}`)
        if (request.state === 'failed') messages.push(`${node.title}: ${T.announceRequestFailed}`)
      } else if (!request && old?.request?.state === 'pending') {
        messages.push(`${node.title}: ${T.event.requestAccepted}`)
      }
    }
    if (messages.length) setAnnouncement((last) => ({ id: last.id + 1, text: messages.join('. ') }))
  }, [project, goalId, tree])
  return announcement
}
