import { useState, useSyncExternalStore } from 'react'
import { type NotifyMode, enableBrowserNotifications, notifySettings, setNotifyMode, subscribeNotifySettings } from './attention.js'
import { t, useLang } from './i18n.js'

/** The notification-channel control for the Orchestration settings screen. */

export function NotifySettings() {
  useLang()
  const settings = useSyncExternalStore(subscribeNotifySettings, notifySettings, notifySettings)
  const [busy, setBusy] = useState(false)
  const options: Array<{ id: NotifyMode; label: string }> = [
    { id: 'browser', label: t('settings.notify.browser') },
    { id: 'mac', label: t('settings.notify.macos') },
    { id: 'off', label: t('settings.notify.off') },
  ]
  const ask = async () => {
    setBusy(true)
    try {
      await enableBrowserNotifications()
    } finally {
      setBusy(false)
    }
  }
  const permission = settings.permission
  return (
    <section className="orc-block" aria-label={t('settings.notify.title')}>
      <h2 className="orc-block__head">{t('settings.notify.title')}</h2>
      <p className="orc-hint">{t('settings.notify.hint')}</p>
      <div className="orc-notify" role="radiogroup" aria-label={t('settings.notify.title')}>
        {options.map((option) => (
          <label key={option.id} className="orc-notify__opt">
            <input
              type="radio"
              name="orc-notify-mode"
              checked={settings.mode === option.id}
              onChange={() => setNotifyMode(option.id)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <p className="orc-hint" role="status">
        {permission === 'granted' ? t('settings.notify.granted') : permission === 'denied' ? t('settings.notify.denied') : permission === 'default' ? t('settings.notify.default') : t('settings.notify.unsupported')}
      </p>
      {settings.mode === 'browser' && permission === 'default' ? (
        <button type="button" className="orc-btn" disabled={busy} onClick={() => void ask()}>
          {t('settings.notify.allow')}
        </button>
      ) : null}
      {permission === 'denied' ? <p className="orc-error">{t('settings.notify.blocked')}</p> : null}
    </section>
  )
}
