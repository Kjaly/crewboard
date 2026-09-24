import { expect, it } from 'vitest'
import { PLAN_DRAFT_JSON_SCHEMA, PlanDraftSchema } from '../src/plan/draft.js'
import * as z from '../src/util/zod.js'

// The schema handed to workers is written out so no bundle carries zod's generator; it must stay exactly
// what the generator makes of the zod schema the drafts are validated with.
it('the written-out draft JSON Schema is what zod generates from PlanDraftSchema', () => {
  const { $schema: _drop, ...generated } = z.toJSONSchema(PlanDraftSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  expect(PLAN_DRAFT_JSON_SCHEMA).toStrictEqual(generated)
})
