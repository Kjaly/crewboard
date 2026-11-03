import { useEffect, useState } from 'react'
import type { AgentModel, AgentPreset, AgentsConfig, AgentsConfigView } from '../../workers/agents.js'
import type { CatalogModel } from '../../workers/catalog.js'
import type { Api } from '../api.js'
import { logoOf } from '../logos.js'
import { T } from '../text.js'

type SettingsAgent = AgentsConfigView['agents'][number]

/** Global worker defaults and presets; the raw patches are kept so saving preserves registry metadata. */
export function SettingsView(props: { api: Api; onSaved: () => void }) {
  const [snapshot, setSnapshot] = useState<AgentsConfigView>()
  const [config, setConfig] = useState<AgentsConfig>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  useEffect(() => {
    let active = true
    props.api.agentsConfig().then((next) => {
      if (active) { setSnapshot(next); setConfig(next.config) }
    }, (error: unknown) => { if (active) setError(String(error)) })
    return () => { active = false }
  }, [props.api])

  const reload = async () => {
    setBusy(true)
    setError('')
    try {
      const next = await props.api.agentsConfig()
      setSnapshot(next)
      setConfig(next.config)
      setNotice('')
    } catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }
  const save = async () => {
    if (!config || !snapshot) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const next = await props.api.saveAgentsConfig(config, snapshot.revision)
      if (next === 'conflict') {
        // Discard stale edits and show the actual file. Saving again now requires a new user action.
        const current = await props.api.agentsConfig()
        setSnapshot(current)
        setConfig(current.config)
        setNotice(T.settings.conflict)
      } else {
        setSnapshot(next)
        setConfig(next.config)
        setNotice(T.settings.saved)
        props.onSaved()
      }
    } catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }
  if (!snapshot || !config) return <div className="settings"><p role="status">{error || T.loading}</p>{error && <button type="button" onClick={() => void reload()}>{T.settings.reload}</button>}</div>
  const patchAgent = (id: string, patch: Partial<AgentsConfig['agents'][string]>) => {
    setConfig((current) => current && ({ ...current, agents: { ...current.agents, [id]: { ...current.agents[id], ...patch } } }))
    setNotice('')
  }
  const agents = snapshot.agents.map((a) => ({ ...a, ...config.agents[a.id] }))
  const presets = { ...snapshot.presets, ...config.presets }
  const patchPreset = (id: string, value: AgentPreset | false) => {
    setConfig((current) => current && ({ ...current, presets: { ...current.presets, [id]: value } }))
    setNotice('')
  }
  const dirty = JSON.stringify(config) !== JSON.stringify(snapshot.config)
  const add = () => {
    const id = name.trim()
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || Object.hasOwn(presets, id) || !agents[0]) return
    patchPreset(id, { agent: agents.find((a) => a.enabled)?.id ?? agents[0].id })
    setName('')
  }
  return (
    <section className="settings" role="tabpanel" aria-label={T.tabs.settings}>
      <div className="settings-head">
        <div><h2>{T.tabs.settings}</h2><p>{T.settings.hint}</p></div>
        <div className="settings-buttons">
          <button type="button" disabled={busy} onClick={() => void reload()}>{T.settings.reload}</button>
          <button type="button" className="settings-save" disabled={busy || !dirty} onClick={() => void save()}>{busy ? T.settings.saving : T.settings.save}</button>
        </div>
      </div>
      {notice && <p role="status" className="settings-notice">{notice}</p>}
      {error && <p role="alert" className="settings-error">{T.settings.failed} {error}</p>}
      <fieldset disabled={busy}>
        <legend>{T.settings.agents}</legend>
        <div className="settings-rows">
          {agents.map((a) => {
            const logo = logoOf(a.icon)
            return <div key={a.id} className="settings-row">
              <div className="settings-identity">
                {/* biome-ignore lint/security/noDangerouslySetInnerHtml: bundled provider logos only. */}
                {logo ? <span className="av logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: logo }} /> : <span className="av other" aria-hidden="true">{a.label.charAt(0)}</span>}
                <span><b>{a.label}</b><small>{a.id}</small></span>
              </div>
              <ModelFields agent={a} model={a.model} effort={a.effort} loadModels={props.api.models} onChange={(value) => patchAgent(a.id, value)} />
              <label className="settings-toggle"><input type="checkbox" checked={a.enabled} onChange={(e) => patchAgent(a.id, { enabled: e.target.checked })} />{T.settings.enabled}</label>
            </div>
          })}
        </div>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>{T.settings.presets}</legend>
        <p className="settings-hint">{T.settings.presetsHint}</p>
        <div className="settings-rows">
          {Object.entries(presets).map(([id, preset]) => {
            const value = preset || snapshot.builtinPresets[id] || { agent: agents[0]?.id ?? '' }
            const agent = agents.find((a) => a.id === value.agent)
            return <div key={id} className="settings-row settings-preset">
              <div className="settings-identity"><b className="mono">{id}</b></div>
              <label>{T.settings.agent}<select value={value.agent} onChange={(e) => patchPreset(id, { ...value, agent: e.target.value, model: undefined, effort: undefined })}>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.label}{!a.enabled ? ` · ${T.settings.disabled}` : ''}</option>)}
              </select></label>
              {agent && <ModelFields agent={agent} model={value.model} effort={value.effort} allowDefault loadModels={props.api.models} onChange={({ model, effort, models }) => { patchPreset(id, { ...value, model, effort }); if (models) patchAgent(agent.id, { models }) }} />}
              <label className="settings-toggle"><input type="checkbox" checked={preset !== false} onChange={(e) => patchPreset(id, e.target.checked ? value : false)} />{T.settings.enabled}</label>
              <label className="settings-note">{T.settings.note}<input value={value.note ?? ''} onChange={(e) => patchPreset(id, { ...value, note: e.target.value })} /></label>
            </div>
          })}
        </div>
        <div className="settings-add">
          <label>{T.settings.presetName}<input value={name} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} /></label>
          <button type="button" disabled={!/^[a-z0-9][a-z0-9._-]*$/i.test(name.trim()) || Object.hasOwn(presets, name.trim())} onClick={add}>{T.settings.addPreset}</button>
        </div>
      </fieldset>
    </section>
  )
}

/** The live catalog supplements registry suggestions, including the chosen model's own effort levels. */
function ModelFields(props: { agent: SettingsAgent; model?: string; effort?: string; allowDefault?: boolean; loadModels: Api['models']; onChange: (value: { model?: string; effort?: string; models?: AgentModel[] }) => void }) {
  const { agent, model, effort } = props
  const [catalog, setCatalog] = useState<CatalogModel[]>()
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setCatalog(undefined)
    setFailed(false)
    setLoading(true)
    props.loadModels(agent.id, refresh > 0).then((models) => { if (active) setCatalog(models) }, () => { if (active) setFailed(true) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [agent.id, props.loadModels, refresh])
  const models = [...(catalog ?? agent.models)]
  if (model && !models.some((m) => m.id === model)) models.unshift({ id: model })
  const selected = model ?? agent.model
  const efforts = models.find((m) => m.id === selected)?.efforts ?? agent.efforts
  const registration = (id: string): AgentModel[] | undefined => {
    const pick = models.find((m) => m.id === id)
    if (!pick?.efforts) return undefined
    // Only when the server would check other levels: copying the built-in list into the file would freeze it there.
    const known = agent.models.find((m) => m.id === id)?.efforts ?? agent.efforts
    if (known.length === pick.efforts.length && known.every((e, i) => e === pick.efforts?.[i])) return undefined
    return [...agent.models.filter((m) => m.id !== id), { id: pick.id, label: pick.label, note: pick.note, efforts: pick.efforts }]
  }
  const changeModel = (next: string) => {
    const pick = models.find((m) => m.id === (next || agent.model))
    const levels = pick?.efforts ?? agent.efforts
    // Persist discovered levels so the server validates the same choice the owner just made.
    const registered = registration(next || agent.model)
    props.onChange({ model: next || undefined, effort: effort && levels.includes(effort) ? effort : undefined, ...(registered ? { models: registered } : {}) })
  }
  return <>
    <label className="settings-model">{T.modelLabel}<select value={model ?? ''} onChange={(e) => changeModel(e.target.value)}>
      {props.allowDefault && <option value="">{T.settings.agentDefault}</option>}
      {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
    </select></label>
    <label>{T.effortLabel}<select value={effort ?? ''} onChange={(e) => { const registered = registration(selected); props.onChange({ model, effort: e.target.value || undefined, ...(registered ? { models: registered } : {}) }) }}>
      <option value="">{T.effortDefault}</option>
      {effort && !efforts.includes(effort) && <option value={effort}>{effort}</option>}
      {efforts.map((e) => <option key={e} value={e}>{T.effort[e] ?? e}</option>)}
    </select></label>
    <button type="button" className="settings-refresh" disabled={loading} title={failed ? T.catalogFailed : undefined} onClick={() => setRefresh((n) => n + 1)}>{loading ? T.catalogLoading : failed ? T.settings.retryCatalog : T.catalogRefresh}</button>
  </>
}
