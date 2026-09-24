import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { t } from './i18n.js'

/** Mirrors core's SPEC_EXTENSIONS / MAX_SPEC_BYTES (the host checks again): the draft pipeline reads text only. */
export const SPEC_TYPES = ['.md', '.markdown', '.txt', '.rst'] as const
export const MAX_SPEC_BYTES = 256 * 1024
export type SpecMode = 'file' | 'paste' | 'repo'
type Picked = { name: string; text: string; size: number }

const typeOf = (name: string) => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot).toLowerCase() : '' }
const kib = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`

/** Reads a dropped or chosen file, refusing what the draft pipeline cannot read before anything is sent. */
export async function readSpecFile(file: File): Promise<{ ok: true; picked: Picked } | { ok: false; error: string }> {
  if (!(SPEC_TYPES as readonly string[]).includes(typeOf(file.name))) return { ok: false, error: t('welcome.specUnsupported', { types: SPEC_TYPES.join(', ') }) }
  if (file.size > MAX_SPEC_BYTES) return { ok: false, error: t('welcome.specTooLarge', { size: kib(file.size), limit: kib(MAX_SPEC_BYTES) }) }
  const text = await file.text()
  if (!text.trim()) return { ok: false, error: t('welcome.specEmpty') }
  return { ok: true, picked: { name: file.name, text, size: file.size } }
}

function errorText(result: { error: string; message?: string }): string {
  if (result.error === 'too_large') return t('welcome.specOverLimit', { limit: kib(MAX_SPEC_BYTES) })
  if (result.error === 'unsupported_type') return t('welcome.specUnsupported', { types: SPEC_TYPES.join(', ') })
  if (result.error === 'empty') return t('welcome.specEmpty')
  if (result.error === 'bad_name') return t('welcome.specBadName')
  return result.message ?? result.error
}

export function SpecPicker({ root, initial, onDraft, onClose }: { root: string; initial?: { mode: SpecMode; file?: File }; onDraft(jobId: string): void; onClose(): void }) {
  const [mode, setMode] = useState<SpecMode>(initial?.mode ?? 'file')
  const [picked, setPicked] = useState<Picked | null>(null)
  const [pasted, setPasted] = useState('')
  const [specs, setSpecs] = useState<string[] | null>(null)
  const [query, setQuery] = useState('')
  const [spec, setSpec] = useState('')
  const [dragging, setDragging] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const pick = async (file: File | undefined) => {
    if (!file) return
    setError('')
    const result = await readSpecFile(file)
    if (result.ok) setPicked(result.picked)
    else { setPicked(null); setError(result.error) }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: A file dropped on the card is read once, when the picker opens.
  useEffect(() => { if (initial?.file) void pick(initial.file) }, [])
  useEffect(() => {
    if (mode !== 'repo' || specs) return
    let live = true
    void api.specFiles(root).then((r) => { if (live) { const files = r.ok && Array.isArray(r.value) ? r.value : []; setSpecs(files); setSpec((old) => old || files[0] || '') } }).catch(() => { if (live) setSpecs([]) })
    return () => { live = false }
  }, [mode, root, specs])
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !pending) { event.stopPropagation(); onClose() } }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose, pending])
  const matches = (specs ?? []).filter((file) => file.toLowerCase().includes(query.trim().toLowerCase()))
  const pastedBytes = new Blob([pasted]).size
  const ready = !pending && (mode === 'file' ? !!picked : mode === 'paste' ? !!pasted.trim() && pastedBytes <= MAX_SPEC_BYTES : !!spec && matches.includes(spec))
  const submit = async () => {
    if (!ready) return
    setPending(true); setError('')
    try {
      const result = mode === 'repo' ? await api.draftFrom(root, spec) : await api.specUpload(root, mode === 'file' && picked ? { name: picked.name, text: picked.text } : { text: pasted })
      if (result.ok) onDraft(result.value.job.id)
      else setError(errorText(result))
    } catch { setError(t('welcome.error')) }
    finally { setPending(false) }
  }
  const tab = (id: SpecMode, label: string) => <button type="button" role="tab" aria-selected={mode === id} className="orc-spec__tab" onClick={() => { setMode(id); setError('') }}>{label}</button>
  return <div className="orc-welcome__modal" role="dialog" aria-modal="true" aria-label={t('welcome.pickSpec')}>
    <form className="orc-welcome__form orc-spec" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <h2>{t('welcome.pickSpec')}</h2>
      <div className="orc-spec__tabs" role="tablist" aria-label={t('welcome.pickSpec')}>{tab('file', t('welcome.specFromDisk'))}{tab('paste', t('welcome.specPaste'))}{tab('repo', t('welcome.specFromRepo'))}</div>
      {mode === 'file' ? /* biome-ignore lint/a11y/noStaticElementInteractions: The zone only receives dragged files; the button inside is the keyboard path. */ <div
        className={`orc-spec__drop${dragging ? ' orc-spec__drop--over' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); void pick(event.dataTransfer.files[0]) }}
      >
        <input ref={input} type="file" accept={SPEC_TYPES.join(',')} hidden onChange={(event) => { void pick(event.target.files?.[0]); event.target.value = '' }} aria-label={t('welcome.specChoose')} />
        <p>{picked ? t('welcome.specPicked', { name: picked.name, size: kib(picked.size) }) : t('welcome.specDrop')}</p>
        <button type="button" onClick={() => input.current?.click()}>{picked ? t('welcome.specChooseOther') : t('welcome.specChoose')}</button>
        <p className="orc-welcome__hint">{t('welcome.specTypes', { types: SPEC_TYPES.join(', '), limit: kib(MAX_SPEC_BYTES) })}</p>
      </div> : null}
      {mode === 'paste' ? <label>{t('welcome.specPasteLabel')}<textarea className="orc-spec__paste" value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder={t('welcome.specPastePlaceholder')} />
        <span className={pastedBytes > MAX_SPEC_BYTES ? 'orc-error' : 'orc-welcome__hint'}>{pastedBytes > MAX_SPEC_BYTES ? t('welcome.specTooLarge', { size: kib(pastedBytes), limit: kib(MAX_SPEC_BYTES) }) : t('welcome.specSavedTo')}</span></label> : null}
      {mode === 'repo' ? specs === null ? <p>{t('welcome.checking')}</p> : specs.length ? <>
        <label>{t('welcome.specSearch')}<input type="search" value={query} onChange={(event) => {
          const next = event.target.value
          setQuery(next)
          // Keep the selection on a visible file, so the button drafts what the list shows.
          const visible = specs.filter((file) => file.toLowerCase().includes(next.trim().toLowerCase()))
          if (!visible.includes(spec)) setSpec(visible[0] ?? '')
        }} placeholder={t('welcome.specSearchPlaceholder')} /></label>
        {matches.length ? <select aria-label={t('welcome.pickSpec')} size={Math.min(8, Math.max(3, matches.length))} value={spec} onChange={(event) => setSpec(event.target.value)}>{matches.map((file) => <option key={file} value={file}>{file}</option>)}</select> : <p className="orc-welcome__hint">{t('welcome.specNoMatch')}</p>}
      </> : <p>{t('welcome.noSpecs')}</p> : null}
      {error ? <p role="alert" className="orc-error">{error}</p> : null}
      <div><button type="submit" className="orc-spec__submit" disabled={!ready}>{pending ? t('welcome.specSaving') : t('welcome.draft')}</button><button type="button" onClick={onClose}>{t('welcome.cancel')}</button></div>
    </form>
  </div>
}
