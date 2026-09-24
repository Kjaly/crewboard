import type { Span, Trajectory } from '../../shared/types.js'
import { t } from '../i18n.js'

/** The arithmetic behind the trace lanes: raw spans → steps → what is drawable at this width. */

export type TraceLane = 'input' | 'model' | 'tools' | 'watch'
export type StepKind = 'input' | 'model' | 'read' | 'edit' | 'cmd' | 'tool' | 'problem'
export type Step = { key: string; lane: TraceLane; kind: StepKind; label: string; start: number; end: number; approximate?: boolean }
/** Marks closer than 20 px collapse into one entity that carries all of them. */
export type Entity = { key: string; lane: TraceLane; start: number; steps: Step[] }

export const KIND_NAME: Record<StepKind, string> = {
  get input() { return t('panel.trace.step.input') },
  get model() { return t('panel.trace.step.model') },
  get read() { return t('panel.trace.step.read') },
  get edit() { return t('panel.trace.step.edit') },
  get cmd() { return t('panel.trace.step.cmd') },
  get tool() { return t('panel.trace.step.tool') },
  get problem() { return t('panel.trace.step.problem') },
}

const MIN_MARK_GAP_PX = 20
const TRACK_PX = 880

/**
 * The colour of a tool step is its action type, and `Span` only carries the label the normalizer built:
 * `Read <file>` for reads, a bare file name for edits, a command line for shell work.
 */
export function spanKind(label: string): StepKind {
  if (/^Read\s/.test(label)) return 'read'
  if (/\s/.test(label)) return 'cmd'
  if (/\.[a-z0-9]+$/i.test(label)) return 'edit'
  return 'tool'
}

const laneOf = (span: Span): TraceLane => (span.lane === 'problem' ? 'watch' : span.lane)

export function toSteps(trace: Trajectory): Step[] {
  return trace.spans
    .map((span, i): Step => {
      const lane = laneOf(span)
      const kind: StepKind = lane === 'input' ? 'input' : lane === 'watch' ? 'problem' : lane === 'model' ? 'model' : spanKind(span.label)
      return {
        key: `s${i}`,
        lane,
        kind,
        label: span.label || KIND_NAME[kind],
        start: span.start,
        end: span.end,
        ...(span.approximate ? { approximate: true } : {}),
      }
    })
    .sort((a, b) => a.start - b.start)
}

/** Bars stay separate; zero-length marks on the same lane merge while they would overlap on screen. */
export function toEntities(steps: Step[], start: number, end: number, trackPx = TRACK_PX): Entity[] {
  const span = Math.max(1, end - start)
  const px = (ms: number) => ((ms - start) / span) * trackPx
  const out: Entity[] = []
  for (const step of steps) {
    const isMark = step.end <= step.start
    const last = out.at(-1)
    const mergeable =
      isMark &&
      last !== undefined &&
      last.lane === step.lane &&
      last.steps.every((s) => s.end <= s.start) &&
      px(step.start) - px(last.start) < MIN_MARK_GAP_PX
    if (mergeable && last) last.steps.push(step)
    else out.push({ key: step.key, lane: step.lane, start: step.start, steps: [step] })
  }
  return out.sort((a, b) => a.start - b.start)
}

export const offset = (ms: number, start: number): string => {
  const sec = Math.max(0, Math.round((ms - start) / 1000))
  return `+${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}
