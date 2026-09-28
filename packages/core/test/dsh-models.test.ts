import { describe, expect, it } from 'vitest'
import { DSH_DEFAULT_PROVIDER, dshSelectionOf, dshSelectionOfId, dshWorkerId, readDshCatalog, sameDshSelection } from '../src/dsh/models.js'
import { dshModel } from '../src/backend/types.js'

describe('dsh model ids (pv1)', () => {
  it('V-pv1/dsh-id reads the old id as a model of the DeepSeek route and the new one as provider/model', () => {
    expect(dshSelectionOfId('dsh/deepseek-flash')).toEqual({ provider: DSH_DEFAULT_PROVIDER, model: 'deepseek-flash' })
    expect(dshSelectionOfId('dsh/openrouter/anthropic/claude-x')).toEqual({ provider: 'openrouter', model: 'anthropic/claude-x' })
    expect(dshSelectionOfId('dsh')).toBeUndefined()
    expect(dshSelectionOfId('devin')).toBeUndefined()
  })

  it('V-pv1/dsh-id round-trips a catalog model through its worker id and the run model string', () => {
    const id = dshWorkerId('deepseek-official', 'deepseek-flash')
    expect(id).toBe('dsh/deepseek-official/deepseek-flash')
    expect(sameDshSelection(dshSelectionOfId(id), dshSelectionOfId('dsh/deepseek-flash'))).toBe(true)
    expect(dshSelectionOf(dshModel('dsh/pi/m/x')!)).toEqual({ provider: 'pi', model: 'm/x' })
  })

  it('keeps only well-formed providers and models of the host catalog', () => {
    const catalog = readDshCatalog({
      default: { provider: 'deepseek-official', model: 'deepseek-flash' },
      groups: [
        { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek V4 Flash' }, { id: 'deepseek-v4-pro' }, { name: 'no id' }] },
        { id: 'bad/provider', name: 'Bad', models: [{ id: 'x', name: 'X' }] },
        'junk',
      ],
      failures: [{ id: 'openrouter', name: 'OpenRouter', message: 'boom' }, {}],
    })
    expect(catalog).toEqual({
      groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek V4 Flash' }, { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }] }],
      failures: [{ id: 'openrouter', name: 'OpenRouter', message: 'boom' }],
    })
    expect(readDshCatalog(undefined)).toBeUndefined()
    expect(readDshCatalog({ groups: 'nope' })).toBeUndefined()
  })
})
