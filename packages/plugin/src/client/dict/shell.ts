/**
 * dsh calls a slot's `label`/`title` outside React, at its own render points (mount, an entries
 * change, its own locale switching) — never because our lazily loaded dictionary (`dict-<lang>.js`)
 * finished landing. `t()` stays blank until that script runs, so the three strings dsh reads this way
 * at boot — the sidebar entry name, its hover-title base, and the Settings section name — live here
 * too, in the always-loaded client bundle, instead of only in the lazy one. Kept in sync with
 * `notify.badge`/`settings.section`/`panel.tab` in `dict/en.ts` and `dict/ru.ts` by
 * `test/client/shell-labels.test.ts`.
 */
type Lang = 'en' | 'ru'

export type ShellLabelKey = 'notify.badge' | 'settings.section' | 'panel.tab'

export const SHELL_LABELS: Record<Lang, Record<ShellLabelKey, string>> = {
  en: { 'notify.badge': 'Orchestration', 'settings.section': 'Crewboard', 'panel.tab': 'Orchestration' },
  ru: { 'notify.badge': 'Оркестрация', 'settings.section': 'Crewboard', 'panel.tab': 'Оркестрация' },
}
