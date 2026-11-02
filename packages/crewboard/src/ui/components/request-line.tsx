import type { AssignmentView } from '../../model/types.js'
import { T } from '../text.js'

/** Where the owner's latest request stands: waiting for the lead, or declined with the lead's reason. */
export function requestText(request: NonNullable<AssignmentView['request']>): string {
  return request.state === 'pending' ? T.requestPending(T.actionVerb[request.action]) : T.requestDeclined(request.reason ?? '')
}

export function RequestLine(props: { request: AssignmentView['request'] }) {
  if (!props.request) return null
  return <p className={`request ${props.request.state}`}>{requestText(props.request)}</p>
}
