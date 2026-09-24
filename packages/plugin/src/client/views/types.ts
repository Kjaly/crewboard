import type { RepoSnapshot, WorkerInfo } from '../../shared/types.js'
import type { Density, Lens } from '../store.js'

/** Every view renders the same plan and the same selection; Task 4's graph uses this shape too. */
export type ViewProps = {
  repo: RepoSnapshot
  workers?: readonly WorkerInfo[]
  selectedId: string | null
  onSelect(id: string | null): void
  density: Density
  toggleDensity?(): void
  /** The active lens: views dim non-matching tasks in place — nothing is ever hidden. */
  lens?: Lens | null
  setLens?(lens: Lens | null): void
  /** A lens walk (`n` / «›»): the seq bumps on every step so the same id can be walked to twice. */
  walk?: { id: string; seq: number } | null
  lensStep?(dir: 1 | -1): void
}
