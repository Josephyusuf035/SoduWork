import test from 'node:test'
import assert from 'node:assert/strict'
import { compareModelProviders } from '../src/screens/model-provider-order.js'

const provider = (id, overrides = {}) => ({
  id,
  name: id,
  enabled: true,
  builtin: false,
  ...overrides,
})

test('custom model providers stay visible before built-ins after reload', () => {
  const providers = [
    provider('builtin-a', { builtin: true }),
    provider('custom-z'),
    provider('custom-a'),
    provider('builtin-z', { builtin: true }),
  ]

  assert.deepEqual(
    providers.sort((a, b) => compareModelProviders(a, b)).map(row => row.id),
    ['custom-a', 'custom-z', 'builtin-a', 'builtin-z'],
  )
})

test('a newly created provider remains first, then enabled services sort before disabled ones', () => {
  const providers = [
    provider('custom-disabled', { enabled: false }),
    provider('builtin-enabled', { builtin: true }),
    provider('custom-new'),
  ]

  assert.deepEqual(
    providers.sort((a, b) => compareModelProviders(a, b, 'custom-new')).map(row => row.id),
    ['custom-new', 'builtin-enabled', 'custom-disabled'],
  )
})

test('providers with the same priority sort by display name', () => {
  const providers = [provider('service-b'), provider('service-a')]

  assert.deepEqual(
    providers.sort((a, b) => compareModelProviders(a, b)).map(row => row.id),
    ['service-a', 'service-b'],
  )
})
