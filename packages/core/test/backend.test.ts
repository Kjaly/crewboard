import { describe, expect, it } from 'vitest'
import { dshModel, isDshAgent } from '../src/backend/types.js'

describe('dsh agent names', () => {
  it('recognises dsh agents and their model', () => {
    expect(isDshAgent('dsh')).toBe(true)
    expect(isDshAgent('dsh/deepseek-flash')).toBe(true)
    expect(isDshAgent('deepseek-flash')).toBe(false)
    expect(isDshAgent('dshx')).toBe(false)
    expect(dshModel('dsh')).toBeUndefined()
    expect(dshModel('dsh/deepseek-flash')).toBe('deepseek-flash')
  })
})
