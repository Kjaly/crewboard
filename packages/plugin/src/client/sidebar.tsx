import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OrchestraRepoSnapshot, OrchestraSnapshot, SidebarOrder } from '../shared/types.js'
import { type Action, useAction } from './actions.js'
import { api, type DraftJobSummary, type DraftSummary } from './api.js'
import { isBlocking } from './draft-findings.js'
import { planHandoff } from './handoff.js'
import { relativeTime, t, useLang } from './i18n.js'
import { openSession } from './layout.js'
import { repoName, type WaitingTarget } from './review.js'
import {
  type GroupPlan,
  type InboxItem,
  type RepoEntry,
  type RepoGroup,
  type SearchHit,
  type SidePlan,
  defaultGroupOpen,
  groupCounts,
  inboxCount,
  inboxItems,
  splitInbox,
  isFinishedPlan,
  moveRow,
  planCounts,
  planRowKey,
  readSideFolds,
  rowState,
  searchSnapshot,
  shiftRow,
  sidebarTree,
  writeSideFolds,
} from './sidebar-model.js'
import { orchestraStore } from './store.js'

/**
 * The screen's left rail: global search, one «Needs you» inbox across repositories, then the
 * repository tree — two levels only, repository group → plan (worktree copies of one git
 * repository merge into a single group; the copy folder lives in the plan row's tooltip and the
 * agent handoff). One highlight: the current plan carries the selected style, nothing else does.
 */

const initials = (name: string): string => {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
  return letters.join('').toUpperCase() || '·'
}

const narrowRail = (): boolean => globalThis.matchMedia?.('(max-width: 1100px)').matches ?? false

const skey = (raw: string): string => raw

/* Row marks follow the dsh Workspaces cell set: an outline folder for a repository (open when
   expanded), a filled triangle as the hover/focus expand affordance, a 10px pixel-chase for live
   work and halo dots for waiting/failed — the same vocabulary the shell's own list speaks. */
function FolderGlyph({ open }: { open: boolean }) {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5.19629 1.57104C5.81144 1.5711 6.38623 1.8786 6.72754 2.39038L7.19922 3.09839C7.28454 3.22635 7.42824 3.30344 7.58203 3.30347H12.1699C13.5039 3.30348 14.5859 4.38548 14.5859 5.71948V6.62671C15.2694 7.02689 15.6605 7.85012 15.4385 8.68726L14.3848 12.658C14.1037 13.7164 13.1449 14.4527 12.0498 14.4529H2.91699C1.51651 14.4529 0.451662 13.2814 0.501954 11.9519V3.98706C0.501954 2.65305 1.58396 1.57104 2.91797 1.57104H5.19629ZM3.7793 7.75562C3.30994 7.75562 2.89883 8.07153 2.77832 8.52515L1.91602 11.7722C1.74167 12.4291 2.23734 13.073 2.91699 13.073H12.0498C12.5191 13.0728 12.9304 12.757 13.0508 12.3035L14.1045 8.33374C14.1819 8.04202 13.9619 7.756 13.6602 7.75562H3.7793ZM2.91797 2.9519C2.34625 2.9519 1.88281 3.41534 1.88281 3.98706V7.2937C2.33068 6.7269 3.02249 6.37476 3.7793 6.37476H13.2051V5.71948C13.2051 5.14777 12.7416 4.68434 12.1699 4.68433H7.58203C6.96675 4.6843 6.39209 4.37595 6.05078 3.86401L5.5791 3.15601C5.49379 3.02821 5.34995 2.95196 5.19629 2.9519H2.91797Z" fill="currentColor" />
      <path opacity="0.2" d="M13.6602 7.75525C13.9618 7.7556 14.1815 8.04179 14.1045 8.33337L13.0508 12.3031C12.9304 12.7567 12.5191 13.0725 12.0498 13.0726H2.91701C2.23744 13.0725 1.7417 12.4287 1.91603 11.7719L2.77834 8.52478C2.89898 8.07146 3.31018 7.75532 3.77931 7.75525H13.6602ZM5.1963 2.95154C5.34985 2.95159 5.49377 3.02803 5.57912 3.15564L6.0508 3.86365C6.39205 4.37553 6.96685 4.68385 7.58205 4.68396H12.1699C12.7416 4.68396 13.2049 5.14754 13.2051 5.71912V6.37439H3.77931C3.02267 6.37444 2.33067 6.72671 1.88283 7.29333V3.98669C1.88299 3.4152 2.34649 2.95168 2.91798 2.95154H5.1963Z" fill="currentColor" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path transform="translate(1.5 2.429)" d="M5.05582 0.518756L4.50669 0.86654L5.05582 0.518756ZM13 9.4837L13.65 9.4837L13.65 3.53962L13 3.53962L12.35 3.53962L12.35 9.4837L13 9.4837ZM11.3264 1.86603L11.3264 1.21603L6.52313 1.21603L6.52313 1.86603L6.52313 2.51603L11.3264 2.51603L11.3264 1.86603ZM5.58054 1.34727L6.12968 0.999489L5.60495 0.170972L5.05582 0.518756L4.50669 0.86654L5.03141 1.69506L5.58054 1.34727ZM4.11323 1.23058e-13L4.11323 -0.65L1.67359 -0.65L1.67359 5.00699e-14L1.67359 0.65L4.11323 0.65L4.11323 1.23058e-13ZM0 1.67359L-0.65 1.67359L-0.65 9.4837L0 9.4837L0.65 9.4837L0.65 1.67359L0 1.67359ZM11.3264 11.1573L11.3264 10.5073L1.67359 10.5073L1.67359 11.1573L1.67359 11.8073L11.3264 11.8073L11.3264 11.1573ZM0 9.4837L-0.65 9.4837C-0.65 10.767 0.390308 11.8073 1.67359 11.8073L1.67359 11.1573L1.67359 10.5073C1.10828 10.5073 0.65 10.049 0.65 9.4837L0 9.4837ZM1.67359 5.00699e-14L1.67359 -0.65C0.390307 -0.65 -0.65 0.390309 -0.65 1.67359L0 1.67359L0.65 1.67359C0.65 1.10828 1.10828 0.65 1.67359 0.65L1.67359 5.00699e-14ZM5.05582 0.518756L5.60495 0.170972C5.28121 -0.340193 4.71829 -0.65 4.11323 -0.65L4.11323 1.23058e-13L4.11323 0.65C4.27282 0.65 4.4213 0.731715 4.50669 0.86654L5.05582 0.518756ZM6.52313 1.86603L6.52313 1.21603C6.36354 1.21603 6.21507 1.13431 6.12968 0.999489L5.58054 1.34727L5.03141 1.69506C5.35515 2.20622 5.91808 2.51603 6.52313 2.51603L6.52313 1.86603ZM13 3.53962L13.65 3.53962C13.65 2.25634 12.6097 1.21603 11.3264 1.21603L11.3264 1.86603L11.3264 2.51603C11.8917 2.51603 12.35 2.97431 12.35 3.53962L13 3.53962ZM13 9.4837L12.35 9.4837C12.35 10.049 11.8917 10.5073 11.3264 10.5073L11.3264 11.1573L11.3264 11.8073C12.6097 11.8073 13.65 10.767 13.65 9.4837L13 9.4837Z" fill="currentColor" />
    </svg>
  )
}

/** Filled triangle like the shell's tree arrow: points right closed, rotates down open. */
function ArrowGlyph({ open }: { open: boolean }) {
  return (
    <svg className={`orc-srow__arrow${open ? ' orc-srow__arrow--open' : ''}`} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M4.25 2.82782L4.25 11.1722C4.25 11.6622 4.84243 11.9076 5.18891 11.5611L9.36109 7.38891C9.57588 7.17412 9.57588 6.82588 9.36109 6.61109L5.18891 2.43891C4.84243 2.09243 4.25 2.33782 4.25 2.82782Z" fill="currentColor" />
    </svg>
  )
}

const GLYPH_PROPS = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const DoneGlyph = () => (
  <svg {...GLYPH_PROPS} aria-hidden="true">
    <circle cx="8" cy="8" r="5.4" />
    <path d="M5.6 8.3l1.7 1.7 3.2-3.7" />
  </svg>
)
const ArchiveGlyph = () => (
  <svg {...GLYPH_PROPS} aria-hidden="true">
    <path d="M3 4.5h10v2.2H3z" />
    <path d="M4.3 6.7v5.8h7.4V6.7" />
    <path d="M6.7 9.2h2.6" />
  </svg>
)
const QuietGlyph = () => (
  <svg {...GLYPH_PROPS} aria-hidden="true">
    <path d="M13.3 9.9A5.5 5.5 0 0 1 6.1 2.7a5.5 5.5 0 1 0 7.2 7.2z" />
  </svg>
)
const HiddenGlyph = () => (
  <svg {...GLYPH_PROPS} aria-hidden="true">
    <path d="M2.6 8s2.1-3.4 5.4-3.4S13.4 8 13.4 8 11.3 11.4 8 11.4 2.6 8 2.6 8z" />
    <path d="M3.2 12.9 12.8 3.1" />
  </svg>
)
const EllipsisGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="3.6" cy="8" r="1.25" />
    <circle cx="8" cy="8" r="1.25" />
    <circle cx="12.4" cy="8" r="1.25" />
  </svg>
)

type StateCounts = { running: number; waiting: number; failed: number }

/** The counts behind the one status mark, spelled out for the tooltip and the screen reader. */
const statusLabel = (counts: StateCounts): string =>
  [
    counts.running > 0 ? t('side.badge.running', { count: counts.running }) : '',
    counts.waiting > 0 ? t('panel.app.repoWaiting', { count: counts.waiting }) : '',
    counts.failed > 0 ? t('side.badge.failed', { count: counts.failed }) : '',
  ]
    .filter(Boolean)
    .join(' · ')

/* The chase cells run on the outer ring of a 10px matrix — the shell's running mark. The global
   reduced-motion rule freezes the animation and the base opacity then reads as a static ring. */
const DOT_CELLS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4],
]

/** One status mark at the right edge of a row; nothing renders when the row is calm. */
function StatusMark({ counts }: { counts: StateCounts }) {
  const state = rowState(counts)
  if (state === 'idle') return null
  const label = statusLabel(counts)
  return (
    <span className="orc-srow__state" role="img" aria-label={label} title={label}>
      {state === 'running' ? (
        <svg className="orc-sdot-matrix" width="10" height="10" viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden="true">
          {DOT_CELLS.map(([x, y], i) => (
            <rect key={`${x}-${y}`} x={x} y={y} width="2" height="2" style={{ animationDelay: `${(i - DOT_CELLS.length) * 125}ms` }} />
          ))}
        </svg>
      ) : (
        <i className={`orc-sdot orc-sdot--${state}`} aria-hidden="true" />
      )}
    </span>
  )
}

type MenuItem = { label: string; danger?: boolean; /** The action leaves the row (input, navigation): the menu does not return focus to the trigger. */ leaves?: boolean; disabled?: boolean; /** One quiet line under the label: the effect, or why the item is disabled. */ hint?: string; onPick(): void }
type MenuState = { x: number; y: number; items: MenuItem[]; origin: HTMLElement | null }

/* Row drag follows the dsh Workspaces pattern — a 2px insert rule with a leading chevron between
   rows (ui-workspace Rows.module.css dropBefore/dropAfter) — but on Pointer Events rather than
   HTML5 drag-and-drop: a small movement threshold keeps a click a click, pointer capture keeps the
   session alive when the pointer leaves the window, Escape cancels, and the list auto-scrolls near
   its edges. */
const DRAG_THRESHOLD = 4
const DRAG_EDGE = 28
const PLAN_LIST = 'plan:'
const SECTION_LISTS = ['sec:pinned', 'sec:repos', 'sec:quiet', 'sec:hidden'] as const

/** One pointer session, pending or active; only an active session has passed the threshold. */
type DragSession = {
  pointerId: number
  /** The grabbed row's `data-dragid`/`data-draglist`. */
  id: string
  list: string
  row: HTMLElement
  startX: number
  startY: number
  grabOffsetY: number
  left: number
  width: number
  active: boolean
  overId: string | null
  half: 'before' | 'after'
  x: number
  y: number
  scrollVel: number
  raf: number
  dispose(): void
}

/** The floating copy that follows the pointer while a row is dragged. */
type DragGhost = { id: string; list: string; overId: string | null; half: 'before' | 'after'; left: number; top: number; width: number }

/** The plans that render as draggable rows: not archived, not folded into «finished». */
const livePlans = (group: RepoGroup) => group.plans.filter((row) => !row.plan.archived && !isFinishedPlan(row.plan))

/** A plan that lives in a linked worktree, not the repository's main checkout, carries a «worktree» mark. */
const inWorktree = (repo: OrchestraRepoSnapshot): boolean => Boolean(repo.worktreeOf) || (repo.family !== undefined && repo.family.root !== repo.root)

/** A row's context menu — the same fixed popover the task menu uses, positioned at the pointer. */
function RowMenu({ menu, onClose }: { menu: MenuState; onClose(refocus?: boolean): void }) {
  const list = useRef<HTMLDivElement>(null)
  const buttons = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Focus and clamp rerun only when a new menu opens.
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const el = list.current
    if (el) {
      const rect = el.getBoundingClientRect()
      if (menu.y + rect.height > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`
      if (menu.x + rect.width > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`
    }
  }, [menu])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The menu is short-lived and always needs the latest handlers.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose(true)
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const all = buttons()
      const i = all.indexOf(document.activeElement as HTMLButtonElement)
      all[(i + (event.key === 'ArrowDown' ? 1 : all.length - 1) + all.length) % all.length]?.focus()
      event.preventDefault()
      event.stopPropagation()
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest?.('.orc-smenu')) onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('mousedown', onPointerDown)
    }
    // onClose changes identity every render; the menu is short-lived and only needs the latest.
  })
  return (
    <div ref={list} role="menu" className="orc-smenu" style={{ left: menu.x, top: menu.y }}>
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className={`orc-link${item.danger ? ' orc-smenu__item--danger' : ''}${item.disabled && item.hint ? ' orc-smenu__item--why' : ''}`}
          onClick={() => {
            onClose(!item.leaves)
            item.onPick()
          }}
        >
          {item.label}
          {item.hint ? <span className="orc-smenu__hint">{item.hint}</span> : null}
        </button>
      ))}
    </div>
  )
}

function RenameRow({ repo, plan, call, onDone }: { repo: OrchestraRepoSnapshot; plan: SidePlan; call: Action['call']; onDone(): void }) {
  const [goal, setGoal] = useState(plan.goal)
  const submit = () => {
    const next = goal.trim()
    if (!next || next === plan.goal) return onDone()
    void call(() => api.planRename(repo.root, plan.id, next)).then((ok) => {
      if (ok) onDone()
    })
  }
  return (
    <form
      className="orc-srow orc-srow--edit"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {/* biome-ignore lint/a11y/noAutofocus: Renaming is the only field on screen at that moment. */} <input
        autoFocus
        className="orc-plans__field"
        aria-label={t('panel.plan.renameLabel', { goal: plan.goal })}
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone()
        }}
      />
    </form>
  )
}

function NewPlan({ repo, call, onDone }: { repo: OrchestraRepoSnapshot; call: Action['call']; onDone(): void }) {
  const [goal, setGoal] = useState('')
  return (
    <form
      className="orc-plans__composer"
      onSubmit={(e) => {
        e.preventDefault()
        const g = goal.trim()
        if (!g) return
        // plan-new makes the plan current on the host; the next snapshot switches the screen.
        void call(() => api.planNew(repo.root, g)).then((ok) => {
          if (ok) onDone()
        })
      }}
    >
      {/* biome-ignore lint/a11y/noAutofocus: Focus moves to this field when the composer opens. */} <input
        autoFocus
        className="orc-plans__field"
        aria-label={t('panel.plan.newGoal')}
        placeholder={t('panel.plan.goalPlaceholder')}
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone()
        }}
      />
      <p className="orc-hint">{t('panel.plan.hint')}</p>
    </form>
  )
}

/**
 * «+» next to Repositories: a folder path joins Crewboard's list. The host checks it (absolute or `~`,
 * an existing folder, inside a Git repository or worktree, not listed yet) and answers with the
 * repository root it listed; the screen then opens that repository — its plans, or the welcome flow.
 */
function AddRepo({ onDone }: { onDone(root?: string): void }) {
  const [path, setPath] = useState('')
  const add = useAction()
  return (
    <form
      className="orc-plans__composer"
      onSubmit={(e) => {
        e.preventDefault()
        const typed = path.trim()
        if (!typed) return
        let root: string | undefined
        void add.call(async () => {
          const result = await api.repoAdd(typed)
          if (result.ok) root = result.value.root
          return result
        }).then((ok) => {
          if (ok) onDone(root)
        })
      }}
    >
      {/* biome-ignore lint/a11y/noAutofocus: Focus moves to this field when «+» opens it. */} <input
        autoFocus
        className="orc-plans__field"
        aria-label={t('side.addRepo.label')}
        aria-invalid={add.error ? true : undefined}
        placeholder={t('side.addRepo.placeholder')}
        spellCheck={false}
        autoComplete="off"
        value={path}
        disabled={add.pending}
        onChange={(e) => {
          setPath(e.target.value)
          if (add.error) add.clear()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone()
        }}
      />
      {add.error ? <p className="orc-error orc-plans__error" role="alert">{add.error}</p> : <p className="orc-hint">{t('side.addRepo.hint')}</p>}
    </form>
  )
}

export function RepoSidebar(props: {
  snapshot: OrchestraSnapshot
  repo: OrchestraRepoSnapshot
  open: boolean
  onToggle(): void
  drafts?: DraftSummary[]
  /** Draft jobs still running, refused or failed; they sit with the drafts until they become one. */
  draftJobs?: DraftJobSummary[]
  selectedDraft?: string | null
  onDraft?(id: string): void
  onPlan?(): void
}) {
  const { snapshot, repo, open, onToggle } = props
  const drafts = props.drafts ?? []
  const draftJobs = props.draftJobs ?? []
  useLang()
  const action = useAction()
  const [query, setQuery] = useState('')
  const [hitIndex, setHitIndex] = useState(0)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renameKey, setRenameKey] = useState<string | null>(null)
  const [composerFor, setComposerFor] = useState<string | null>(null)
  const [addingRepo, setAddingRepo] = useState(false)
  const [toast, setToast] = useState(false)
  const [folds, setFolds] = useState<Record<string, boolean>>(readSideFolds)
  const [announce, setAnnounce] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const navRef = useRef<HTMLElement>(null)

  /* The saved row order arrives with the snapshot; a local write applies at once and stays until
     the host's store catches up — an order echo (ours or another tab's) then takes over. */
  const [optimistic, setOptimistic] = useState<{ order: SidebarOrder; base: string } | null>(null)
  const order = useMemo(() => {
    if (optimistic && JSON.stringify(snapshot.order ?? null) === optimistic.base) return optimistic.order
    return snapshot.order
  }, [snapshot.order, optimistic])

  const tree = useMemo(() => sidebarTree(snapshot, Date.now(), order), [snapshot, order])
  const inbox = useMemo(() => inboxItems(snapshot), [snapshot])
  const waitingCount = inboxCount(inbox)
  const inboxRows = useMemo(() => splitInbox(inbox), [inbox])
  const hits = useMemo(() => searchSnapshot(snapshot, query), [snapshot, query])

  const isOpen = (key: string, fallback: boolean) => folds[key] ?? fallback
  const toggleFold = (key: string, fallback: boolean) =>
    setFolds((prev) => {
      const next = { ...prev, [key]: !(prev[key] ?? fallback) }
      writeSideFolds(next)
      return next
    })
  const openFold = (key: string) =>
    setFolds((prev) => {
      const next = { ...prev, [key]: true }
      writeSideFolds(next)
      return next
    })

  const openMenu = (event: { clientX: number; clientY: number; currentTarget: HTMLElement; preventDefault(): void; stopPropagation?(): void }, items: MenuItem[]) => {
    event.preventDefault()
    event.stopPropagation?.()
    // The menu was opened by the ⋯ button or by right-click on the row; either way focus returns to
    // the row's trigger when the picked action does not leave the row.
    const trigger = event.currentTarget.closest('.orc-srow')?.querySelector<HTMLElement>('.orc-srow__menu') ?? event.currentTarget
    setMenu({ x: event.clientX, y: event.clientY, items, origin: trigger })
  }

  const closeMenu = (refocus?: boolean) => {
    setMenu((m) => {
      if (refocus) m?.origin?.focus()
      return null
    })
  }

  /* ------------------------------------------------------- drag to reorder */

  const [drag, setDrag] = useState<DragGhost | null>(null)
  const sessionRef = useRef<DragSession | null>(null)
  /** A finished drag swallows the click that lands on the released row. */
  const suppressClick = useRef(false)

  /** The row ids each reorderable list currently shows — the drop targets of pointer and keyboard moves. */
  const dragLists = useMemo(() => {
    const map = new Map<string, string[]>()
    const sections: ReadonlyArray<readonly [string, RepoGroup[]]> = [
      ['sec:pinned', tree.pinned],
      ['sec:repos', tree.repos],
      ['sec:quiet', tree.quiet],
      ['sec:hidden', tree.hidden],
    ]
    for (const [id, groups] of sections) map.set(id, groups.map((g) => g.id))
    for (const group of [...tree.pinned, ...tree.repos, ...tree.quiet, ...tree.hidden]) {
      map.set(`${PLAN_LIST}${group.id}`, livePlans(group).map((row) => planRowKey(row.entry.repo.root, row.plan.id)))
    }
    return map
  }, [tree])

  const rowNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const group of [...tree.pinned, ...tree.repos, ...tree.quiet, ...tree.hidden]) {
      map.set(group.id, group.name)
      for (const row of group.plans) map.set(planRowKey(row.entry.repo.root, row.plan.id), row.plan.goal)
    }
    return map
  }, [tree])

  const persistOrder = (patch: SidebarOrder | null, next: SidebarOrder) => {
    setOptimistic({ order: next, base: JSON.stringify(snapshot.order ?? null) })
    void api
      .sideOrder(repo.root, patch)
      .then((result) => {
        if (!result.ok) setOptimistic(null)
      })
      .catch(() => setOptimistic(null))
  }

  const announceMove = (id: string, ids: string[]) =>
    setAnnounce(t('side.moved', { name: rowNames.get(id) ?? id, pos: ids.indexOf(id) + 1, count: ids.length }))

  /** Saves one list's new arrangement; `id` is the moved row, announced to screen readers. */
  const commitOrder = (list: string, id: string, nextIds: string[]) => {
    const base = order ?? {}
    if (list.startsWith(PLAN_LIST)) {
      const group = list.slice(PLAN_LIST.length)
      persistOrder({ plans: { [group]: nextIds } }, { ...base, plans: { ...(base.plans ?? {}), [group]: nextIds } })
    } else {
      const repos = SECTION_LISTS.flatMap((section) => (section === list ? nextIds : dragLists.get(section) ?? []))
      persistOrder({ repos }, { ...base, repos })
    }
    announceMove(id, nextIds)
  }

  const moveRowBy = (list: string, id: string, delta: -1 | 1) => {
    const ids = dragLists.get(list) ?? []
    const next = shiftRow(ids, id, delta)
    if (next.every((v, i) => v === ids[i])) return
    commitOrder(list, id, next)
  }

  /** Move Up / Move Down menu rows for one draggable row. */
  const moveItems = (list: string, id: string): MenuItem[] => {
    const ids = dragLists.get(list) ?? []
    const at = ids.indexOf(id)
    return [
      { label: t('side.moveUp'), disabled: at <= 0, onPick: () => moveRowBy(list, id, -1) },
      { label: t('side.moveDown'), disabled: at < 0 || at >= ids.length - 1, onPick: () => moveRowBy(list, id, 1) },
    ]
  }

  const resetOrder = () => persistOrder(null, {})
  const hasManualOrder = Boolean(order?.repos?.length || Object.keys(order?.plans ?? {}).length)

  /** The row under `y` in one drag list — the dragged row itself never counts as a target. */
  const hitRow = (list: string, y: number): { id: string; half: 'before' | 'after' } | null => {
    const rows = Array.from(navRef.current?.querySelectorAll<HTMLElement>(`[data-draglist="${list}"][data-dragid]`) ?? []).filter(
      (el) => el.dataset.dragid !== sessionRef.current?.id,
    )
    for (const el of rows) {
      const rect = el.getBoundingClientRect()
      if (y < rect.top + rect.height / 2) return { id: el.dataset.dragid ?? '', half: 'before' }
    }
    const tail = rows.at(-1)
    return tail ? { id: tail.dataset.dragid ?? '', half: 'after' } : null
  }

  /** Auto-scrolls the tree while a drag holds the pointer near its top or bottom edge. */
  const dragTick = () => {
    const s = sessionRef.current
    if (!s?.active) return
    const scroller = navRef.current?.querySelector<HTMLElement>('.orc-tree__list')
    if (scroller && s.scrollVel) {
      scroller.scrollTop += s.scrollVel
      const hit = hitRow(s.list, s.y)
      s.overId = hit?.id ?? null
      if (hit) s.half = hit.half
      setDrag((d) => (d ? { ...d, overId: s.overId, half: s.half } : d))
    }
    s.raf = requestAnimationFrame(dragTick)
  }

  const onRowPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || sessionRef.current) return
    const target = event.target as HTMLElement | null
    // The status mark, the ⋯ menu and the rename field keep their own gestures.
    if (target?.closest('.orc-srow__menu, .orc-srow__state, input, textarea, select, [contenteditable="true"]')) return
    const row = event.currentTarget
    const id = row.dataset.dragid
    const list = row.dataset.draglist
    if (!id || !list) return
    const s: DragSession = {
      pointerId: event.pointerId,
      id,
      list,
      row,
      startX: event.clientX,
      startY: event.clientY,
      grabOffsetY: 0,
      left: 0,
      width: 0,
      active: false,
      overId: null,
      half: 'after',
      x: event.clientX,
      y: event.clientY,
      scrollVel: 0,
      raf: 0,
      dispose: () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('keydown', onKey, true)
        cancelAnimationFrame(s.raf)
      },
    }
    const finish = (commit: boolean) => {
      s.dispose()
      sessionRef.current = null
      try {
        s.row.releasePointerCapture?.(s.pointerId)
      } catch {
        /* capture is best-effort: absent in jsdom, already gone after pointercancel */
      }
      if (s.active) {
        suppressClick.current = true
        setTimeout(() => {
          suppressClick.current = false
        }, 0)
        setDrag(null)
        if (commit) {
          const ids = dragLists.get(s.list) ?? []
          const next = s.overId ? moveRow(ids, s.id, s.overId, s.half) : ids
          if (next.some((v, i) => v !== ids[i])) commitOrder(s.list, s.id, next)
        }
      }
    }
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== s.pointerId) return
      s.x = event.clientX
      s.y = event.clientY
      if (!s.active) {
        if (Math.abs(s.y - s.startY) < DRAG_THRESHOLD && Math.abs(s.x - s.startX) < DRAG_THRESHOLD) return
        s.active = true
        const rect = s.row.getBoundingClientRect()
        s.grabOffsetY = s.startY - rect.top
        s.left = rect.left
        s.width = rect.width
        try {
          s.row.setPointerCapture?.(s.pointerId)
        } catch {
          /* absent in jsdom and for already-released pointers */
        }
        s.raf = requestAnimationFrame(dragTick)
      }
      const hit = hitRow(s.list, s.y)
      s.overId = hit?.id ?? null
      if (hit) s.half = hit.half
      const scroller = navRef.current?.querySelector<HTMLElement>('.orc-tree__list')
      if (scroller) {
        const edge = scroller.getBoundingClientRect()
        s.scrollVel =
          s.y < edge.top + DRAG_EDGE
            ? -Math.ceil((edge.top + DRAG_EDGE - s.y) / 6)
            : s.y > edge.bottom - DRAG_EDGE
              ? Math.ceil((s.y - edge.bottom + DRAG_EDGE) / 6)
              : 0
      }
      setDrag({ id: s.id, list: s.list, overId: s.overId, half: s.half, left: s.left, top: s.y - s.grabOffsetY, width: s.width })
    }
    const onUp = (event: PointerEvent) => {
      if (event.pointerId === s.pointerId) finish(true)
    }
    const onCancel = (event: PointerEvent) => {
      if (event.pointerId === s.pointerId) finish(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    sessionRef.current = s
  }

  // An unmounted sidebar drops its in-flight session instead of leaking the window listeners.
  useEffect(() => () => sessionRef.current?.dispose(), [])

  const copyPlan = (planRepo: OrchestraRepoSnapshot, plan: SidePlan) =>
    void navigator.clipboard?.writeText(planHandoff(planRepo, plan)).then(() => {
      setToast(true)
      setTimeout(() => setToast(false), 1600)
    }).catch(() => {})

  const planMenu = (entry: RepoEntry, plan: SidePlan, listId?: string): MenuItem[] => {
    const items: MenuItem[] = [
      { label: t('side.copyAgent'), onPick: () => copyPlan(entry.repo, plan) },
      { label: t('side.openChat'), leaves: true, onPick: () => void openPlanChat(entry.repo, plan) },
    ]
    if (plan.example) items.push({ label: t('welcome.removeExample'), onPick: () => void action.call(() => api.exampleRemove(entry.repo.root)) })
    else items.unshift({ label: t('panel.plan.rename'), leaves: true, onPick: () => setRenameKey(`${entry.repo.root}/${plan.id}`) })
    if (listId) items.push(...moveItems(listId, planRowKey(entry.repo.root, plan.id)))
    items.push({
      label: plan.archived ? t('panel.plan.restore') : t('panel.plan.archiveAction'),
      danger: !plan.archived,
      onPick: () => void action.call(() => api.planArchive(entry.repo.root, plan.id, !plan.archived)),
    })
    return items
  }

  /** Pin and hide are family decisions: the group row carries no copy level, so the flag lands on every member. */
  const groupMenu = (group: RepoGroup, primary: RepoEntry, listId: string): MenuItem[] => {
    const flag = (name: 'pinned' | 'hidden', value: boolean) =>
      void action.call(() =>
        Promise.all(group.members.map((m) => api.repoFlag(m.repo.root, name, value))).then(
          (results) => results.find((r) => !r.ok) ?? ({ ok: true as const, value: null }),
        ),
      )
    const remove = removeItem(group)
    return [
      {
        label: t('side.newPlan'),
        leaves: true,
        disabled: primary.repo.missing,
        onPick: () => {
          openFold(`grp:${group.id}`)
          setComposerFor(primary.repo.root)
        },
      },
      { label: group.members.every((m) => m.repo.pinned) ? t('side.unpin') : t('side.pin'), onPick: () => flag('pinned', !group.members.every((m) => m.repo.pinned)) },
      { label: group.members.every((m) => m.repo.hidden) ? t('side.show') : t('side.hide'), onPick: () => flag('hidden', !group.members.every((m) => m.repo.hidden)) },
      ...moveItems(listId, group.id),
      ...(remove ? [remove] : []),
    ]
  }

  /**
   * «Remove from list» forgets the group's folders that Crewboard listed — only those: a dsh workspace
   * or a profile path is removed where it lives, and the item says so instead of pretending.
   */
  const removeItem = (group: RepoGroup): MenuItem | undefined => {
    const members = group.members.filter((m) => m.repo.sources?.length)
    if (members.length === 0) return undefined // an older host sends no sources: no promise it cannot keep
    const listed = members.filter((m) => m.repo.sources?.includes('crewboard'))
    if (listed.length === 0) {
      const sources = new Set(members.flatMap((m) => m.repo.sources ?? []))
      const why = sources.has('dsh') ? 'side.removeRepo.dsh' : sources.has('profile') ? 'side.removeRepo.profile' : 'side.removeRepo.worktree'
      return { label: t('side.removeRepo'), disabled: true, hint: t(why), onPick: () => {} }
    }
    const also = new Set(listed.flatMap((m) => m.repo.sources ?? []))
    const hint = also.has('dsh') ? t('side.removeRepo.alsoDsh') : also.has('profile') ? t('side.removeRepo.alsoProfile') : t('side.removeRepo.safe')
    return {
      label: t('side.removeRepo'),
      danger: true,
      hint,
      onPick: () =>
        void action.call(() =>
          Promise.all(listed.map((m) => api.repoRemove(m.repo.root))).then(
            (results) => results.find((r) => !r.ok) ?? ({ ok: true as const, value: null }),
          ),
        ),
    }
  }

  const openPlanChat = async (planRepo: OrchestraRepoSnapshot, plan: SidePlan) => {
    const sessionId = plan.chat?.sessionId ?? (await api.chatOpen(planRepo.root, plan.id).then((res) => (res.ok ? res.value.sessionId : undefined)))
    if (sessionId) await openSession(sessionId)
  }

  const pickPlan = (entry: RepoEntry, plan: SidePlan) => {
    props.onPlan?.()
    const target: WaitingTarget = { root: entry.repo.root, planId: plan.id }
    if (plan.waitingHuman > 0) orchestraStore.openWaiting(target)
    else if (!plan.current || entry.repo.root !== repo.root) orchestraStore.openPlan(entry.repo.root, plan.id)
    if (open && narrowRail()) onToggle()
  }

  const pickGroup = (group: RepoGroup) => {
    props.onPlan?.()
    const member = group.members.find((m) => m.waiting > 0 || m.attention > 0) ?? group.members.find((m) => m.repo.root === repo.root) ?? group.members[0]
    if (member) orchestraStore.openFirstWaiting(member.repo.root)
    if (open && narrowRail()) onToggle()
  }

  const pickDraft = (id: string) => {
    props.onDraft?.(id)
    if (open && narrowRail()) onToggle()
  }

  const goHit = (hit: SearchHit) => {
    setQuery('')
    if (hit.kind === 'repo') orchestraStore.openFirstWaiting(hit.root)
    else if (hit.kind === 'plan' && hit.planId) orchestraStore.openPlan(hit.root, hit.planId)
    else if (hit.taskId) orchestraStore.openWaiting({ root: hit.root, planId: hit.planId, taskId: hit.taskId })
  }

  /* A narrow window shows the open sidebar as an overlay: Escape and a click outside fold it
    back — a row menu or an open field owns its own Escape first. */
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || menu !== null || !narrowRail()) return
      const target = event.target as HTMLElement | null
      if (target?.closest?.('input,textarea,select,[contenteditable="true"]')) return
      event.stopPropagation()
      onToggle()
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (narrowRail() && !target?.closest?.('.orc-plans')) onToggle()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open, menu, onToggle])

  /* Arrow keys walk every focusable row in the nav; Right opens a fold, Left folds or steps to the
    parent row. Enter is a button's own job. */
  const onTreeKeys = (event: React.KeyboardEvent<HTMLElement>) => {
    const nav = event.currentTarget
    const target = event.target as HTMLElement
    if (target.closest('input')) return
    const row = target.closest<HTMLElement>('[data-srow]')
    if (!row) return
    const rows = () => Array.from(nav.querySelectorAll<HTMLElement>('[data-srow]'))
    if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      // Alt+Arrow moves the row itself; the marker lives on the row's wrapper.
      const holder = row.parentElement
      const dragId = holder?.dataset.dragid
      const dragList = holder?.dataset.draglist
      if (dragId && dragList) moveRowBy(dragList, dragId, event.key === 'ArrowDown' ? 1 : -1)
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const list = rows()
      const i = list.indexOf(row)
      const next = list[i + (event.key === 'ArrowDown' ? 1 : -1)]
      if (next) {
        next.focus()
        event.preventDefault()
      }
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const fold = row.dataset.fold
      const key = row.dataset.skey ?? ''
      if (event.key === 'ArrowRight' && fold === 'closed') {
        toggleFold(key, row.dataset.fallback === 'open')
        event.preventDefault()
      } else if (event.key === 'ArrowLeft' && fold === 'open') {
        toggleFold(key, row.dataset.fallback === 'open')
        event.preventDefault()
      } else if (event.key === 'ArrowLeft' && row.dataset.parent) {
        nav.querySelector<HTMLElement>(`[data-skey="${CSS.escape(row.dataset.parent)}"]`)?.focus()
        event.preventDefault()
      } else if (event.key === 'ArrowRight' && row.dataset.children) {
        nav.querySelector<HTMLElement>(`[data-skey="${CSS.escape(row.dataset.children)}"]`)?.focus()
        event.preventDefault()
      }
    }
  }

  const inboxLabel = (item: InboxItem): string => {
    if (item.kind === 'plan') return t('panel.app.repoWaiting', { count: item.count ?? 0 })
    if (item.kind === 'decision') return t('queue.decisionYours')
    if (item.kind === 'attention') return item.message ?? t('panel.app.attentionCount', { count: item.count ?? 1 })
    return t('panel.status.inReview')
  }

  // Example rows sit under their own divider, after the real ones, so the heading's count visibly
  // refers to the rows above it (ui3: example work is listed, never counted).
  const inboxRow = (item: InboxItem) => (
    <li key={item.key}>
      <button
        type="button"
        data-srow
        data-skey={skey(`inbox:${item.key}`)}
        className={`orc-ibrow${item.alert ? ' orc-ibrow--alert' : ''}${item.example ? ' orc-ibrow--example' : ''}`}
        title={`${item.title || item.id}\n${item.repo} · ${inboxLabel(item)}${item.example ? ` · ${t('welcome.exampleLabel')}` : ''}`}
        onClick={() => {
          orchestraStore.openWaiting({ root: item.root, planId: item.planId, taskId: item.taskId })
          if (open && narrowRail()) onToggle()
        }}
      >
        <i className={`orc-sdot orc-sdot--${item.alert ? 'failed' : 'waiting'}`} aria-hidden="true" />
        <span className="orc-ibrow__line">{item.title || <span className="orc-ibrow__id">{item.id}</span>}</span>
        <span className="orc-ibrow__meta">
          {item.example ? item.repo : `${item.repo} · ${item.at ? relativeTime(Date.parse(item.at)) : '—'}`}
        </span>
      </button>
    </li>
  )

  const planRow = (entry: RepoEntry, plan: SidePlan, parentKey: string, dragList?: string) => {
    const key = planRowKey(entry.repo.root, plan.id)
    if (renameKey === key) {
      return (
        <li key={key} role="none">
          <RenameRow repo={entry.repo} plan={plan} call={action.call} onDone={() => setRenameKey(null)} />
        </li>
      )
    }
    const current = plan.current && entry.repo.root === repo.root
    const counts = planCounts(plan)
    const state = statusLabel(counts)
    return (
      <li key={key} role="none">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: The row's context menu opens on the wrapper so the ⋯ button stays small. */}<div
          className={`orc-srow${plan.archived ? ' orc-srow--arch' : ''}${drag?.id === key ? ' orc-srow--lift' : ''}${dragList && drag?.list === dragList && drag.overId === key ? ` orc-srow--drop${drag.half === 'before' ? 'Before' : 'After'}` : ''}`}
          data-dragid={dragList ? key : undefined}
          data-draglist={dragList}
          onPointerDown={dragList ? onRowPointerDown : undefined}
          onContextMenu={(e) => openMenu(e, planMenu(entry, plan, dragList))}
        >
          <button
            type="button"
            role="treeitem"
            aria-selected={current}
            aria-current={current ? 'true' : undefined}
            data-srow
            data-skey={skey(`plan:${key}`)}
            data-parent={parentKey}
            className="orc-srow__main orc-srow__main--plan"
            title={`${plan.goal}\n${repoName(entry.repo.root)} — ${entry.repo.root}${inWorktree(entry.repo) ? `\n${t('side.worktreeHint', { path: entry.repo.root })}` : ''}${state ? `\n${state}` : ''}`}
            onClick={() => {
              if (!suppressClick.current) pickPlan(entry, plan)
            }}
          >
            <span className="orc-srow__slot" aria-hidden="true" />
            <span className="orc-srow__name">
              {plan.goal}
              {plan.example ? <span className="orc-srow__example"> · {t('welcome.exampleLabel')}</span> : null}
              {inWorktree(entry.repo) ? <span className="orc-srow__example"> · {t('side.worktree')}</span> : null}
            </span>
            {plan.taskCount > 0 ? (
              <span className="orc-srow__meta orc-srow__peek">
                {plan.accepted}/{plan.taskCount}
              </span>
            ) : null}
            <StatusMark counts={counts} />
          </button>
          <button type="button" className="orc-srow__menu" aria-label={t('panel.plan.actions', { goal: plan.goal })} aria-haspopup="menu" onClick={(e) => openMenu(e, planMenu(entry, plan, dragList))}>
            <EllipsisGlyph />
          </button>
        </div>
      </li>
    )
  }

  /** An inner fold («N finished plans», the archive): one muted row, closed until opened. */
  const foldLi = (foldKey: string, label: string, parentKey: string, rows: GroupPlan[], glyph: ReactNode) => {
    const open = isOpen(foldKey, false)
    const firstChild = rows[0] ? skey(`plan:${rows[0].entry.repo.root}/${rows[0].plan.id}`) : undefined
    const counts = rows.reduce(
      (acc, row) => {
        const c = planCounts(row.plan)
        return { running: acc.running + c.running, waiting: acc.waiting + c.waiting, failed: acc.failed + c.failed }
      },
      { running: 0, waiting: 0, failed: 0 },
    )
    return (
      <li role="none">
        <button
          type="button"
          role="treeitem"
          aria-expanded={open}
          data-srow
          data-skey={skey(foldKey)}
          data-parent={parentKey}
          data-fold={open ? 'open' : 'closed'}
          data-children={firstChild}
          className="orc-srow__main orc-srow__fold"
          onClick={() => toggleFold(foldKey, false)}
        >
          <span className="orc-srow__slot orc-srow__glyph" aria-hidden="true">
            {glyph}
          </span>
          <span className="orc-srow__slot orc-srow__chev" aria-hidden="true">
            <ArrowGlyph open={open} />
          </span>
          <span className="orc-srow__name">{label}</span>
          <StatusMark counts={counts} />
        </button>
        {open ? <ul className="orc-srow__kids">{rows.map((row) => planRow(row.entry, row.plan, skey(foldKey)))}</ul> : null}
      </li>
    )
  }

  const groupRow = (group: RepoGroup, listId: string, parentKey?: string) => {
    const key = `grp:${group.id}`
    const rowKey = skey(key)
    const fallback = defaultGroupOpen(group, repo.root)
    const open = isOpen(key, fallback)
    const live = livePlans(group)
    const finished = group.plans.filter((row) => !row.plan.archived && isFinishedPlan(row.plan))
    const archived = group.plans.filter((row) => row.plan.archived)
    const primary = group.members.find((m) => m.repo.root === repo.root) ?? group.members[0]
    const finKey = `fin:${group.id}`
    const archKey = `arch:${group.id}`
    const firstChild = live[0] ? skey(`plan:${live[0].entry.repo.root}/${live[0].plan.id}`) : finished[0] ? skey(finKey) : archived[0] ? skey(archKey) : undefined
    const isCurrentGroup = group.members.some((m) => m.repo.root === repo.root)
    const composerHost = composerFor ? group.members.find((m) => m.repo.root === composerFor) : undefined
    const agg = !open || group.plans.length === 0 ? statusLabel(groupCounts(group)) : ''
    const missing = group.members.some((m) => m.repo.missing)
    return (
      <li key={group.id} role="none">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: The row's context menu opens on the wrapper so the ⋯ button stays small. */}<div
          className={`orc-srow orc-srow--repo${drag?.id === group.id ? ' orc-srow--lift' : ''}${drag?.list === listId && drag.overId === group.id ? ` orc-srow--drop${drag.half === 'before' ? 'Before' : 'After'}` : ''}`}
          data-dragid={group.id}
          data-draglist={listId}
          onPointerDown={onRowPointerDown}
          onContextMenu={primary ? (e) => openMenu(e, groupMenu(group, primary, listId)) : undefined}
        >
          <button
            type="button"
            role="treeitem"
            aria-expanded={open}
            data-srow
            data-skey={rowKey}
            data-fold={open ? 'open' : 'closed'}
            data-fallback={fallback ? 'open' : 'closed'}
            data-parent={parentKey}
            data-children={open ? firstChild : undefined}
            className="orc-srow__main orc-srow__main--repo"
            title={`${group.name}\n${group.id}\n${missing ? t('side.missingHint') : t('side.plans', { count: group.plans.length })}${agg ? `\n${agg}` : ''}`}
            onClick={() => {
              if (!suppressClick.current) toggleFold(key, fallback)
            }}
          >
            <span className={`orc-srow__slot orc-srow__glyph${open && isCurrentGroup ? ' orc-srow__glyph--active' : ''}`} aria-hidden="true">
              <FolderGlyph open={open} />
            </span>
            <span className="orc-srow__slot orc-srow__chev" aria-hidden="true">
              <ArrowGlyph open={open} />
            </span>
            <span className="orc-srow__name">
              {group.name}
              {missing ? <span className="orc-srow__example"> · {t('side.missing')}</span> : null}
            </span>
            {/* Collapsed — or planless — the row answers for its plans: one aggregated status mark. */}
            {agg ? <StatusMark counts={groupCounts(group)} /> : null}
          </button>
          {primary ? (
            <button type="button" className="orc-srow__menu" aria-label={t('side.repoActions', { repo: group.name })} aria-haspopup="menu" onClick={(e) => openMenu(e, groupMenu(group, primary, listId))}>
              <EllipsisGlyph />
            </button>
          ) : null}
        </div>
        {open ? (
          <ul className="orc-srow__kids">
            {live.map((row) => planRow(row.entry, row.plan, rowKey, `${PLAN_LIST}${group.id}`))}
            {finished.length > 0 ? foldLi(finKey, t('side.finished', { count: finished.length }), rowKey, finished, <DoneGlyph />) : null}
            {archived.length > 0 ? foldLi(archKey, t('panel.plan.archiveCount', { count: archived.length }), rowKey, archived, <ArchiveGlyph />) : null}
            {isCurrentGroup && drafts.length + draftJobs.length > 0 ? (
              <li role="none">
                <span className="orc-srow__grouphead">{t('panel.draft.group')}</span>
                <ul className="orc-srow__kids">
                  {draftJobs.map((job) => (
                    <li key={job.id} role="none">
                      <button
                        type="button"
                        data-srow
                        data-skey={skey(`draft:${job.id}`)}
                        data-parent={rowKey}
                        className="orc-srow__main orc-srow__main--plan orc-srow--draft"
                        aria-current={props.selectedDraft === job.id ? 'true' : undefined}
                        onClick={() => pickDraft(job.id)}
                      >
                        <span className="orc-srow__slot" aria-hidden="true" />
                        <span className="orc-srow__name">{job.spec ?? (job.source === 'chat' ? t('panel.draft.chat') : job.source.name)}</span>
                        <span className="orc-srow__meta orc-srow__peek">{t(`panel.draftJob.status.${job.status}`)}</span>
                        <span className="orc-srow__state" role="img" aria-label={t(`panel.draftJob.status.${job.status}`)} title={t(`panel.draftJob.status.${job.status}`)}>
                          <i className={`orc-sdot ${job.status === 'running' ? 'orc-sdot--running' : 'orc-sdot--failed'}`} aria-hidden="true" />
                        </span>
                      </button>
                    </li>
                  ))}
                  {drafts.map((draft) => (
                    <li key={draft.id} role="none">
                      <button
                        type="button"
                        data-srow
                        data-skey={skey(`draft:${draft.id}`)}
                        data-parent={rowKey}
                        className="orc-srow__main orc-srow__main--plan orc-srow--draft"
                        aria-current={props.selectedDraft === draft.id ? 'true' : undefined}
                        onClick={() => pickDraft(draft.id)}
                      >
                        <span className="orc-srow__slot" aria-hidden="true" />
                        <span className="orc-srow__name">{draft.goal}</span>
                        <span className="orc-srow__meta orc-srow__peek">{t('panel.plan.tasks', { count: draft.taskCount })}</span>
                        {draft.findings.some(isBlocking) ? (
                          <span className="orc-srow__state" role="img" aria-label={t('panel.draft.blocked')} title={t('panel.draft.blocked')}>
                            <i className="orc-sdot orc-sdot--failed" aria-hidden="true" />
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ) : null}
            {composerHost ? (
              <li role="none">
                <NewPlan repo={composerHost.repo} call={action.call} onDone={() => setComposerFor(null)} />
              </li>
            ) : null}
          </ul>
        ) : null}
      </li>
    )
  }

  const bucket = (label: string, key: string, listId: string, groups: RepoGroup[], glyph: ReactNode) =>
    groups.length === 0 ? null : (
      <li role="none">
        <button
          type="button"
          role="treeitem"
          aria-expanded={isOpen(key, false)}
          data-srow
          data-skey={skey(key)}
          data-fold={isOpen(key, false) ? 'open' : 'closed'}
          data-children={groups[0] ? skey(`grp:${groups[0].id}`) : undefined}
          className="orc-srow__main orc-srow__fold orc-srow__fold--dim"
          onClick={() => toggleFold(key, false)}
        >
          <span className="orc-srow__slot orc-srow__glyph" aria-hidden="true">
            {glyph}
          </span>
          <span className="orc-srow__slot orc-srow__chev" aria-hidden="true">
            <ArrowGlyph open={isOpen(key, false)} />
          </span>
          <span className="orc-srow__name">{label}</span>
        </button>
        {isOpen(key, false) ? (
          <ul className="orc-srow__kids">
            {groups.map((group) => groupRow(group, listId, skey(key)))}
          </ul>
        ) : null}
      </li>
    )

  const railGroups: RepoGroup[] = useMemo(() => [...tree.pinned, ...tree.repos, ...tree.quiet], [tree])

  return (
    <nav className={`orc-plans${drag ? ' orc-plans--drag' : ''}`} aria-label={t('side.title')} onKeyDown={onTreeKeys} ref={navRef}>
      <div className="orc-sr-only" role="status" aria-live="polite">
        {announce}
      </div>
      <div className="orc-plans__slim">
        <button type="button" className="orc-plans__railbtn" aria-label={t('panel.plan.expand')} onClick={onToggle}>
          ›
        </button>
        <button
          type="button"
          className="orc-plans__railbtn"
          aria-label={t('side.searchAria')}
          title="⌘K"
          onClick={() => {
            if (!open) onToggle()
            setTimeout(() => field.current?.focus(), 0)
          }}
        >
          ⌕
        </button>
        {waitingCount > 0 ? (
          <button type="button" className="orc-plans__inboxdot" aria-label={t('side.inboxCount', { count: waitingCount })} onClick={onToggle}>
            {waitingCount}
          </button>
        ) : null}
        <ul className="orc-plans__badges">
          {railGroups.map((group) => (
            <li key={group.id}>
              <button
                type="button"
                className={`orc-plans__badge${group.members.some((m) => m.repo.root === repo.root) ? ' orc-plans__badge--current' : ''}${group.members.every((m) => m.repo.pinned) ? ' orc-plans__badge--pinned' : ''}`}
                aria-label={group.name}
                aria-current={group.members.some((m) => m.repo.root === repo.root) ? 'true' : undefined}
                title={group.name}
                onClick={() => pickGroup(group)}
              >
                {initials(group.name)}
                {group.attention > 0 ? (
                  <i className="orc-plans__dot orc-plans__dot--error" aria-hidden="true" />
                ) : group.waiting > 0 ? (
                  <i className="orc-plans__dot orc-plans__dot--warn" aria-hidden="true" />
                ) : group.running > 0 ? (
                  <i className="orc-plans__dot orc-plans__dot--run" aria-hidden="true" />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="orc-plans__wide">
        <div className="orc-plans__head">
          <h2 className="orc-plans__title">{t('panel.tab')}</h2>
          <button type="button" className="orc-plans__hide" aria-label={t('panel.plan.collapse')} onClick={onToggle}>
            ‹
          </button>
        </div>

        <div className="orc-side__searchbox">
          <input
            ref={field}
            className="orc-side__search"
            aria-label={t('side.searchAria')}
            placeholder={t('side.search')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setHitIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if (hits.length === 0) return
                setHitIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length)
                e.preventDefault()
                e.stopPropagation()
              } else if (e.key === 'Enter') {
                const hit = hits[hitIndex] ?? hits[0]
                if (hit) goHit(hit)
              } else if (e.key === 'Escape' && query) {
                setQuery('')
                e.stopPropagation()
              }
            }}
          />
          <kbd className="orc-side__kbd">⌘K</kbd>
        </div>
        {query.trim() ? (
          <div className="orc-side__hits" role="listbox" aria-label={t('side.searchAria')}>
            {hits.map((hit, i) => (
              <div key={`${hit.kind}:${hit.root}/${hit.planId ?? ''}/${hit.taskId ?? ''}`} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={i === hitIndex}
                  className={`orc-ghit__row${i === hitIndex ? ' orc-ghit__row--active' : ''}`}
                  onMouseEnter={() => setHitIndex(i)}
                  onClick={() => goHit(hit)}
                >
                  <span className="orc-ghit__kind">{hit.kind === 'repo' ? '▣' : hit.kind === 'plan' ? '◇' : '·'}</span>
                  <span className="orc-ghit__label">{hit.label}</span>
                  <span className="orc-ghit__hint">{hit.hint}</span>
                </button>
              </div>
            ))}
            {hits.length === 0 ? <div className="orc-side__empty">{t('side.searchEmpty')}</div> : null}
          </div>
        ) : null}

        <section className="orc-inbox" aria-label={t('side.inbox')} title={t('side.inboxHint')}>
          <h3 className="orc-side__head">
            {t('side.inbox')}
            {waitingCount > 0 ? ` · ${waitingCount}` : ''}
          </h3>
          {inbox.length === 0 ? (
            <p className="orc-side__calm">{t('side.inboxEmpty')}</p>
          ) : (
            <ul className="orc-inbox__list">
              {inboxRows.real.map(inboxRow)}
              {inboxRows.example.length > 0 ? (
                <li className="orc-inbox__divider" role="presentation">
                  {t('welcome.exampleLabel')}
                </li>
              ) : null}
              {inboxRows.example.map(inboxRow)}
            </ul>
          )}
        </section>

        <section className="orc-tree" aria-label={t('side.repos')}>
          <h3 className="orc-side__head">
            {t('side.repos')}
            <button
              type="button"
              className="orc-side__add"
              aria-label={t('side.addRepo')}
              aria-expanded={addingRepo}
              title={t('side.addRepo')}
              onClick={() => setAddingRepo((v) => !v)}
            >
              +
            </button>
            <button
              type="button"
              className="orc-side__gear"
              aria-label={t('side.reposMenu')}
              aria-haspopup="menu"
              title={t('side.reposMenu')}
              onClick={(e) => openMenu(e, [{ label: t('side.resetOrder'), disabled: !hasManualOrder, onPick: resetOrder }])}
            >
              <EllipsisGlyph />
            </button>
          </h3>
          {addingRepo ? (
            <AddRepo
              onDone={(root) => {
                setAddingRepo(false)
                if (!root) return
                openFold(`grp:${root}`)
                // The host refreshed before it answered: the repository opens on its plans, or on the
                // welcome flow when it has none yet.
                orchestraStore.openFirstWaiting(root)
              }}
            />
          ) : null}
          {action.error ? <p className="orc-error orc-plans__error">{action.error}</p> : null}
          <ul className="orc-tree__list">
            {tree.pinned.map((group) => groupRow(group, 'sec:pinned'))}
            {tree.repos.map((group) => groupRow(group, 'sec:repos'))}
            {bucket(t('side.quiet', { count: tree.quiet.length }), 'bucket:quiet', 'sec:quiet', tree.quiet, <QuietGlyph />)}
            {bucket(t('side.hidden', { count: tree.hidden.length }), 'bucket:hidden', 'sec:hidden', tree.hidden, <HiddenGlyph />)}
          </ul>
        </section>

        {toast ? <p className="orc-side__toast">{t('copyAgent.done')}</p> : null}
      </div>
      {menu ? <RowMenu menu={menu} onClose={closeMenu} /> : null}
      {drag ? (
        <div className="orc-sdrag" style={{ left: drag.left, top: drag.top, width: drag.width }} aria-hidden="true">
          <span className="orc-sdrag__name">{rowNames.get(drag.id) ?? drag.id}</span>
        </div>
      ) : null}
    </nav>
  )
}
