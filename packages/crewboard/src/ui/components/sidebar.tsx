import type { ProjectSummary } from '../../owner.js'
import { T } from '../text.js'

/** Every project with its goals (one conversation with the lead each) and how much waits for the owner in each. */
export function Sidebar(props: { projects: ProjectSummary[]; project?: string; goalId?: string; onPick: (project: string, goalId: string) => void; drawer: boolean; open: boolean }) {
  const hidden = props.drawer && !props.open
  return (
    <nav className={`side-nav ${props.drawer ? 'drawer' : ''} ${props.open ? 'on' : ''}`} aria-label={T.sidebar} {...(hidden ? { inert: '' as unknown as boolean } : {})}>
      <div className="brand">{T.appTitle}</div>
      {props.projects.map((p) => (
        <section key={p.repo} className="proj">
          <h2 title={p.repo}>{p.name}</h2>
          <ul>
            {p.goals.map((g) => {
              const current = p.repo === props.project && g.goalId === props.goalId
              const busy = g.counts.running + g.counts.queued
              return (
                <li key={g.goalId}>
                  <button
                    type="button"
                    className="goal-row press"
                    aria-current={current ? 'page' : undefined}
                    aria-label={`${g.title}${g.counts.waiting_owner ? `, ${T.waitingN(g.counts.waiting_owner)}` : ''}`}
                    onClick={() => props.onPick(p.repo, g.goalId)}
                  >
                    <span className="goal-title">{g.title}</span>
                    <span className="goal-meta">
                      {g.counts.waiting_owner > 0 && <span className="pill">{g.counts.waiting_owner}</span>}
                      <span>{busy > 0 ? T.inWork(busy) : g.counts.finished > 0 ? T.allFinished : ''}</span>
                      {!g.leadOnline && <span className="away">{T.leadAway}</span>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </nav>
  )
}
