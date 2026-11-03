import { type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ProviderId } from '../../model/types.js'
import { AGENTS, choicesOf } from '../agents.js'
import type { HandoffPick } from '../api.js'
import { ArrowCounterClockwise, CaretDown, Plus } from '../icons.js'
import { T, providerLabel } from '../text.js'
import { Avatar } from './badges.js'

type Value = { model?: string; effort?: string }

const effortName = (effort: string): string => T.effort[effort] ?? effort
const lower = (text: string): string => text.toLocaleLowerCase(T.locale)

/** The handover: one row per agent with a chip for its model and effort; the chip opens the popover that sets both. */
export function Handoff(props: { from: ProviderId; fromModel?: string; fromEffort?: string; sending: boolean; onSend: (provider: ProviderId, pick: HandoffPick) => void }) {
  const [selected, setSelected] = useState<string>()
  const [edited, setEdited] = useState<Record<string, Value>>({})
  const [popFor, setPopFor] = useState<string>()
  const [pos, setPos] = useState({ top: 0, right: 0 })
  const host = useRef<HTMLDivElement>(null)
  const chips = useRef<Record<string, HTMLButtonElement | null>>({})

  // The agent doing the work starts from what it runs with now; the others from their defaults.
  const start = (id: string): Value => {
    const d = choicesOf(id)
    const model = id === props.from ? (props.fromModel ?? d.defaultModel) : d.defaultModel
    const effort = id === props.from ? (props.fromEffort ?? d.defaultEffort) : d.defaultEffort
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
  }
  const current = (id: string): Value => edited[id] ?? start(id)
  // Handing work to the agent already doing it only makes sense with another model or effort.
  const unchanged = (id: string): boolean => id === props.from && current(id).model === start(id).model && current(id).effort === start(id).effort
  const change = (id: string, patch: Value) => setEdited((all) => ({ ...all, [id]: { ...current(id), ...patch } }))
  const reset = (id: string) =>
    setEdited((all) => {
      const { [id]: _dropped, ...rest } = all
      return rest
    })
  const modelName = (id: string, model?: string): string => (model ? (choicesOf(id).models.find((m) => m.id === model)?.label ?? model) : T.defaultModel)
  const describe = (id: string): string => {
    const v = current(id)
    return `${modelName(id, v.model)}${v.effort ? `, ${lower(effortName(v.effort))}` : ''}`
  }

  // The popover follows its chip: place it on open and again whenever the panel scrolls or changes size.
  useLayoutEffect(() => {
    if (!popFor) return
    const place = () => {
      const chip = chips.current[popFor]
      const box = host.current
      if (!chip || !box) return
      const h = box.getBoundingClientRect()
      const c = chip.getBoundingClientRect()
      const top = c.bottom - h.top + 6
      const right = h.right - c.right
      setPos((have) => (have.top === top && have.right === right ? have : { top, right }))
    }
    place()
    window.addEventListener('resize', place)
    // Scroll does not bubble: the capture phase hears the panel and any scrolling ancestor.
    document.addEventListener('scroll', place, true)
    const watcher = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : undefined
    if (host.current) watcher?.observe(host.current)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
      watcher?.disconnect()
    }
  }, [popFor])

  const closePop = (focusChip: boolean) => {
    const id = popFor
    setPopFor(undefined)
    if (focusChip && id) chips.current[id]?.focus()
  }

  const ids = [props.from, ...AGENTS.map((a) => a.id).filter((id) => id !== props.from)].filter((id) => AGENTS.some((a) => a.id === id))
  return (
    <div className="na-agents-host" ref={host}>
      <div className="na-agents" role="radiogroup" aria-label={T.handoffTo}>
        {ids.map((id) => {
          const checked = selected === id
          const v = current(id)
          return (
            // The row is a mouse shortcut for the radio button inside it, which holds the keyboard path.
            // biome-ignore lint/a11y/useKeyWithClickEvents: the radio button inside carries the keyboard.
            // biome-ignore lint/a11y/noStaticElementInteractions: see above.
            <div key={id} className="na-ag" data-checked={checked} onClick={() => { setSelected(id); if (popFor && popFor !== id) setPopFor(undefined) }}>
              {/* biome-ignore lint/a11y/useSemanticElements: a button row holding a logo and a chip beside it; a native radio cannot. */}
              <button type="button" role="radio" aria-checked={checked} className="na-ag-main" disabled={props.sending}>
                <Avatar provider={id} />
                <span>{providerLabel(id)}</span>
                {id === props.from && <span className="na-now">{T.handoffCurrent}</span>}
              </button>
              <button
                type="button"
                className="na-chip"
                ref={(el) => {
                  chips.current[id] = el
                }}
                aria-haspopup="dialog"
                aria-expanded={popFor === id}
                disabled={props.sending}
                onClick={(e) => {
                  e.stopPropagation()
                  setSelected(id)
                  setPopFor(popFor === id ? undefined : id)
                }}
              >
                <span>
                  {modelName(id, v.model)}
                  {v.effort && <span className="e"> {lower(effortName(v.effort))}</span>}
                </span>
                <CaretDown size={11} aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
      {selected && (
        <div className="na-foot">
          <span>{unchanged(selected) ? T.handoffSame : `${providerLabel(selected)}, ${describe(selected)}`}</span>
          <button type="button" className="na-send" disabled={props.sending || unchanged(selected)} onClick={() => props.onSend(selected, current(selected))}>
            {T.handoffSend}
          </button>
        </div>
      )}
      {popFor && <Popover id={popFor} value={current(popFor)} pos={pos} modelName={modelName} onChange={(patch) => change(popFor, patch)} onReset={() => reset(popFor)} onClose={closePop} />}
    </div>
  )
}

function Popover(props: {
  id: string
  value: Value
  pos: { top: number; right: number }
  modelName: (id: string, model?: string) => string
  onChange: (patch: Value) => void
  onReset: () => void
  onClose: (focusChip: boolean) => void
}) {
  const { id, value } = props
  const choices = choicesOf(id)
  const root = useRef<HTMLDivElement>(null)
  const custom = useRef<HTMLInputElement>(null)
  const models = value.model && !choices.models.some((m) => m.id === value.model) ? [...choices.models, { id: value.model, label: value.model }] : choices.models

  useEffect(() => {
    const el = root.current
    const first = el?.querySelector<HTMLElement>('[aria-selected=true]') ?? el?.querySelector<HTMLElement>('[role=option]') ?? custom.current
    first?.focus()
  }, [])
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (root.current && !root.current.contains(target) && !target?.closest('.na-chip')) props.onClose(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  })

  const keys = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      return props.onClose(true)
    }
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return
    const pick = models[Number(e.key) - 1]
    if (pick && /^[1-9]$/.test(e.key)) props.onChange({ model: pick.id })
  }
  // Focus moving to something outside the popover (not its own chip, which toggles it) closes it.
  const leave = (e: ReactFocusEvent) => {
    const to = e.relatedTarget as Element | null
    if (to && !e.currentTarget.contains(to) && !to.closest('.na-chip')) props.onClose(false)
  }
  const commitCustom = () => {
    const text = custom.current?.value.trim()
    if (!text || !custom.current) return
    props.onChange({ model: text })
    custom.current.value = ''
  }

  const { efforts } = choices
  const index = value.effort ? efforts.indexOf(value.effort) : -1
  const setEffort = (i: number) => {
    const next = efforts[Math.max(0, Math.min(efforts.length - 1, i))]
    if (next && next !== value.effort) props.onChange({ effort: next })
  }
  const meterKeys = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setEffort(index + 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setEffort(index - 1)
    else return
    e.preventDefault()
  }
  const dragging = useRef(false)
  const at = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    if (r.width > 0) setEffort(Math.floor(((e.clientX - r.left) / r.width) * efforts.length))
  }

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: keys 1-9 and Esc act inside the dialog, where the focus is.
    <div ref={root} className="na-pop" role="dialog" aria-label={T.modelAndEffort} style={{ top: props.pos.top, right: props.pos.right }} onKeyDown={keys} onBlur={leave}>
      <div className="na-pop-head">
        <Avatar provider={id} />
        <span className="na-pt">
          <b>{providerLabel(id)}</b>
          <span>{props.modelName(id, value.model)}</span>
        </span>
        <button type="button" className="na-reset" aria-label={T.resetDefaultsLabel} onClick={props.onReset}>
          <ArrowCounterClockwise size={12} aria-hidden="true" /> {T.resetDefaults}
        </button>
      </div>
      <div className="na-sec">{T.modelLabel}</div>
      {/* biome-ignore lint/a11y/useSemanticElements: a listbox of radio-like rows; the native select cannot hold notes and keys. */}
      <div role="listbox" aria-label={T.modelLabel}>
        {models.map((m, k) => (
          <button type="button" key={m.id} role="option" aria-selected={m.id === value.model} className="na-mi" onClick={() => props.onChange({ model: m.id })}>
            <span className="na-dot" aria-hidden="true" />
            <span>
              {m.label}
              {m.id === choices.defaultModel ? <span className="s">{T.defaultTag}</span> : m.note ? <span className="s">{m.note}</span> : null}
            </span>
            <span className="k" aria-hidden="true">{k < 9 ? k + 1 : ''}</span>
          </button>
        ))}
      </div>
      <div className="na-mcustom">
        <Plus size={13} aria-hidden="true" />
        <input
          ref={custom}
          aria-label={T.otherModel}
          placeholder={T.otherModel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitCustom()
            }
          }}
          onBlur={commitCustom}
        />
      </div>
      <div className="na-psep" />
      {efforts.length > 0 ? (
        <>
          <div className="na-sec na-eff-head">
            <span>{T.effortLabel}</span>
            <span className="na-eff-val" key={value.effort ?? ''}>{value.effort ? lower(effortName(value.effort)) : T.effortUnset}</span>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: the stepped meter is a slider of bars, not a native range input. */}
          <div
            className="na-meter"
            role="slider"
            tabIndex={0}
            aria-label={T.effortLabel}
            aria-valuemin={0}
            aria-valuemax={efforts.length - 1}
            aria-valuenow={index >= 0 ? index : undefined}
            aria-valuetext={value.effort ? effortName(value.effort) : T.effortUnset}
            onKeyDown={meterKeys}
            onPointerDown={(e) => {
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                // No pointer capture here: the drag still follows moves over the meter.
              }
              dragging.current = true
              at(e)
            }}
            onPointerMove={(e) => dragging.current && at(e)}
            onPointerUp={() => {
              dragging.current = false
            }}
            onPointerCancel={() => {
              dragging.current = false
            }}
          >
            {efforts.map((e, k) => (
              <span key={e} className={`na-bar ${k <= index ? 'on' : ''}`} style={{ height: Math.round(8 + (16 * k) / Math.max(1, efforts.length - 1)) }} title={effortName(e)} />
            ))}
          </div>
        </>
      ) : (
        <p className="na-none">{T.effortNone}</p>
      )}
    </div>
  )
}
