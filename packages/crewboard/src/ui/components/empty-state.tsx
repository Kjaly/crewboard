import { Copy } from '../icons.js'
import { useEffect, useState } from 'react'
import type { AgentReadiness } from '../../doctor.js'
import type { Api } from '../api.js'
import { CONNECT_COMMANDS, type LeadClientId, T } from '../text.js'

/** No goals yet: how to connect a lead, for each known client and for any other MCP client. */
export function EmptyState(props: { api: Api }) {
  const commands = CONNECT_COMMANDS(typeof location === 'undefined' ? 'http://127.0.0.1:4700' : location.origin)
  const [client, setClient] = useState<LeadClientId>('claude')
  const [copied, setCopied] = useState(false)
  const [workers, setWorkers] = useState<AgentReadiness[] | undefined>()
  useEffect(() => {
    let alive = true
    props.api.doctor().then((r) => alive && setWorkers(r), () => undefined)
    return () => {
      alive = false
    }
  }, [props.api])
  const command = commands.find((c) => c.client === client)?.text ?? ''
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard refused (insecure context): the command stays selectable on screen.
    }
  }
  return (
    <section className="empty">
      <h2>{T.emptyTitle}</h2>
      <p>{T.emptyText}</p>
      <div className="seg" role="tablist" aria-label={T.connectWith}>
        {commands.map((c) => (
          <button key={c.client} type="button" role="tab" aria-selected={c.client === client} className="press" onClick={() => setClient(c.client)}>
            {T.connectClient[c.client]}
          </button>
        ))}
      </div>
      <p className="connect-hint">{T.connectHint[client]}</p>
      <div className="cmd">
        <code>{command}</code>
        <button type="button" className="btn press" onClick={copy}>
          <Copy size={14} aria-hidden="true" /> {copied ? T.copied : T.copy}
        </button>
      </div>
      {workers && workers.length > 0 && (
        <>
          <h3 className="workers-title">{T.workersTitle}</h3>
          <ul className="workers" aria-label={T.workersTitle}>
            {workers.map((w) => {
              const failed = w.checks.find((c) => !c.ok)
              return (
                <li key={w.id} data-ok={w.ok}>
                  <b>{w.label}</b> <span>{w.ok ? T.workerReady : T.workerNotReady}</span>
                  {!w.ok && failed && <code>{failed.fix ?? failed.detail}</code>}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}
