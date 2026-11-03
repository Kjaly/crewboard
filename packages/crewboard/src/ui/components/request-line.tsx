import type { AssignmentView } from '../../model/types.js'
import { T } from '../text.js'

/** Where the owner's latest request stands: waiting for the lead, or declined with the lead's reason. */
export function requestText(request: NonNullable<AssignmentView['request']>): string {
  return request.state === 'pending' ? T.requestPending(T.actionVerb[request.action]) : T.requestDeclined(request.reason ?? '')
}

export function RequestLine(props: { request: AssignmentView['request'] }) {
  // A waiting request is the banner at the top of the actions; only the lead's refusal stays as a line.
  if (props.request?.state !== 'declined') return null
  return <p className={`request ${props.request.state}`}>{requestText(props.request)}</p>
}
