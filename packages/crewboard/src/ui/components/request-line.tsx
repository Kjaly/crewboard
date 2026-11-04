import type { AssignmentView } from '../../model/types.js'
import { T, providerLabel } from '../text.js'

type Request = NonNullable<AssignmentView['request']>

/** Shared by the waiting line and the journal so a handoff keeps all its choices. */
export function requestContent(request: Pick<Request, 'action' | 'text' | 'provider' | 'model' | 'effort'>): string {
  return [
    T.actionVerb[request.action], request.text, request.provider ? providerLabel(request.provider) : undefined, request.model,
    request.effort === null ? T.effortUnset : request.effort ? (T.effort[request.effort] ?? request.effort) : undefined,
  ].filter(Boolean).join(' · ')
}

export function requestText(request: Request): string {
  if (request.state === 'failed') return T.event.requestFailed(request.reason ?? '')
  return request.state === 'pending' ? T.requestPending(requestContent(request)) : T.requestDeclined(request.reason ?? '')
}

export function RequestLine(props: { request: AssignmentView['request'] }) {
  if (!props.request || props.request.state === 'pending') return null
  return <p className={`request ${props.request.state}`}>{requestText(props.request)}</p>
}
