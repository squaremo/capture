import { describe, it, expect } from 'vitest'
import { createItem, getItem, listItems, updateItem, createFavourite, getFavourite, listFavourites, deleteFavourite } from '../db.js'

describe('createItem', () => {
  it('generates a valid id and returns a pending item', () => {
    const item = createItem('buy milk')
    expect(item.id).toMatch(/^\d+-[a-z0-9]+$/)
    expect(item.text).toBe('buy milk')
    expect(item.status).toBe('pending')
    expect(item.tags).toEqual([])
    expect(item.action_result).toBeNull()
    expect(item.pending_action).toBeNull()
    expect(item.plan_progress).toEqual([])
    expect(item.executed_action).toBeNull()
    expect(item.plan_steps).toEqual([])
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

  it('pending_action round-trips as an object and clears back to null', () => {
    const item = createItem('proposed action')
    const withAction = updateItem(item.id, {
      status: 'awaiting_approval',
      pending_action: { tool: 'create_linear_task', input: { title: 'Fix bug' } },
    })
    expect(withAction.pending_action).toEqual({ tool: 'create_linear_task', input: { title: 'Fix bug' } })

    const cleared = updateItem(item.id, { status: 'acted', pending_action: null })
    expect(cleared.pending_action).toBeNull()
  })

  it('plan_progress round-trips as an array and grows in place', () => {
    const item = createItem('multi-step capture')
    const withOneStep = updateItem(item.id, { plan_progress: [{ label: 'Checking Linear for duplicates' }] })
    expect(withOneStep.plan_progress).toEqual([{ label: 'Checking Linear for duplicates' }])

    const withTwoSteps = updateItem(item.id, {
      plan_progress: [{ label: 'Checking Linear for duplicates' }, { label: 'Second step' }],
    })
    expect(withTwoSteps.plan_progress).toHaveLength(2)
  })

  it('executed_action round-trips as an object and stays set once recorded', () => {
    const item = createItem('proposed action')
    const executed = updateItem(item.id, {
      status: 'acted',
      pending_action: null,
      executed_action: { tool: 'create_linear_task', input: { title: 'Fix bug' } },
    })
    expect(executed.executed_action).toEqual({ tool: 'create_linear_task', input: { title: 'Fix bug' } })
    expect(executed.pending_action).toBeNull()
  })

  it('plan_steps round-trips as an array', () => {
    const item = createItem('play a track')
    const steps = [{ id: 's1', tool: 'resolve_playback', args: { title: 'x', room: 'living room' } }]
    const updated = updateItem(item.id, { plan_steps: steps })
    expect(updated.plan_steps).toEqual(steps)
  })
})

describe('favourites', () => {
  it('createFavourite generates a valid id and round-trips fields', () => {
    const fav = createFavourite({
      label: 'Linear task created: "Fix bug" — https://linear.app/x/1',
      tool: 'create_linear_task',
      input: { title: 'Fix bug', description: 'It is broken' },
      tags: ['work'],
    })
    expect(fav.id).toMatch(/^\d+-[a-z0-9]+$/)
    expect(fav.label).toBe('Linear task created: "Fix bug" — https://linear.app/x/1')
    expect(fav.tool).toBe('create_linear_task')
    expect(fav.input).toEqual({ title: 'Fix bug', description: 'It is broken' })
    expect(fav.tags).toEqual(['work'])
    expect(fav.created_at).toBeTruthy()
  })

  it('createFavourite defaults tags to an empty array', () => {
    const fav = createFavourite({ label: 'Played something', tool: 'control_playback', input: {} })
    expect(fav.tags).toEqual([])
  })

  it('createFavourite defaults plan_steps to an empty array and round-trips house', () => {
    const withoutSteps = createFavourite({ label: 'no program recorded', tool: 'create_linear_task', input: {} })
    expect(withoutSteps.plan_steps).toEqual([])
    expect(withoutSteps.house).toBeNull()

    const steps = [{ id: 's1', tool: 'resolve_playback', args: { title: 'x', room: 'living room' } }]
    const withSteps = createFavourite({ label: 'a program', tool: 'control_playback', input: {}, plan_steps: steps, house: 'home' })
    expect(withSteps.plan_steps).toEqual(steps)
    expect(withSteps.house).toBe('home')
  })

  it('getFavourite returns null for an unknown id', () => {
    expect(getFavourite('nonexistent-id')).toBeNull()
  })

  it('listFavourites includes newly created favourites, newest first', async () => {
    const a = createFavourite({ label: 'first', tool: 'create_linear_task', input: {} })
    await new Promise(r => setTimeout(r, 2))
    const b = createFavourite({ label: 'second', tool: 'create_linear_task', input: {} })
    const ids = listFavourites().map(f => f.id)
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id))
  })

  it('deleteFavourite removes it', () => {
    const fav = createFavourite({ label: 'to remove', tool: 'create_linear_task', input: {} })
    deleteFavourite(fav.id)
    expect(getFavourite(fav.id)).toBeNull()
  })
})
