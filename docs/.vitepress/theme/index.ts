import DefaultTheme from 'vitepress/theme'
import { useData, useRoute } from 'vitepress'
import { computed, defineComponent, h, nextTick, onMounted, ref, watch } from 'vue'
import './custom.css'

/**
 * The guides show screenshots as <picture> pairs keyed to the system theme, which GitHub honours. On the site the
 * theme switch wins instead: the dark source applies exactly while the site is dark.
 */
const syncPictures = (dark: boolean) => {
  for (const source of document.querySelectorAll<HTMLSourceElement>('picture source[data-scheme="dark"], picture source[media*="prefers-color-scheme: dark"]')) {
    source.dataset.scheme = 'dark'
    source.media = dark ? 'all' : 'not all'
  }
}

const phones = import.meta.glob<string>('../../assets/*/mobile-*.png', { eager: true, query: '?url', import: 'default' })

/** The home hero shows the phone screen in the page's language and the site's theme. */
const HeroPhone = defineComponent({
  setup() {
    const { isDark, lang } = useData()
    // The theme is known only in the browser: render after mounting, so hydration never keeps the server's guess.
    const mounted = ref(false)
    onMounted(() => {
      mounted.value = true
    })
    const src = computed(() => phones[`../../assets/${lang.value === 'ru' ? 'ru' : 'en'}/mobile-${isDark.value ? 'dark' : 'light'}.png`])
    return () => (mounted.value ? h('img', { class: 'hero-phone', src: src.value, alt: '' }) : null)
  },
})

const Layout = defineComponent({
  setup() {
    const { isDark } = useData()
    const route = useRoute()
    const sync = () => nextTick(() => syncPictures(isDark.value))
    onMounted(sync)
    watch(isDark, sync)
    watch(() => route.path, sync)
    return () => h(DefaultTheme.Layout, null, { 'home-hero-image': () => h(HeroPhone) })
  },
})

export default { extends: DefaultTheme, Layout }
