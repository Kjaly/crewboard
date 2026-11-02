import { Copy } from '../icons.js'
import { useState } from 'react'
import { MCP_COMMAND, T } from '../text.js'

export function EmptyState() {
  const command = MCP_COMMAND(typeof location === 'undefined' ? 'http://127.0.0.1:4700' : location.origin)
  const [copied, setCopied] = useState(false)
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
      <div className="cmd">
        <code>{command}</code>
        <button type="button" className="btn press" onClick={copy}>
          <Copy size={14} aria-hidden="true" /> {copied ? T.copied : T.copy}
        </button>
      </div>
    </section>
  )
}
