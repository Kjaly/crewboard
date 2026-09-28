import { cliT, type Lang, programName } from './i18n.js'

const MARK = '\u0000'
// The help columns are laid out for the four-letter `orch`: a longer name shifts every indented line with it.
const TEMPLATE_WIDTH = 'orch'.length

function withProgram(text: string): string {
  const name = programName()
  const pad = ' '.repeat(Math.max(0, name.length - TEMPLATE_WIDTH))
  return text
    .split('\n')
    .map((line) => (line.startsWith(`  ${MARK} `) ? line : /^ {6,}\S/.test(line) ? pad + line : line))
    .join('\n')
    .replaceAll(MARK, name)
}

/** The full command reference (`{prog} help all`): every command, once a newcomer no longer needs the short page (cl2). */
export const helpAll = (lang: Lang): string => {
  const mark = { prog: MARK }
  return withProgram(`${cliT(lang, 'help.body', mark)}\n${cliT(lang, 'presets.help', mark)}\n${cliT(lang, 'repo.help', mark)}\n${cliT(lang, 'defaultBase.help', mark)}\n${cliT(lang, 'draft.usage', mark)}\n`)
}

/** The short «start here» page (`{prog}`, `{prog} --help`, `{prog} help`): the five commands a newcomer needs first (cl2). */
export const helpShort = (lang: Lang): string => withProgram(cliT(lang, 'help.short', { prog: MARK }))
