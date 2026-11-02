import { en } from './i18n/en.js'
import { ru, type Strings } from './i18n/ru.js'

export type Lang = 'en' | 'ru'
const dictionaries: Record<Lang, Strings> = { en, ru }
const KEY = 'crewboard.lang'

/** The screen's strings in the current language. A live binding: components read it on every render. */
export let T: Strings = ru
export let lang: Lang = 'ru'

/** Switches every string on screen; the caller re-renders. The choice is remembered for the next visit. */
export function setLang(next: Lang, remember = false): void {
  lang = next
  T = dictionaries[next]
  if (typeof document !== 'undefined') document.documentElement.lang = next
  if (!remember) return
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // Storage unavailable: the choice lasts until the page closes.
  }
}

/** The remembered language, else the browser's: Russian for a Russian browser, English otherwise. */
export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'en' || saved === 'ru') return saved
  } catch {
    // Fall through to the browser language.
  }
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

export const MCP_COMMAND = (origin: string) => `claude mcp add --transport http crewboard ${origin}/mcp`
