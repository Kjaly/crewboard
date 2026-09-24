import { expect, it } from 'vitest'
import { compareSemver } from '../src/util/semver.js'

it('compares dotted versions numerically', () => {
  expect(compareSemver('1.18.30', '1.18.30')).toBe(0)
  expect(compareSemver('1.18.31', '1.18.30')).toBe(1)
  expect(compareSemver('1.9.0', '1.18.0')).toBe(-1)
  expect(compareSemver('3000.11.1', '3000')).toBe(1)
})
