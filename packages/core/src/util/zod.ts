import { config } from 'zod/mini'
import { $ZodError } from 'zod/v4/core'
import en from 'zod/v4/locales/en.js'

/**
 * The one door to zod: `import * as z from '../util/zod.js'`. Schemas use `zod/mini` — the functional
 * API tree-shakes to a few kilobytes, where classic zod put ~800 KB into every bundle that inlines core.
 * Two things classic did implicitly are done here instead: English issue messages (mini ships no locale
 * by default; plans, drafts and repair prompts quote those messages) and a way to recognise a validation
 * error, whose `name` is `$ZodError` in mini, not `ZodError`.
 *
 * Re-export with `export *`, never as one `z` object: a namespace that escapes as a value cannot be
 * tree-shaken, and the bundles would carry every locale and every schema type zod has.
 */
config(en())

export * from 'zod/mini'

/** A schema rejected its input; `message` is the JSON list of issues, `issues` the issues themselves. */
export const isSchemaError = (err: unknown): err is $ZodError => err instanceof $ZodError
