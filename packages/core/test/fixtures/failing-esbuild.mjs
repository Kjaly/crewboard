// Preloaded with `node --import` into a build script: `esbuild` resolves to a stand-in that writes the
// first bundle half-way and fails on the second, like a build that breaks in the middle of its output.
import { registerHooks } from 'node:module'

const FAKE = new URL('./failing-esbuild-module.mjs', import.meta.url).href

registerHooks({
  resolve: (specifier, context, next) => (specifier === 'esbuild' ? { url: FAKE, shortCircuit: true } : next(specifier, context)),
})
