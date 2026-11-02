import { join } from 'node:path'
import { homedir } from 'node:os'
import { claudeProjectSlug, claudeProjectsDir } from '@crewboard/core'

/** Where Claude Code keeps its transcripts (core's rule: `CREWBOARD_CLAUDE_PROJECTS` overrides). Read only. */
export const claudeProjectsRoot = (env: NodeJS.ProcessEnv): string => claudeProjectsDir(env, homedir())

/** Claude Code's folder for a working directory: every character but a Latin letter or digit becomes `-`. */
export const projectFolder = (absPath: string): string => claudeProjectSlug(absPath)

/** Where Codex keeps its session ("rollout") files: `CREWBOARD_CODEX_SESSIONS`, else `~/.codex/sessions`. */
export const codexSessionsRoot = (env: NodeJS.ProcessEnv): string => env.CREWBOARD_CODEX_SESSIONS || join(homedir(), '.codex', 'sessions')

/** Where dsh keeps its sessions: `CREWBOARD_DSH_SESSIONS`, else `~/.dsh/sessions`. */
export const dshSessionsRoot = (env: NodeJS.ProcessEnv): string => env.CREWBOARD_DSH_SESSIONS || join(homedir(), '.dsh', 'sessions')
