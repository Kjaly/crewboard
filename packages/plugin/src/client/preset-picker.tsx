import { useEffect, useRef, useState } from 'react'
import type { CheckSetting, EffectiveRouting, WorkerPreset, WorkerInfo } from '../shared/types.js'
import { api } from './api.js'
import { t } from './i18n.js'
import { repoName } from './review.js'

const CLASSES = ['code', 'design', 'review', 'research'] as const
export function workerName(id: string, workers: readonly WorkerInfo[]): string {
  return workers.find((worker) => worker.id === id)?.label ?? id
}

/** A description of the resolved order. The host snapshot remains the only routing authority. */
export function AutoOrder({ effective, workers }: { effective?: EffectiveRouting; workers: readonly WorkerInfo[] }) {
  if (!effective) return null
  return /* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */ <div className="orc-preset__order" role="table" aria-label={t('settings.workerOrder')}>{CLASSES.map((cls) => /* biome-ignore lint/a11y/useFocusableInteractive: The row contains focusable controls and is not itself a target. */ <div className="orc-preset__route" role="row" key={cls}><span role="cell">{t(`settings.classShort.${cls}`)}</span><span role="cell">{effective.routing[cls].length ? <><strong>{workerName(effective.routing[cls][0]!, workers)}</strong>{effective.routing[cls].slice(1).map((id) => <span className="orc-preset__fallback" key={id}> → {workerName(id, workers)}</span>)}</> : t('settings.noWorker')}</span></div>)}</div>
}

export function PresetPickers({ repo, planId, planTitle, effective, check, workers, openRequest, onOpenSettings }: { repo: string; planId?: string; planTitle?: string; effective?: EffectiveRouting; check?: CheckSetting; workers: readonly WorkerInfo[]; openRequest?: number; onOpenSettings?(): void }) {
  const [presets, setPresets] = useState<WorkerPreset[]>([])
  const [repositoryEffective, setRepositoryEffective] = useState<EffectiveRouting>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const firstRef = useRef<HTMLSelectElement>(null)
  useEffect(() => {
    let live = true
    setRepositoryEffective(undefined)
    setPresets([])
    void api.presets(repo).then((result) => { if (live && result.ok) { if (Array.isArray(result.value?.presets)) setPresets(result.value.presets); setRepositoryEffective(result.value.effectiveRouting) } }).catch(() => {})
    return () => { live = false }
  }, [repo])
  useEffect(() => { if (openRequest) setOpen(true) }, [openRequest])
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) { setOpen(false); buttonRef.current?.focus() }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); buttonRef.current?.focus() }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  const options = <><option value="all-workers">{t('settings.allWorkers')}</option>{presets.filter((preset) => preset.id !== 'all-workers').map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</>
  const save = async (scope: 'repository' | 'plan', id?: string) => {
    setPending(true); setError('')
    try {
      const result = scope === 'repository' ? await api.repoPreset(repo, id) : await api.planPreset(repo, planId!, id)
      if (!result.ok) setError(result.message ?? result.error)
      else if (scope === 'repository') void api.presets(repo).then((fresh) => { if (fresh.ok) setRepositoryEffective(fresh.value.effectiveRouting) })
    } catch { setError(t('settings.loadError')) }
    finally { setPending(false) }
  }
  const presetLabel = effective?.preset.id === 'all-workers' ? t('settings.allWorkers') : effective?.preset.label ?? t('settings.allWorkers')
  const repositoryLabel = repositoryEffective?.preset.id === 'all-workers' ? t('settings.allWorkers') : repositoryEffective?.preset.label ?? (effective?.source !== 'plan' ? presetLabel : t('settings.repositoryUnknown'))
  const firstWorker = effective?.routing.code[0] ? workerName(effective.routing.code[0], workers) : t('settings.noWorker')
  return <span className="orc-preset" ref={rootRef}>
    <button ref={buttonRef} type="button" className="orc-chip orc-preset__trigger" aria-label={t('settings.workersButton', { preset: presetLabel, worker: firstWorker })} aria-expanded={open} aria-controls="orc-workers-popover" onClick={() => { setOpen(!open); if (!open) requestAnimationFrame(() => firstRef.current?.focus()) }}>
      <span aria-hidden="true">⚙</span> <span className="orc-preset__summary">{presetLabel}: {firstWorker}</span> <span aria-hidden="true">▾</span>
    </button>
    {open ? /* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */ <div className="orc-preset__popover" id="orc-workers-popover" role="group" aria-label={t('settings.whoRunsTasks')}>
      <h2 className="orc-preset__title">{t('settings.whoRunsTasks')}</h2>
      <label className="orc-preset__field" title={t('settings.repositoryHelp')}><span>{t('settings.scopeRepository')}</span>
        <select ref={firstRef} className="orc-select" aria-label={t('settings.thisRepository', { repo: repoName(repo) })} value={repositoryEffective?.preset.id ?? (effective?.source !== 'plan' ? effective?.preset.id : '') ?? ''} disabled={pending} onChange={(e) => void save('repository', e.target.value)}>
          {!repositoryEffective && effective?.source === 'plan' ? <option value="">{t('settings.repositoryUnknown')}</option> : null}
          {options}
        </select>
      </label>
      {planId ? <label className="orc-preset__field" title={t('settings.planHelp')}><span>{t('settings.scopePlan')}</span>
        <select className="orc-select" aria-label={t('settings.thisPlan', { plan: planTitle || planId })} value={effective?.source === 'plan' ? effective.preset.id : ''} disabled={pending} onChange={(e) => void save('plan', e.target.value || undefined)}>
          <option value="">{t('settings.asRepository', { preset: repositoryLabel })}</option>{options}
        </select>
      </label> : null}
      {effective ? <p className="orc-preset__effective">{t('settings.inForce', { preset: presetLabel, source: t(`settings.forceSource.${effective.source}`) })}</p> : null}
      <AutoOrder effective={effective} workers={workers} />
      {effective?.dropped.map((entry) => <p className="orc-preset__dropped" key={entry.id}>{t(`settings.skippedWorker.${entry.reason}`, { worker: workerName(entry.id, workers) })}</p>)}
      {check ? <CheckSettingFields repo={repo} planId={planId} check={check} /> : null}
      {error ? <span className="orc-error" role="alert">{error}</span> : null}
      {onOpenSettings ? <button type="button" className="orc-preset__settings" onClick={() => { setOpen(false); onOpenSettings() }}>{t('settings.openOrchestration')} →</button> : null}
    </div> : null}
  </span>
}

const choiceOf = (value?: boolean) => value === undefined ? '' : value ? 'on' : 'off'
const settingOf = (choice: string) => choice === '' ? null : choice === 'on'

/** «Orchestrator checks finished work» (vr1): per repository, a plan may override; the host resolves the value in force. */
function CheckSettingFields({ repo, planId, check }: { repo: string; planId?: string; check: CheckSetting }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const save = async (scope: 'repo' | 'plan', choice: string) => {
    setPending(true); setError('')
    try {
      const result = await api.orchestratorCheck(repo, scope, settingOf(choice), planId)
      if (!result.ok) setError(result.message ?? result.error)
    } catch { setError(t('settings.loadError')) }
    finally { setPending(false) }
  }
  const repositoryDefault = t('check.setting.byChat')
  return <>
    <h2 className="orc-preset__title">{t('check.setting.title')}</h2>
    <label className="orc-preset__field" title={t('check.setting.help')}><span>{t('settings.scopeRepository')}</span>
      <select className="orc-select" aria-label={t('check.setting.repository', { repo: repoName(repo) })} value={choiceOf(check.repository)} disabled={pending} onChange={(e) => void save('repo', e.target.value)}>
        <option value="">{repositoryDefault}</option><option value="on">{t('check.setting.on')}</option><option value="off">{t('check.setting.off')}</option>
      </select>
    </label>
    {planId ? <label className="orc-preset__field" title={t('check.setting.help')}><span>{t('settings.scopePlan')}</span>
      <select className="orc-select" aria-label={t('check.setting.plan')} value={choiceOf(check.plan)} disabled={pending} onChange={(e) => void save('plan', e.target.value)}>
        <option value="">{t('check.setting.asRepository')}</option><option value="on">{t('check.setting.on')}</option><option value="off">{t('check.setting.off')}</option>
      </select>
    </label> : null}
    <p className="orc-preset__effective">{t(check.enabled ? 'check.setting.inForceOn' : 'check.setting.inForceOff', { source: t(`check.setting.source.${check.source}`) })}</p>
    {error ? <span className="orc-error" role="alert">{error}</span> : null}
  </>
}
