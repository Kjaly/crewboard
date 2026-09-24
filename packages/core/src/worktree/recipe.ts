import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from '../util/zod.js'
import { CREWBOARD_DIR } from '../plan/store.js'

const recipeShape = {
  setup: z._default(z.array(z.union([z.string().check(z.minLength(1)), z.object({ copy: z.string().check(z.minLength(1)) })])), []),
  env: z._default(z.object({ unset: z._default(z.array(z.string()), []) }), { unset: [] }),
  baseline: z.optional(z.string()),
  timeoutSec: z._default(z.number().check(z.int(), z.positive()), 300),
}
export const RecipeSchema = z.object(recipeShape)
/** What a save accepts: the same fields, and an unknown top-level key is refused rather than dropped. */
const StrictRecipeSchema = z.strictObject(recipeShape)
export type Recipe = z.infer<typeof RecipeSchema>
export const EMPTY_RECIPE: Recipe = RecipeSchema.parse({})

export async function loadRecipe(root: string): Promise<Recipe | null> {
  let raw: string
  try {
    raw = await readFile(join(root, CREWBOARD_DIR, 'recipes.json'), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return RecipeSchema.parse(JSON.parse(raw))
}

export async function saveRecipe(root: string, input: unknown): Promise<Recipe> {
  const recipe = StrictRecipeSchema.parse(input)
  if (recipe.setup.length > 30 || recipe.setup.some((step) => (typeof step === 'string' ? step : step.copy).length > 1000) || (recipe.baseline?.length ?? 0) > 1000 || recipe.timeoutSec > 3600) throw new RangeError('Recipe is too large')
  const dir = join(root, CREWBOARD_DIR)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'recipes.json')
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try { await writeFile(tmp, `${JSON.stringify(recipe, null, 2)}\n`); await rename(tmp, file) } finally { await rm(tmp, { force: true }) }
  return recipe
}

/** Suggestions are strings only. Nothing here executes them. */
export async function detectRecipe(root: string): Promise<Recipe> {
  const has = (file: string) => stat(join(root, file)).then(() => true, () => false)
  let setup: string[] = []
  let baseline: string | undefined
  if (await has('pnpm-lock.yaml')) { setup = ['pnpm install --frozen-lockfile']; baseline = 'pnpm test' }
  else if (await has('package-lock.json')) { setup = ['npm ci']; baseline = 'npm test' }
  else if (await has('uv.lock')) { setup = ['uv sync --frozen']; baseline = 'uv run pytest' }
  else if (await has('poetry.lock')) { setup = ['poetry install']; baseline = 'poetry run pytest' }
  else if (await has('requirements.txt')) { setup = ['python -m pip install -r requirements.txt']; baseline = 'python -m pytest' }
  if (await has('Makefile')) {
    const make = await readFile(join(root, 'Makefile'), 'utf8')
    if (/^test\s*:/m.test(make)) baseline = 'make test'
  }
  return RecipeSchema.parse({ setup, ...(baseline ? { baseline } : {}), timeoutSec: 300 })
}
