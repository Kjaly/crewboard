import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { t } from '../i18n.js'

declare global { interface Window {
  __orchRenderDxf?: (text: string, notShown?: string) => string
  __orchStructured?: { renderJson: (root: Element, text: string) => void; renderMarkdown: (root: Element, text: string) => void }
} }
let dxfReady: Promise<void> | undefined
function loadDxf(): Promise<void> {
  if (window.__orchRenderDxf) return Promise.resolve()
  dxfReady ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/crewboard/assets/preview-dxf.js'
    script.onload = () => window.__orchRenderDxf ? resolve() : reject(new Error('DXF renderer unavailable'))
    script.onerror = () => reject(new Error('DXF renderer unavailable'))
    document.head.append(script)
  })
  return dxfReady
}
let structuredReady: Promise<void> | undefined
function loadStructured(): Promise<void> {
  if (window.__orchStructured) return Promise.resolve()
  structuredReady ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/crewboard/assets/preview-structured.js'
    script.onload = () => window.__orchStructured ? resolve() : reject(new Error('Renderer unavailable'))
    script.onerror = () => reject(new Error('Renderer unavailable'))
    document.head.append(script)
  })
  return structuredReady
}

export type PreviewKind = 'image' | 'video' | 'pdf' | 'html' | 'markdown' | 'csv' | 'json' | 'yaml' | 'dxf' | 'font' | 'text' | 'diff'
export function previewKind(file: string): PreviewKind {
  const ext = file.split('.').at(-1)?.toLowerCase()
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'avif'].includes(ext ?? '')) return 'image'
  if (['mp4', 'webm', 'mov'].includes(ext ?? '')) return 'video'
  if (ext === 'pdf') return 'pdf'
  if (['html', 'htm'].includes(ext ?? '')) return 'html'
  if (ext === 'md') return 'markdown'
  if (['csv', 'tsv'].includes(ext ?? '')) return 'csv'
  if (ext === 'json') return 'json'
  if (['yaml', 'yml'].includes(ext ?? '')) return 'yaml'
  if (ext === 'dxf') return 'dxf'
  if (['woff2', 'woff', 'ttf', 'otf'].includes(ext ?? '')) return 'font'
  if (['txt', 'log'].includes(ext ?? '')) return 'text'
  return 'diff'
}

export function parseDelimited(input: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') { field += '"'; i++ }
      else if (!field || quoted) quoted = !quoted
      else field += ch
    } else if (ch === delimiter && !quoted) { row.push(field); field = '' }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && input[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += ch
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

type Props = { repo: string; id: string; file: string; expanded?: boolean }
type SideState = { url: string; text?: string; bytes: number; error?: string }

function FileSide({ kind, side, state, expanded, delimiter }: { kind: PreviewKind; side: 'before' | 'after'; state: SideState; expanded?: boolean; delimiter: string }) {
  const [fit, setFit] = useState(true)
  const [dimensions, setDimensions] = useState('')
  const [font, setFont] = useState('')
  useEffect(() => {
    if (kind !== 'font' || state.error) return
    const face = new FontFace('orch-preview-font-' + side, 'url(' + state.url + ')')
    face.load().then((loaded) => { document.fonts.add(loaded); setFont(loaded.family) }).catch(() => {})
    return () => { document.fonts.delete(face) }
  }, [kind, side, state.url, state.error])
  if (state.error) return <p className="orc-meta">{state.error}</p>
  const label = side === 'before' ? t('panel.preview.before') : t('panel.preview.after')
  const text = state.text ?? ''
  return <section className="orc-preview-side">
    <header>{label} · {(state.bytes / 1024).toFixed(1)} KB {dimensions ? ' · ' + dimensions : ''}</header>
    {kind === 'image' ? <button type="button" className="orc-preview-checker" onClick={() => setFit(!fit)} title={t('panel.preview.zoom')}><img src={state.url} alt={label} style={{ maxWidth: fit ? '100%' : 'none', maxHeight: fit ? expanded ? '75vh' : 400 : 'none' }} onLoad={(e) => setDimensions(e.currentTarget.naturalWidth + ' × ' + e.currentTarget.naturalHeight)} /></button> : null}
    {kind === 'video' ? /* biome-ignore lint/a11y/useMediaCaption: The preview shows user supplied media without an available caption track. */ <video src={state.url} controls preload="metadata" style={{ maxWidth: '100%' }} /> : null}
    {kind === 'pdf' ? <><iframe src={state.url} title={label} className="orc-preview-frame" /><a href={state.url} target="_blank" rel="noreferrer">{t('panel.preview.newTab')}</a></> : null}
    {kind === 'html' ? <><p className="orc-meta">{t('panel.preview.sandbox')}</p><iframe src={state.url} title={label} sandbox="allow-scripts" className="orc-preview-frame" /></> : null}
    {kind === 'csv' ? <CsvView text={text} delimiter={delimiter} /> : null}
    {kind === 'json' || kind === 'markdown' ? <StructuredView kind={kind} text={text} /> : null}
    {kind === 'dxf' ? <DxfView text={text} /> : null}
    {kind === 'font' ? <p className="orc-preview-font" style={{ fontFamily: font || 'inherit' }}>{t('panel.preview.fontSample')}</p> : null}
    {kind === 'yaml' ? <YamlView text={text} /> : null}
    {kind === 'text' ? <pre className="orc-code orc-preview-lines">{text.slice(0, 200 * 1024).split('\n').map((line, index) => <div key={index}><span>{index + 1}</span>{line || ' '}</div>)}</pre> : null}
  </section>
}

function CsvView({ text, delimiter }: { text: string; delimiter: string }) {
  const rows = parseDelimited(text, delimiter)
  return <><p className="orc-meta">{t('panel.preview.rows', { count: Math.max(0, rows.length - 1) })}</p><div className="orc-preview-table"><table><thead><tr>{rows[0]?.map((cell, i) => <th key={i}>{cell}</th>)}</tr></thead><tbody>{rows.slice(1, 501).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div></>
}

function YamlView({ text }: { text: string }) {
  return <pre className="orc-code orc-preview-lines">{text.slice(0, 200 * 1024).split('\n').map((line, index) => {
    const key = /^(\s*(?:-\s*)?[^:#]+:)(.*)$/.exec(line)
    return <div key={index}><span>{index + 1}</span>{line.trimStart().startsWith('#') ? <em className="orc-preview-comment">{line}</em> : key ? <><b className="orc-preview-key">{key[1]}</b>{key[2]}</> : line || ' '}</div>
  })}</pre>
}

function StructuredView({ kind, text }: { kind: 'json' | 'markdown'; text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    loadStructured().then(() => {
      if (!alive || !ref.current) return
      window.__orchStructured![kind === 'json' ? 'renderJson' : 'renderMarkdown'](ref.current, text)
    }).catch(() => { if (alive && ref.current) ref.current.textContent = t('panel.preview.unavailable') })
    return () => { alive = false }
  }, [kind, text])
  return <div ref={ref} className={kind === 'json' ? 'orc-preview-tree' : 'orc-preview-markdown'} />
}

function DxfView({ text }: { text: string }) {
  const [svg, setSvg] = useState('')
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [drag, setDrag] = useState<{ x: number; y: number; left: number; top: number } | null>(null)
  useEffect(() => {
    let alive = true
    loadDxf().then(() => { if (alive) setSvg(window.__orchRenderDxf!(text, t('panel.preview.entitiesNotShown'))) }).catch(() => { if (alive) setSvg('') })
    return () => { alive = false }
  }, [text])
  return /* biome-ignore lint/a11y/noStaticElementInteractions: This wrapper handles delegated pointer or keyboard events for its child controls. */ <div className="orc-preview-dxf" onWheel={(event) => { event.preventDefault(); setScale((value) => Math.max(0.2, Math.min(10, value * (event.deltaY < 0 ? 1.15 : 1 / 1.15)))) }}
    onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDrag({ x: event.clientX, y: event.clientY, left: offset.x, top: offset.y }) }}
    onPointerMove={(event) => { if (drag) setOffset({ x: drag.left + event.clientX - drag.x, y: drag.top + event.clientY - drag.y }) }}
    onPointerUp={() => setDrag(null)} onDoubleClick={() => { setScale(1); setOffset({ x: 0, y: 0 }) }}>
    {/* biome-ignore lint/security/noDangerouslySetInnerHtml: The DXF renderer escapes source text before constructing this SVG. */} <div style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transformOrigin: 'center' }} dangerouslySetInnerHTML={{ __html: svg }} />
  </div>
}

export function FilePreview({ repo, id, file, expanded }: Props) {
  const kind = previewKind(file)
  const [sides, setSides] = useState<Partial<Record<'before' | 'after', SideState>>>({})
  const [compare, setCompare] = useState<'sides' | 'overlay'>('sides')
  const [markdownSide, setMarkdownSide] = useState<'before' | 'after'>('after')
  useEffect(() => {
    let alive = true
    const urls: string[] = []
    setSides({})
    setCompare('sides')
    setMarkdownSide('after')
    for (const side of ['before', 'after'] as const) {
      const route = api.fileUrl(repo, id, file, side)
      fetch(route).then(async (response) => {
        if (!response.ok) {
          const result = await response.json().catch(() => ({})) as { error?: string }
          if (alive) setSides((prev) => ({ ...prev, [side]: { url: '', bytes: 0, error: result.error === 'no_before' ? 'no_before' : result.error === 'unavailable' ? t('panel.preview.cleaned') : result.error === 'too_large' ? t('panel.preview.tooLarge') : t('panel.preview.unavailable') } }))
          return
        }
        const blob = await response.blob()
        // Frames need the route response so its CSP sandbox applies to the document.
        const url = kind === 'html' || kind === 'pdf' ? route : URL.createObjectURL(blob)
        if (url !== route) urls.push(url)
        const needsText = ['markdown', 'csv', 'json', 'yaml', 'dxf', 'text'].includes(kind)
        const text = needsText ? await blob.text() : undefined
        if (alive) setSides((prev) => ({ ...prev, [side]: { url, bytes: blob.size, text } }))
      }).catch(() => { if (alive) setSides((prev) => ({ ...prev, [side]: { url: '', bytes: 0, error: t('panel.preview.unavailable') } })) })
    }
    return () => { alive = false; urls.forEach((url) => { URL.revokeObjectURL(url) }) }
  }, [repo, id, file, kind])
  const before = sides.before, after = sides.after
  const hasBefore = before && before.error !== 'no_before'
  return <div className={'orc-preview' + (expanded ? ' orc-preview--expanded' : '')}>
    {kind === 'markdown' && hasBefore && !before?.error ? <div className="orc-preview-controls">
      <button type="button" aria-pressed={markdownSide === 'before'} onClick={() => setMarkdownSide('before')}>{t('panel.preview.before')}</button>
      <button type="button" aria-pressed={markdownSide === 'after'} onClick={() => setMarkdownSide('after')}>{t('panel.preview.after')}</button>
    </div> : null}
    {kind === 'image' && hasBefore && !before.error && !after?.error ? <div className="orc-preview-controls"><button type="button" onClick={() => setCompare(compare === 'sides' ? 'overlay' : 'sides')}>{compare === 'sides' ? t('panel.preview.overlay') : t('panel.preview.sideBySide')}</button></div> : null}
    <div className={'orc-preview-pair' + (compare === 'overlay' ? ' orc-preview-pair--overlay' : '')}>
      {hasBefore && before && (kind !== 'markdown' || markdownSide === 'before') ? <FileSide kind={kind} side="before" state={before} expanded={expanded} delimiter={file.toLowerCase().endsWith('.tsv') ? '\t' : ','} /> : null}
      {after && (kind !== 'markdown' || markdownSide === 'after') ? <FileSide kind={kind} side="after" state={after} expanded={expanded} delimiter={file.toLowerCase().endsWith('.tsv') ? '\t' : ','} /> : !after ? <p className="orc-meta">{t('panel.preview.loading')}</p> : null}
    </div>
    {compare === 'overlay' && hasBefore && !before?.error && !after?.error ? <input aria-label={t('panel.preview.slider')} type="range" min="0" max="100" onChange={(e) => { const pair = e.currentTarget.previousElementSibling as HTMLElement; pair.style.setProperty('--orc-reveal', e.target.value + '%') }} /> : null}
  </div>
}
