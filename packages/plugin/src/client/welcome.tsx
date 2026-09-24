import { useEffect, useState } from 'react'
import type { Recipe } from '@crewboard/core'
import type { OrchestraRepoSnapshot } from '../shared/types.js'
import { api, type WelcomeWorkerStatus } from './api.js'
import { t, useLang } from './i18n.js'
import { openSession } from './layout.js'
import { SpecPicker, type SpecMode } from './spec-picker.js'

const DEFAULT_RECIPE: Recipe = { setup: [], env: { unset: [] }, timeoutSec: 300 }
export function Welcome({ repo, onPreset, onExample, onDraft, onWorkers }: { repo?: OrchestraRepoSnapshot; onPreset(): void; onExample(): void; onDraft(id: string): void; onWorkers(): void }) {
  useLang()
  const [workers, setWorkers] = useState<Array<{ id: string; label: string; status: WelcomeWorkerStatus }>>([])
  const [recipe, setRecipe] = useState<Recipe | null>(null)
  const [suggested, setSuggested] = useState<Recipe>(DEFAULT_RECIPE)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<Recipe>(DEFAULT_RECIPE)
  const [specOpen, setSpecOpen] = useState<{ mode: SpecMode; file?: File } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [goal, setGoal] = useState('')
  const [pending, setPending] = useState(false)
  const [repoHelp, setRepoHelp] = useState(false)
  const [error, setError] = useState('')
  const root = repo?.root
  useEffect(() => {
    if (!root) return
    let live = true
    void api.onboardingWorkers(root).then((r) => { if (live && r.ok && Array.isArray(r.value)) setWorkers(r.value) }).catch(() => {})
    void api.recipe(root).then((r) => { if (live && r.ok && r.value?.detected) { setRecipe(r.value.recipe ?? null); setSuggested(r.value.detected); setForm(r.value.recipe ?? r.value.detected) } }).catch(() => {})
    return () => { live = false }
  }, [root])
  const workReady = workers.some((w) => w.status === 'ready')
  const presetReady = !!repo?.effectiveRouting?.preset
  const count = Number(workReady) + Number(presetReady) + Number(!!recipe)
  const run = async (action: () => Promise<{ ok: boolean; error?: string; message?: string }>) => {
    setPending(true); setError('')
    try { const result = await action(); if (!result.ok) setError(result.message ?? result.error ?? t('welcome.error')) }
    catch { setError(t('welcome.error')) }
    finally { setPending(false) }
  }
  return <div className="orc-welcome">
    <div className="orc-welcome__hero"><p className="orc-welcome__eyebrow">{t('welcome.eyebrow')}</p><h1>{t('welcome.headline')}</h1><p>{t('welcome.lead')}</p></div>
    {repo ? <div className="orc-welcome__grid">
      <section className="orc-welcome__card" aria-label={t('welcome.setup')}>
        <h2>{t('welcome.setup')} <span>{t('welcome.progress', { count })}</span></h2>
        <ol className="orc-welcome__checklist">
          <li><span className={workReady ? 'orc-welcome__ok' : 'orc-welcome__wait'}>{workReady ? '✓' : '1'}</span><div><strong>{t('welcome.workers')}</strong><p>{workers.length ? workers.map((w) => `${w.label}: ${t(`welcome.worker.${w.status}`)}`).join(' · ') : t('welcome.checking')}</p><button type="button" className="orc-link" onClick={onWorkers}>{t('welcome.openWorkers')}</button></div></li>
          <li><span className={presetReady ? 'orc-welcome__ok' : 'orc-welcome__wait'}>{presetReady ? '✓' : '2'}</span><div><strong>{t('welcome.preset')}</strong><p>{repo.effectiveRouting ? t('welcome.presetValue', { preset: repo.effectiveRouting.preset.id === 'all-workers' ? t('settings.allWorkers') : repo.effectiveRouting.preset.label, source: t(`settings.forceSource.${repo.effectiveRouting.source}`) }) : t('welcome.checking')}</p><button type="button" className="orc-link" onClick={onPreset}>{t('welcome.choosePreset')}</button></div></li>
          <li><span className={recipe ? 'orc-welcome__ok' : 'orc-welcome__wait'}>{recipe ? '✓' : '3'}</span><div><strong>{t('welcome.repository')}</strong><p>{recipe ? t('welcome.recipeFound') : t('welcome.recipeMissing')}</p><p className="orc-welcome__hint">{t('welcome.recipeHelp')}</p><button type="button" className="orc-link" onClick={() => { setForm(recipe ?? suggested); setEditing(true) }}>{t('welcome.editRecipe')}</button></div></li>
        </ol>
      </section>
      <section className="orc-welcome__card orc-welcome__card--start" aria-label={t('welcome.start')}><h2>{t('welcome.start')}</h2>
        <button
          type="button"
          className={`orc-welcome__choice orc-welcome__choice--primary${dragging ? ' orc-welcome__choice--drop' : ''}`}
          onClick={() => setSpecOpen({ mode: 'file' })}
          onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) setSpecOpen({ mode: 'file', file }) }}
        ><strong>{t('welcome.fromSpec')}</strong><span>{t('welcome.fromSpecHelp')}</span></button>
        <button type="button" className="orc-welcome__choice" onClick={() => void run(async () => { const result = await api.chatOpen(repo.root, repo.hasPlan ? repo.planId : undefined, t('welcome.chatPrompt')); if (result.ok && !(await openSession(result.value.sessionId))) setError(t('welcome.chatOpened')); return result })}><strong>{t('welcome.fromChat')}</strong><span>{t('welcome.fromChatHelp')}</span></button>
        <button type="button" className="orc-welcome__choice" onClick={onExample}><strong>{t('welcome.example')}</strong><span>{t('welcome.exampleHelp')}</span></button>
        <form className="orc-welcome__empty" onSubmit={(e) => { e.preventDefault(); if (!goal.trim()) return; void run(async () => repo.hasPlan ? api.planNew(repo.root, goal.trim()) : api.planInit(repo.root, goal.trim())) }}><label>{t('welcome.emptyPlan')} <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t('welcome.goal')} /></label><button type="submit" disabled={pending || !goal.trim()}>{t('welcome.create')}</button></form>
        <p className="orc-welcome__hint">{t('welcome.cliHint')}</p>
      </section>
    </div> : <div className="orc-welcome__grid"><section className="orc-welcome__card"><h2>{t('welcome.addRepository')}</h2><p>{t('welcome.noRepos')}</p><button type="button" onClick={() => setRepoHelp(true)}>{t('welcome.openSettings')}</button></section></div>}
    {editing && repo ? <div className="orc-welcome__modal" role="dialog" aria-modal="true" aria-label={t('welcome.recipeTitle')}><form className="orc-welcome__form" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await api.saveRecipe(repo.root, form); if (r.ok) { setRecipe(r.value); setEditing(false) } return r }) }}><h2>{t('welcome.recipeTitle')}</h2><p>{t('welcome.recipeHelp')}</p><label>{t('welcome.setupCommands')}<textarea value={form.setup.map((x) => typeof x === 'string' ? x : `copy: ${x.copy}`).join('\n')} onChange={(e) => setForm({ ...form, setup: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).map((x) => x.startsWith('copy: ') ? { copy: x.slice(6).trim() } : x) })} /></label><label>{t('welcome.unsetEnv')}<input value={form.env.unset.join(', ')} onChange={(e) => setForm({ ...form, env: { unset: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} /></label><label>{t('welcome.baseline')}<input value={form.baseline ?? ''} onChange={(e) => setForm({ ...form, baseline: e.target.value })} /></label><label>{t('welcome.timeout')}<input type="number" min="1" max="3600" value={form.timeoutSec} onChange={(e) => setForm({ ...form, timeoutSec: Number(e.target.value) })} /></label><div><button type="submit" disabled={pending}>{t('welcome.save')}</button><button type="button" onClick={() => setEditing(false)}>{t('welcome.cancel')}</button></div></form></div> : null}
    {specOpen && repo ? <SpecPicker root={repo.root} initial={specOpen} onClose={() => setSpecOpen(null)} onDraft={(id) => { setSpecOpen(null); onDraft(id) }} /> : null}
    {repoHelp ? <div className="orc-welcome__modal" role="dialog" aria-modal="true" aria-label={t('welcome.addRepository')}><div className="orc-welcome__form"><h2>{t('welcome.addRepository')}</h2><p>{t('welcome.noRepos')}</p><button type="button" onClick={() => setRepoHelp(false)}>{t('welcome.cancel')}</button></div></div> : null}
    {error ? <p role="alert" className="orc-error">{error}</p> : null}
  </div>
}
