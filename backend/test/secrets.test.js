import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockResolve } = vi.hoisted(() => ({ mockResolve: vi.fn() }))

vi.mock('@1password/sdk', () => ({
  createClient: vi.fn(async () => ({ secrets: { resolve: mockResolve } })),
}))

import { resolveEnv } from '../secrets.js'

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  mockResolve.mockClear()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('resolveEnv', () => {
  it('passes through a plain value unchanged', async () => {
    process.env.FOO = 'plain-value'
    await expect(resolveEnv('FOO')).resolves.toBe('plain-value')
  })

  it('passes through undefined unchanged', async () => {
    delete process.env.FOO
    await expect(resolveEnv('FOO')).resolves.toBeUndefined()
  })

  it('throws for an op:// reference when OP_SERVICE_ACCOUNT_TOKEN is not set', async () => {
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN
    process.env.FOO = 'op://vault/item/field'
    await expect(resolveEnv('FOO')).rejects.toThrow('OP_SERVICE_ACCOUNT_TOKEN')
  })

  it('resolves an op:// reference via 1Password when configured', async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = 'test-token'
    process.env.FOO = 'op://vault/item/field'
    mockResolve.mockResolvedValue('the-real-secret')
    await expect(resolveEnv('FOO')).resolves.toBe('the-real-secret')
    expect(mockResolve).toHaveBeenCalledWith('op://vault/item/field')
  })
})
