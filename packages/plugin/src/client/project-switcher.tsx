import type { OrchestraSnapshot } from '../shared/types.js'
import { t, useLang } from './i18n.js'
import { type NowCopy, type NowProject, firstCopy, nowModel, nowProjects } from './now.js'
import { rememberFamilyCopy, useFamilyCopy } from './store.js'

/** How many families the compact strip shows before the rest move behind the search overflow. */
export const SWITCHER_TOP = 5

/**
 * The compact project switcher above the content: only the active, pinned and current families, in the
 * persisted then first-seen order, so a poll never moves a project. A family with several *relevant*
 * copies (one that holds plans, or the current one) offers them; the rest wait in the tree and ⌘K. The
 * remaining families are reachable through the existing search overflow.
 *
 * A family click reopens the exact physical copy the reader last used there (window memory), not simply the
 * one that looks busiest this poll; the chosen copy is named on the control whenever the family has a choice.
 */
export function ProjectSwitcher(props: {
  snapshot: OrchestraSnapshot
  currentRoot: string
  onOpen(copy: NowCopy): void
  /** Opens the existing ⌘K search for the families the strip does not show. */
  onMore?(): void
}) {
  useLang()
  const familyCopy = useFamilyCopy()
  const { snapshot, currentRoot } = props
  const projects = nowProjects(snapshot, nowModel(snapshot, snapshot.order), currentRoot)
  if (projects.length < 2) return null
  // Foreground only what is active/pinned/current; a quiet family is not dumped into the strip.
  const foreground = projects.filter((project) => project.active || project.pinned || project.current)
  const visible = foreground.slice(0, SWITCHER_TOP)
  const hidden = projects.length - visible.length
  const rememberedOf = (project: NowProject): NowCopy | undefined => {
    const root = familyCopy(project.id)
    return root ? project.copies.find((item) => item.root === root) : undefined
  }
  const relevantCopies = (project: NowProject): NowCopy[] => {
    const withPlans = project.copies.filter((copy) => copy.current || copy.plans > 0)
    const base = withPlans.length > 0 ? withPlans : project.copies.slice(0, 1)
    // A remembered copy that carries no plan right now stays selectable, so the reader can return to it.
    const remembered = rememberedOf(project)
    return remembered && !base.includes(remembered) ? [...base, remembered] : base
  }
  return (
    <nav className="orc-project-switcher" aria-label={t('now.projects')} data-project-switcher>
      <span className="orc-project-switcher__title">{t('now.projects')}</span>
      <ul className="orc-project-switcher__list">
        {visible.map((project) => {
          const copies = relevantCopies(project)
          const copy = rememberedOf(project) ?? firstCopy(project)
          const human = project.copies.reduce((n, item) => n + item.human, 0)
          const work = project.copies.reduce((n, item) => n + item.work, 0)
          const alerts = project.copies.reduce((n, item) => n + item.alerts, 0)
          const open = (target: NowCopy | undefined) => {
            if (!target) return
            rememberFamilyCopy(project.id, target.root)
            props.onOpen(target)
          }
          return (
            <li key={project.id} className={`orc-project-switcher__item${project.current ? ' orc-project-switcher__item--current' : ''}${project.active ? ' orc-project-switcher__item--active' : ''}`}>
              <button
                type="button"
                className={`orc-project-switcher__proj${project.current ? ' orc-project-switcher__proj--current' : ''}${project.pinned ? ' orc-project-switcher__proj--pinned' : ''}`}
                aria-current={project.current ? 'true' : undefined}
                title={project.copies.map((item) => `${item.copy ?? t('now.main')} — ${item.root}`).join('\n')}
                onClick={() => open(copy)}
              >
                {project.name}
                {copies.length > 1 && copy ? <span className="orc-project-switcher__copy-name">{copy.copy ?? t('now.main')}</span> : null}
                {human > 0 ? <i className="orc-project-switcher__mark orc-project-switcher__mark--human" aria-hidden="true" /> : null}
                {work > 0 ? <i className="orc-project-switcher__mark orc-project-switcher__mark--work" aria-hidden="true" /> : null}
                {alerts > 0 ? <i className="orc-project-switcher__mark orc-project-switcher__mark--alert" aria-hidden="true" /> : null}
              </button>
              {copies.length > 1 ? (
                <select
                  className="orc-project-switcher__copy"
                  aria-label={`${project.name} — ${t('now.copy')}`}
                  value={copy?.root ?? ''}
                  onChange={(event) => {
                    const target = copies.find((item) => item.root === event.target.value)
                    if (target) open(target)
                  }}
                >
                  {copies.map((item) => <option key={item.root} value={item.root}>{item.copy ?? t('now.main')}</option>)}
                </select>
              ) : null}
            </li>
          )
        })}
      </ul>
      {hidden > 0 && props.onMore ? (
        <button type="button" className="orc-project-switcher__more" onClick={props.onMore}>{t('now.moreProjects', { count: hidden })}</button>
      ) : null}
    </nav>
  )
}
