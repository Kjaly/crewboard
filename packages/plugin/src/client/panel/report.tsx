import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { TaskDetail, TaskSnapshot } from '../../shared/types.js'
import { t, useLang } from '../i18n.js'
/** Keep in sync with core's RISK_WORDS; the core entry point contains Node-only modules. */
const RISK_WORDS = ['\u043d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c', '\u0437\u0430\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u043d', '\u043e\u0442\u043a\u043b\u043e\u043d\u0435\u043d\u0438\u0435', '\u043d\u0435 \u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d\u043e'] as const
import type { TabKey } from './tabs.js'

const PREVIEW_LINES = 3
const UL_ITEM = /^\s*[-*]\s+/
const OL_ITEM = /^\s*\d+[.)]\s+/
const ITEM = /^\s*(?:[-*]|\d+[.)])\s+/
/** A markdown heading: `## Checks` is a section title, never literal text. */
const HEADING = /^#{1,6}\s+/
/** A task-list mark at the start of an item: `[x]` done, `[ ]` open. */
const TICK = /^\[([ xX])\]\s+/
/** A deviation-journal path the contract names, if any. */

/** The card earns its place on review and after acceptance; a failed task keeps the last good report. */
export function reportVisible(task: TaskSnapshot, detail: TaskDetail): boolean {
  if (!detail.report?.text.trim()) return false
  // A prepared decision (rt1) is read before it is closed: its report is the case for the options.
  if (task.kind === 'decision' && detail.report.source === 'orchestrator') return true
  return task.status === 'in_review' || task.status === 'accepted' || task.status === 'closed' || task.lastOutcome === 'failed'
}

/** First line of a report for list rows — the markdown stripped back to plain text. */
export function reportLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  return line.replace(HEADING, '').replace(ITEM, '').replace(TICK, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1').trim()
}

/** Inline marks only: `code` and **bold** — everything else is literal text, never HTML. */
function inline(text: string, ns: string): ReactNode[] {
  const out: ReactNode[] = []
  text.split('`').forEach((seg, i) => {
    if (i % 2 === 1) {
      out.push(<code key={`${ns}c${i}`}>{seg}</code>)
      return
    }
    seg.split('**').forEach((part, j) => {
      if (!part) return
      out.push(j % 2 === 1 ? <strong key={`${ns}b${i}-${j}`}>{part}</strong> : part)
    })
  })
  return out
}

type ReportLine = { text: string; index: number; depth?: number }
type Block = { list: 'ul' | 'ol'; items: ReportLine[] } | { lines: ReportLine[] } | { heading: ReportLine }

/** Headings, paragraphs and bullet/numbered lists: a blank line, a heading or a marker change ends the block in progress. */
function parseBlocks(text: string): Block[] {
  const out: Block[] = []
  let list: { list: 'ul' | 'ol'; items: ReportLine[] } | null = null
  let para: ReportLine[] | null = null
  const flush = () => {
    if (list) out.push(list)
    if (para?.length) out.push({ lines: para })
    list = null
    para = null
  }
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    if (HEADING.test(line)) {
      flush()
      out.push({ heading: { text: line.replace(HEADING, ''), index } })
      continue
    }
    const kind = UL_ITEM.test(line) ? 'ul' : OL_ITEM.test(line) ? 'ol' : null
    if (kind) {
      if (para || (list && list.list !== kind)) flush()
      list ??= { list: kind, items: [] }
      list.items.push({ text: line.replace(ITEM, ''), index, depth: Math.floor((raw.length - raw.trimStart().length) / 2) })
    } else {
      if (list) flush()
      para ??= []
      para.push({ text: line, index })
    }
  }
  flush()
  return out
}

function Blocks({ text, markedLine }: { text: string; markedLine: number | null }) {
  const risky = (line: string) => RISK_WORDS.some((word) => line.toLocaleLowerCase('ru').includes(word))
  const marked = (line: ReportLine, key: string) => {
    const tick = TICK.exec(line.text)
    const text = tick ? line.text.replace(TICK, '') : line.text
    return <span key={key} data-report-line={line.index} className={`${risky(text) ? 'orc-report__risk ' : ''}${markedLine === line.index ? 'orc-report__pointer' : ''}`}>{tick ? <span className="orc-report__tick" aria-hidden="true">{tick[1] === ' ' ? '☐ ' : '☑ '}</span> : null}{inline(text, key)}</span>
  }
  return (
    <>
      {parseBlocks(text).map((block, i) =>
        'heading' in block ? (
          <h4 key={i} className="orc-report__heading">{marked(block.heading, `${i}`)}</h4>
        ) : 'items' in block ? (
          block.list === 'ul' ? (
            <ul key={i} className="orc-report__list">
              {block.items.map((item, j) => (
                <li key={j} style={{ marginLeft: `${(item.depth ?? 0) * 18}px` }}>{marked(item, `${i}-${j}`)}</li>
              ))}
            </ul>
          ) : (
            <ol key={i} className="orc-report__list">
              {block.items.map((item, j) => (
                <li key={j} style={{ marginLeft: `${(item.depth ?? 0) * 18}px` }}>{marked(item, `${i}-${j}`)}</li>
              ))}
            </ol>
          )
        ) : (
          <p key={i} className="orc-report__p">
            {block.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 ? ' ' : ''}
                {marked(line, `${i}-${j}`)}
              </Fragment>
            ))}
          </p>
        ),
      )}
    </>
  )
}

/**
 * The worker's own report above the raw feed. Open while the task waits for
 * acceptance or after a failure; folded to three lines once accepted, where it is history.
 */
export function ReportCard({ task, detail, onTab, jump }: { task: TaskSnapshot; detail: TaskDetail; onTab(tab: TabKey): void; jump?: { line: number; seq: number } | null }) {
  useLang()
  const [open, setOpen] = useState(task.status !== 'accepted')
  const [markedLine, setMarkedLine] = useState<number | null>(null)
  const region = useRef<HTMLElement>(null)
  const report = detail.report
  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    if (jump) setOpen(true)
  }, [jump?.seq])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    if (!jump || !open) return
    const target = region.current?.querySelector<HTMLElement>(`[data-report-line="${jump.line}"]`)
    if (!target) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    target.scrollIntoView?.({ behavior: reduced ? 'instant' : 'smooth', block: 'center' })
    setMarkedLine(jump.line)
    const timer = window.setTimeout(() => setMarkedLine(null), 1800)
    return () => window.clearTimeout(timer)
  }, [jump?.seq, open])
  if (!reportVisible(task, detail) || !report) return null

  const lines = report.text.split('\n')
  const title = report.source === 'orchestrator' ? t('report.orchestratorTitle') : t('report.title')
  const foldable = lines.length > PREVIEW_LINES
  const folded = foldable && !open

  return (
    <section ref={region} className="orc-sec" aria-label={title}>
      <div className="orc-report">
        <header className="orc-report__head">
          {foldable ? (
            <button type="button" className="orc-disclose" aria-expanded={open} onClick={() => setOpen(!open)}>
              <span className="orc-disclose__mark" aria-hidden="true">
                ▸
              </span>
              {title}
            </button>
          ) : (
            <span className="orc-report__title">{title}</span>
          )}
        </header>
        {RISK_WORDS.some((word) => report.text.toLocaleLowerCase('ru').includes(word)) ? <p className="orc-report__risk-note">{t('report.riskNote')}</p> : null}
        <div className="orc-report__body">
          <Blocks text={folded ? lines.slice(0, PREVIEW_LINES).join('\n') : report.text} markedLine={markedLine} />
        </div>
        {report.source === 'final' ? (
          <p className="orc-report__note">{t('report.finalNote')}</p>
        ) : null}
        {report.truncated ? <button type="button" className="orc-report__link" onClick={() => onTab('activity')}>{t('report.showAll')}</button> : null}
      </div>
    </section>
  )
}
