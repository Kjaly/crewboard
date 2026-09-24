import { bindClientService, type ClientContext, type ClientServices } from './dsh.js'
import { useSyncExternalStore } from 'react'

export type Lang = 'ru' | 'en'
type Vars = Record<string, string | number>
type Forms = { one: string; few?: string; many?: string; other?: string }
type Entry = string | Forms

type Dictionary = Record<string, Entry>
type LocaleFace = ClientServices['locale']
/**
 * One i18n state per page. dsh may re-apply the plugin client without a reload, and lazy screens resolve
 * shared modules through whichever instance wrote `__orchScreenRequire` last — so every instance and
 * screen reads and writes this one object, and the parts mounted by different instances cannot disagree.
 * Text stays empty while `waiting` (the active language is not in yet): a raw key or an English flash for
 * a Russian reader is worse than a blank frame. `revision` moves on every change so hooks re-render.
 * `adoption` numbers every language change: a dictionary load that resolves after a newer one is dropped.
 */
type I18nStore = {
  language: Lang
  waiting: boolean
  revision: number
  adoption: number
  listeners: Set<() => void>
  pending: Map<Lang, Promise<void>>
  /** The live locale binding: a newer plugin instance takes it over. */
  binding?: { stop(): void }
  /** Russian added to dsh's catalog by this plugin, kept across instances bound to the same service. */
  registration?: { locale: LocaleFace; remove(): void }
}
declare global {
  var __orchDictionaries: Partial<Record<Lang, Dictionary>> | undefined
  var __crewboardI18n: I18nStore | undefined
}
// One shared object: the dictionary assets (`dict-*-entry.ts`) write into the same global.
globalThis.__orchDictionaries ??= {}
const dictionaries: Partial<Record<Lang, Dictionary>> = globalThis.__orchDictionaries
globalThis.__crewboardI18n ??= { language: 'en', waiting: false, revision: 0, adoption: 0, listeners: new Set(), pending: new Map() }
const store: I18nStore = globalThis.__crewboardI18n
const emit = () => { store.revision++; store.listeners.forEach((listener) => { listener() }) }
const markReady = () => { if (store.waiting) { store.waiting = false; emit() } }
const activate = (lang: Lang) => {
  if (store.language === lang) return
  store.language = lang
  emit()
}

export function installDictionary(lang: Lang, dictionary: Dictionary): void {
  dictionaries[lang] = dictionary
  emit()
}

export function loadLang(lang: Lang): Promise<void> {
  if (dictionaries[lang]) return Promise.resolve()
  const existing = store.pending.get(lang)
  if (existing) return existing
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `/crewboard/assets/dict-${lang}.js`
    script.async = true
    script.onload = () => dictionaries[lang] ? resolve() : reject(new Error(`Dictionary ${lang} did not register`))
    script.onerror = () => reject(new Error(`Dictionary ${lang} could not load`))
    document.head.append(script)
  }).finally(() => store.pending.delete(lang))
  store.pending.set(lang, promise)
  return promise
}

export function setLang(lang: Lang): void {
  const ticket = ++store.adoption
  if (dictionaries[lang]) { activate(lang); return }
  void loadLang(lang).then(() => { if (ticket === store.adoption) activate(lang) }).catch(() => {
    if (ticket === store.adoption && dictionaries.en) activate('en')
  })
}

export function subscribeLang(listener: () => void): () => void {
  store.listeners.add(listener)
  return () => store.listeners.delete(listener)
}

export function getLang(): Lang { return store.language }
/** Subscribe a screen to live language changes while retaining t() as the string API. */
const getRevision = () => store.revision
export function useLang(): Lang {
  useSyncExternalStore(subscribeLang, getRevision, getRevision)
  return store.language
}

function plural(entry: Entry, count: number, lang: Lang): string {
  if (typeof entry === 'string') return entry
  const category = new Intl.PluralRules(lang).select(count)
  return entry[category as keyof Forms] ?? entry.other ?? entry.one
}

export function t(key: string, vars: Vars = {}): string {
  if (store.waiting) return ''
  const language = store.language
  const primary = dictionaries.en?.[key]
  const localized = dictionaries.ru?.[key]
  const entry = language === 'ru' ? (localized ?? primary) : primary
  if (entry === undefined) return key
  const count = typeof vars.count === 'number' ? vars.count : typeof vars.n === 'number' ? vars.n : undefined
  const value = count === undefined ? (typeof entry === 'string' ? entry : entry.other ?? entry.one) : plural(entry, count, language)
  return value.replace(/\{([\w]+)\}/g, (match, name: string) => vars[name] === undefined ? match : String(vars[name]))
}

const langOf = (id: string | undefined): Lang => id?.toLowerCase().split('-')[0] === 'ru' ? 'ru' : 'en'

/**
 * Follow dsh's snapshot and own exactly one subscription per page. A newer plugin instance (dsh re-applied
 * the client without a reload) takes the binding over, so the whole page follows one locale service.
 */
export function bindLocale(ctx: ClientContext): void {
  const binding = { stop: () => {} }
  const previous = store.binding
  store.binding = binding
  previous?.stop()
  const current = () => store.binding === binding
  // Blank only while a needed dictionary is missing; one already installed renders at once.
  if (!dictionaries.en && !store.waiting) { store.waiting = true; emit() }
  let localeSeen = false
  // Without a locale service (or before it answers) English is the language; it must not wait forever.
  void loadLang('en').then(() => { if (!localeSeen && current()) markReady() }, () => { if (!localeSeen && current()) markReady() })
  binding.stop = bindClientService(ctx, 'locale', (locale) => {
    const adopt = () => {
      if (!current()) return
      localeSeen = true
      const ticket = ++store.adoption
      const lang = langOf(locale.getSnapshot().active)
      if (dictionaries.en && dictionaries[lang]) { activate(lang); markReady(); return }
      if (!store.waiting) { store.waiting = true; emit() }
      // The load that finishes applies what dsh shows now, and only while no newer adoption started.
      const settle = () => {
        if (ticket !== store.adoption || !current()) return
        const now = langOf(locale.getSnapshot().active)
        activate(dictionaries.en && dictionaries[now] ? now : 'en')
        markReady()
      }
      void Promise.all([loadLang('en'), loadLang(lang)]).then(settle, settle)
    }
    registerRussian(locale)
    adopt()
    const unsubscribe = locale.subscribe(adopt)
    return () => {
      unsubscribe()
      // A newer instance bound to the same service keeps the registration; only the last one out removes it.
      if (!current() || store.registration?.locale !== locale) return
      store.registration.remove()
      store.registration = undefined
    }
  })
}

/**
 * Makes Russian selectable in dsh's Language row (the plugin carries its own Russian dictionary). A second
 * instance on the same service reuses the first one's entry instead of registering again; a pack that
 * registered Russian first (a shell language pack) owns the entry.
 */
function registerRussian(locale: LocaleFace): void {
  if (store.registration?.locale === locale) return
  store.registration?.remove()
  store.registration = undefined
  try { store.registration = { locale, remove: locale.addLanguage({ id: 'ru', label: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439', fallback: 'en' }) } }
  catch (error) {
    // A pre-existing Russian pack is owned by the shell or another plugin.
    if (!(error instanceof Error && /already registered|already exists|duplicate/i.test(error.message))) throw error
  }
}

/** Match dsh's relative-time buckets: minute/hour/day, 30-day month, 365-day year. */
export function relativeTime(at: number | Date, now: number | Date = Date.now()): string {
  const diff = Math.max(0, new Date(now).getTime() - new Date(at).getTime())
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return t('relative.now')
  if (diff < hour) return agoUnit('minute', Math.floor(diff / minute))
  if (diff < day) return agoUnit('hour', Math.floor(diff / hour))
  if (diff < 30 * day) return agoUnit('day', Math.floor(diff / day))
  if (diff < 365 * day) return agoUnit('month', Math.floor(diff / (30 * day)))
  return agoUnit('year', Math.floor(diff / (365 * day)))
}
function agoUnit(unit: string, n: number): string {
  const key = `relative.${unit}`
  const phrase = t(key, { n })
  return t('relative.ago', { t: phrase })
}
