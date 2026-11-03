import { useEffect, useState } from 'react'
import type { ProviderUsage, UsageBalance } from '../../usage.js'
import type { Api } from '../api.js'
import { CaretDown } from '../icons.js'
import { logoOf } from '../logos.js'
import { T } from '../text.js'

const REFRESH_MS = 60_000
/** Older than this, a subscription number read from a local log says when it was seen. */
const STALE_MS = 15 * 60_000
const OPEN_KEY = 'crewboard.usage.open'

const pad = (n: number) => String(n).padStart(2, '0')
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()

/** «15:00» today, «Thu 15:00» within a week, else the date. */
function moment(iso: string, now: Date): string {
  const at = new Date(iso)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (sameDay(at, now)) return time
  if (Math.abs(at.getTime() - now.getTime()) < 6 * 86_400_000) return `${at.toLocaleDateString(T.locale, { weekday: 'short' })} ${time}`
  return at.toLocaleDateString(T.locale, { day: 'numeric', month: 'short' })
}

function money(b: UsageBalance): string {
  if (b.currency === 'credits') return T.usage.credits(new Intl.NumberFormat(T.locale, { maximumFractionDigits: 0 }).format(b.amount))
  try {
    return new Intl.NumberFormat(T.locale, { style: 'currency', currency: b.currency }).format(b.amount)
  } catch {
    return `${b.amount.toFixed(2)} ${b.currency}`
  }
}

const hintOf = (u: ProviderUsage): string | undefined => (u.hint ? (T.usage.hint[u.hint] ?? (u.hint.startsWith('http_') ? T.usage.httpError(u.hint) : u.hint)) : undefined)

function Provider(props: { u: ProviderUsage; now: Date }) {
  const { u, now } = props
  const logo = logoOf(u.icon)
  const [first, ...more] = u.balances
  const stale = Boolean(u.at) && u.windows.length > 0 && now.getTime() - new Date(u.at ?? 0).getTime() > STALE_MS
  const hint = u.state !== 'ok' ? hintOf(u) : undefined
  return (
    <li className={`us-row ${u.state}`}>
      <div className="us-head">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: bundled, reviewed provider logos; no user input reaches this HTML. */}
        {logo ? <span className="av logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: logo }} /> : <span className="av other" aria-hidden="true">{u.label.charAt(0)}</span>}
        <span className="us-name">{u.label}</span>
        {u.plan && <span className="us-plan">{u.plan}</span>}
        {u.exhausted ? <span className="us-sum out">{T.usage.exhausted}</span> : first && <span className="us-sum">{money(first)}</span>}
      </div>
      {u.windows.map((w) => {
        const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)))
        const label = `${T.usage.window(w.minutes)}${w.model ? ` · ${w.model}` : ''}`
        return (
          <div key={`${w.minutes}${w.model ?? ''}`} className="us-win" title={`${label}: ${T.usage.used(pct)}`}>
            <div className="us-win-line">
              <span className="us-wl">{label}</span>
              {w.resetsAt && <span className="us-reset">{T.usage.resets(moment(w.resetsAt, now))}</span>}
              <b>{pct}%</b>
            </div>
            <div className={`us-bar ${pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : ''}`} aria-hidden="true">
              <i style={{ transform: `scaleX(${pct / 100})` }} />
            </div>
          </div>
        )
      })}
      {more.map((b) => (
        <div key={b.currency} className="us-note">{money(b)}</div>
      ))}
      {(hint || stale) && <div className="us-note">{hint ?? T.usage.asOf(moment(u.at ?? '', now))}</div>}
    </li>
  )
}

/** The owner's providers at the bottom of the sidebar: subscription limits used, money left, and what is missing to see them. */
export function UsagePanel(props: { api: Api }) {
  const [usage, setUsage] = useState<ProviderUsage[]>()
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0'
    } catch {
      return true
    }
  })
  useEffect(() => {
    let alive = true
    const load = () => props.api.usage().then((u) => alive && setUsage(u), () => undefined)
    void load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [props.api])
  if (!usage?.length) return null
  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem(OPEN_KEY, open ? '0' : '1')
    } catch {
      // Storage unavailable: the choice lasts until the page closes.
    }
  }
  const now = new Date()
  return (
    <section className={`usage ${open ? '' : 'closed'}`} aria-label={T.usage.title}>
      <button type="button" className="sb-fold" aria-expanded={open} aria-controls="usage-list" onClick={toggle}>
        <CaretDown className="sb-caret" size={11} aria-hidden="true" />
        {T.usage.title}
      </button>
      {open && (
        <ul id="usage-list">
          {usage.map((u) => (
            <Provider key={u.id} u={u} now={now} />
          ))}
        </ul>
      )}
    </section>
  )
}
