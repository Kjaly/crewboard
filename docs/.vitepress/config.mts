import { posix } from 'node:path'
import { defineConfig, type DefaultTheme } from 'vitepress'

const repo = 'https://github.com/Kjaly/crewboard'

const guide = (prefix: string, items: Array<[string, string]>): DefaultTheme.SidebarItem[] => items.map(([text, page]) => ({ text, link: `${prefix}${page}` }))

const enSidebar: DefaultTheme.Sidebar = [
  {
    text: 'Guide',
    items: guide('/en/', [
      ['Getting started', 'getting-started'],
      ['The lead', 'lead'],
      ['Workers', 'workers'],
      ['The screen', 'screen'],
      ['Costs', 'costs'],
      ['Troubleshooting', 'troubleshooting'],
    ]),
  },
  { text: 'Project', items: [{ text: 'Architecture', link: '/architecture' }, { text: 'Releasing', link: '/releasing' }] },
]

const ruSidebar: DefaultTheme.Sidebar = [
  {
    text: 'Руководство',
    items: guide('/ru/', [
      ['Начало работы', 'getting-started'],
      ['Ведущий', 'lead'],
      ['Исполнители', 'workers'],
      ['Экран', 'screen'],
      ['Затраты', 'costs'],
      ['Если что-то не так', 'troubleshooting'],
    ]),
  },
  { text: 'Для разработчиков (English)', items: [{ text: 'Architecture', link: '/architecture' }, { text: 'Releasing', link: '/releasing' }] },
]

/** A guide's link to a repository file outside docs/ (SECURITY.md, CONTRIBUTING.md) opens that file on GitHub. */
const repoLinks = (md: { renderer: { rules: Record<string, any> } }) => {
  const base = md.renderer.rules.link_open ?? ((tokens: any, idx: number, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens: any, idx: number, options: any, env: any, self: any) => {
    const href: string | null = tokens[idx].attrGet('href')
    if (href && !/^[a-z]+:|^#|^\//i.test(href)) {
      const target = posix.normalize(posix.join('docs', posix.dirname(env.relativePath ?? ''), href))
      if (!target.startsWith('docs/')) tokens[idx].attrSet('href', `${repo}/blob/main/${target.replace(/\/$/, '')}`)
    }
    return base(tokens, idx, options, env, self)
  }
}

export default defineConfig({
  markdown: { config: repoLinks },
  title: 'Crewboard',
  description: 'Lead your coding agents from one chat, and see what they are doing.',
  base: '/crewboard/',
  cleanUrls: true,
  lastUpdated: true,
  // Dated design records and the GitHub index stay on GitHub only.
  srcExclude: ['README.md', 'notes/**', 'superpowers/**', 'audits/**', 'evals/**'],
  head: [
    ['meta', { name: 'theme-color', content: '#111113' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap' }],
  ],
  locales: {
    root: {
      label: 'English',
      lang: 'en',
      link: '/en/',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/en/getting-started', activeMatch: '/en/' },
          { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
        ],
        sidebar: { '/en/': enSidebar, '/architecture': enSidebar, '/releasing': enSidebar },
        editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
        footer: { message: 'Released under the MIT License.' },
      },
    },
    ru: {
      label: 'Русский',
      lang: 'ru',
      link: '/ru/',
      themeConfig: {
        nav: [
          { text: 'Руководство', link: '/ru/getting-started', activeMatch: '/ru/' },
          { text: 'Изменения', link: `${repo}/blob/main/CHANGELOG.md` },
        ],
        sidebar: { '/ru/': ruSidebar },
        editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'Исправить страницу на GitHub' },
        footer: { message: 'Распространяется по лицензии MIT.' },
        outline: { label: 'На этой странице' },
        docFooter: { prev: 'Назад', next: 'Дальше' },
        lastUpdated: { text: 'Обновлено' },
        darkModeSwitchLabel: 'Тема',
        sidebarMenuLabel: 'Меню',
        returnToTopLabel: 'Наверх',
        langMenuLabel: 'Язык',
      },
    },
  },
  themeConfig: {
    socialLinks: [{ icon: 'github', link: repo }],
    search: {
      provider: 'local',
      options: {
        locales: {
          ru: {
            translations: {
              button: { buttonText: 'Поиск', buttonAriaLabel: 'Поиск' },
              modal: { noResultsText: 'Ничего не найдено', resetButtonTitle: 'Сбросить', footer: { selectText: 'выбрать', navigateText: 'перейти', closeText: 'закрыть' } },
            },
          },
        },
      },
    },
  },
})
