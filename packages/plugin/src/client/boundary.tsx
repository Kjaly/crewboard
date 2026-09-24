import { Component, type ReactNode } from 'react'
import { t } from './i18n.js'

type Props = { area: string; children: ReactNode }
type State = { error: Error | null }

/**
 * Keeps one failing part of the screen from blanking the rest: dsh drops the whole main slot when a
 * render throws. React offers error boundaries only as class components.
 */
export class PartBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return <div className="orc-broken" role="alert">
      <p>{t('panel.app.partFailed', { area: this.props.area })}</p>
      <code>{error.message}</code>
      <button type="button" className="orc-chip" onClick={() => this.setState({ error: null })}>{t('panel.app.partRetry')}</button>
    </div>
  }
}
