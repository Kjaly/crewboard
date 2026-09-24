import type { WorkerSettingsIssue } from '../shared/types.js'
import { t, useLang } from './i18n.js'

/**
 * Broken worker settings (B07): the repositories are still listed; this line says what is wrong and where,
 * so a damaged `profiles.json` is never mistaken for lost repositories.
 */
export function WorkerSettingsBanner({ issue, onOpenSettings }: { issue: WorkerSettingsIssue | undefined; onOpenSettings(): void }) {
  useLang()
  if (!issue) return null
  const text = issue.code === 'incomplete'
    ? t('panel.app.workerSettingsIncomplete', { classes: issue.classes.map((cls) => t(`settings.class.${cls}`)).join(', ') })
    : t('panel.app.workerSettingsUnreadable')
  return <div className="orc-settings-banner" role="alert">
    <p>{text}</p>
    {issue.path || issue.code === 'unreadable' ? <code>{[issue.path, issue.code === 'unreadable' ? issue.detail : ''].filter(Boolean).join(' — ')}</code> : null}
    <button type="button" className="orc-chip" onClick={onOpenSettings}>{t('panel.app.workerSettingsOpen')}</button>
  </div>
}
