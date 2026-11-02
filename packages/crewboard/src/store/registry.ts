import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic.js'
import { crewboardHome } from './paths.js'

/** The repositories this machine's Crewboard knows: `~/.crewboard/projects.json`. */
export function createRegistry(env: NodeJS.ProcessEnv) {
  const path = join(crewboardHome(env), 'projects.json')
  const list = async (): Promise<string[]> => {
    try {
      return (JSON.parse(await readFile(path, 'utf8')) as { projects: string[] }).projects
    } catch {
      return []
    }
  }
  return {
    list,
    async add(repo: string): Promise<void> {
      const projects = await list()
      if (!projects.includes(repo)) await writeJsonAtomic(path, { projects: [...projects, repo] })
    },
  }
}
