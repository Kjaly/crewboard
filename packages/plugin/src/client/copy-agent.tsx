import { useState } from 'react'
import { t, useLang } from './i18n.js'

/**
 * One «Copy for agent» button for every surface that offers it. Copies prebuilt `agentHandoff`
 * text, then answers «Copied» on the button itself for a moment — no chat opens, the person picks
 * where the brief lands.
 */
export function CopyForAgent({ text, compact }: { text: string; compact?: boolean }) {
  useLang()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={compact ? 'orc-copyagent orc-copyagent--icon' : 'orc-copyagent'}
      title={t('copyAgent.hint')}
      onClick={(event) => {
        event.stopPropagation()
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        }).catch(() => {})
      }}
    >
      {copied ? t('copyAgent.done') : compact ? '⧉' : t('copyAgent.label')}
    </button>
  )
}
