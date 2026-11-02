// Writes the npm package's README from the repository's README, so npm shows what GitHub shows. npm renders links
// relative to nothing, so every relative link becomes absolute: images to their raw files, the rest to GitHub.
// Runs before every pack and publish (the package's `prepack`); the generated file is not kept in git.
//
//   node scripts/package-readme.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO = 'https://github.com/Kjaly/crewboard'
const RAW = 'https://raw.githubusercontent.com/Kjaly/crewboard/main'

/** One link target as npm must see it; absolute links and in-page anchors stay as they are. */
export const absolute = (target) => {
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return target
  const path = target.replace(/^\.\//, '')
  if (/\.(png|jpe?g|gif|svg|webp)(#.*)?$/i.test(path)) return `${RAW}/${path}`
  return `${REPO}/blob/main/${path}`
}

/** The README with every Markdown link and image, and every `src`, `srcset` and `href` attribute, made absolute. */
export const packageReadme = (text) =>
  text
    .replace(/(\]\()([^)\s]+)(\))/g, (_m, open, target, close) => `${open}${absolute(target)}${close}`)
    .replace(/\b(src|srcset|href)="([^"]+)"/g, (_m, name, target) => `${name}="${absolute(target)}"`)

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('..', import.meta.url)
  writeFileSync(new URL('packages/crewboard/README.md', root), packageReadme(readFileSync(new URL('README.md', root), 'utf8')))
}
