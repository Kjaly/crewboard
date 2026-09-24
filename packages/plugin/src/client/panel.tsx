import { App } from './app.js'
import { useLang } from './i18n.js'
import { reviewBadgeLabel, reviewCenter, useReviewBadge } from './notify.js'

export function OrchestraIcon({ size }: { size: number; active: boolean }) {
  useLang()
  const { waiting } = useReviewBadge()
  return (
    <span className="orc-icon" aria-hidden="true" title={reviewBadgeLabel()} onClick={() => { if (waiting > 0) reviewCenter().open() }}>
      <svg aria-label="Orchestra" role="img" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <title>Orchestra</title>
        <circle cx="3.5" cy="8" r="1.8" />
        <circle cx="12.5" cy="4" r="1.8" />
        <circle cx="12.5" cy="12" r="1.8" />
        <path d="M5.2 7.3 10.8 4.7M5.2 8.7l5.6 2.6" />
      </svg>
      {waiting > 0 ? <span className="orc-icon__badge">{waiting > 99 ? '99+' : waiting}</span> : null}
    </span>
  )
}

/** Slot entry point: the screen itself lives in `app.tsx`. */
export function OrchestraPanel() {
  return <App />
}
