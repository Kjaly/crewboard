import { homedir } from 'node:os'
import { join } from 'node:path'

/** `CREWBOARD_HOME` replaces `~/.crewboard` (tests, several installs side by side). */
export const crewboardHome = (env: NodeJS.ProcessEnv): string => env.CREWBOARD_HOME || join(homedir(), '.crewboard')
export const projectDir = (repo: string): string => join(repo, '.crewboard')
export const goalDir = (repo: string, goalId: string): string => join(projectDir(repo), 'goals', goalId)
export const runsDir = (repo: string): string => join(projectDir(repo), 'runs')
export const worktreesDir = (repo: string): string => join(projectDir(repo), 'worktrees')
