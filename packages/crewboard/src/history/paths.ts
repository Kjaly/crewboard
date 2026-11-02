import { homedir } from 'node:os'
import { claudeProjectSlug, claudeProjectsDir } from '@crewboard/core'

/** Where Claude Code keeps its transcripts (core's rule: `CREWBOARD_CLAUDE_PROJECTS` overrides). Read only. */
export const claudeProjectsRoot = (env: NodeJS.ProcessEnv): string => claudeProjectsDir(env, homedir())

/** Claude Code's folder for a working directory: every character but a Latin letter or digit becomes `-`. */
export const projectFolder = (absPath: string): string => claudeProjectSlug(absPath)
