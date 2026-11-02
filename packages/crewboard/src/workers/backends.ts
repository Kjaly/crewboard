import { createBackends, nodeExec } from '@crewboard/core'
import { runsDir } from '../store/paths.js'
import type { BackendFor } from './pool.js'

/** Core's real worker backends for one repository, with run records under `<repo>/.crewboard/runs`. */
export function realBackendFor(o: { repo: string; env: NodeJS.ProcessEnv; home: string }): BackendFor {
  const backends = createBackends({ env: o.env, home: o.home, exec: nodeExec, root: o.repo, runsRoot: runsDir(o.repo) })
  return (agent) => backends.forAgent(agent)
}
