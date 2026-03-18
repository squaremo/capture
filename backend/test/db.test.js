import { describe, it, expect } from 'vitest'
import { createItem, getItem, listItems, updateItem } from '../db.js'

describe('createItem', () => {
  it('generates a valid id and returns a pending item', () => {
    const item = createItem('buy milk')
    expect(item.id).toMatch(/^\d+-[a-z0-9]+$/)
    expect(item.text).toBe('buy milk')
    expect(item.status).toBe('pending')
    expect(item.tags).toEqual([])
    expect(item.action_result).toBeNull()
    expect(item.created_at).toBeTruthy()
  })
})

describe('getItem', () => {
  it('returns null for an unknown id', () => {
    expect(getItem('nonexistent-id')).toBeNull()
  })

  it('returns the item for a known id', () => {
    const created = createItem('test item')
    expect(getItem(created.id)).toEqual(created)
  })
})

describe('listItems', () => {
  it('includes newly created items when no filter applied', () => {
    const a = createItem('list item a')
    const b = createItem('list item b')
    const ids = listItems().map(i => i.id)
    expect(ids).toContain(a.id)
    expect(ids).toContain(b.id)
  })

  it('filters by status', () => {
    const pending = createItem('pending item')
    const toTriage = createItem('triaged item')
    updateItem(toTriage.id, { status: 'triaged' })

    const pendingItems = listItems({ status: 'pending' })
    expect(pendingItems.some(i => i.id === pending.id)).toBe(true)
    expect(pendingItems.some(i => i.id === toTriage.id)).toBe(false)

    const triagedItems = listItems({ status: 'triaged' })
    expect(triagedItems.some(i => i.id === toTriage.id)).toBe(true)
  })

  it('orders newest first', async () => {
    const a = createItem('order first')
    await new Promise(r => setTimeout(r, 2))
    const b = createItem('order second')
    const items = listItems()
    const aIdx = items.findIndex(i => i.id === a.id)
    const bIdx = items.findIndex(i => i.id === b.id)
    expect(bIdx).toBeLessThan(aIdx)
  })
})

describe('updateItem', () => {
  it('only changes the provided fields', () => {
    const item = createItem('original text')
    const updated = updateItem(item.id, { status: 'triaged' })
    expect(updated.status).toBe('triaged')
    expect(updated.text).toBe('original text')
    expect(updated.tags).toEqual([])
  })

  it('tags round-trip as an array', () => {
    const item = createItem('tagged item')
    const updated = updateItem(item.id, { tags: ['work', 'health'] })
    expect(updated.tags).toEqual(['work', 'health'])
  })

  it('returns unchanged item when no fields provided', () => {
    const item = createItem('no-op update')
    const result = updateItem(item.id, {})
    expect(result).toEqual(item)
  })
})
