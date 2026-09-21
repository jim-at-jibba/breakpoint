import { describe, expect, it } from 'vitest'
import { createProject } from './project'
import { startProjection, receiveBatch, receiveSnapshot, type Projection } from './projection'
import type { RevisionedPatch, StateSnapshot } from './state'

const shop = createProject('/repos/shop')
const store = createProject('/repos/store')

function opened(revision: number, project = shop): RevisionedPatch {
  return { revision, patch: { type: 'project.opened', project } }
}

function live(snapshot: StateSnapshot): Projection {
  const { projection } = receiveSnapshot(startProjection(), snapshot)
  return projection
}

describe('the renderer projection', () => {
  it('starts by fetching, holds patches that arrive meanwhile, and applies the ones the snapshot missed', () => {
    const fetching = startProjection()
    expect(fetching.status).toBe('fetching')

    const held = receiveBatch(fetching, [opened(3), opened(4, store)])
    expect(held.refetch).toBe(false)
    expect(held.projection.status).toBe('fetching')

    const { projection, refetch } = receiveSnapshot(held.projection, { revision: 3, project: shop })
    expect(refetch).toBe(false)
    expect(projection).toEqual({ status: 'live', snapshot: { revision: 4, project: store } })
  })

  it('applies a contiguous batch and advances the revision', () => {
    const { projection, refetch } = receiveBatch(live({ revision: 1, project: null }), [
      opened(2),
      opened(3, store)
    ])
    expect(refetch).toBe(false)
    expect(projection).toEqual({ status: 'live', snapshot: { revision: 3, project: store } })
  })

  it('ignores a patch it has already seen', () => {
    const { projection, refetch } = receiveBatch(live({ revision: 5, project: shop }), [
      opened(5, store)
    ])
    expect(refetch).toBe(false)
    expect(projection).toEqual({ status: 'live', snapshot: { revision: 5, project: shop } })
  })

  it('re-fetches the snapshot wholesale on a gap rather than applying what it can', () => {
    const { projection, refetch } = receiveBatch(live({ revision: 5, project: shop }), [
      opened(7, store)
    ])
    expect(refetch).toBe(true)
    expect(projection.status).toBe('fetching')
    // Nothing from the gapped batch survives: the snapshot is the truth now.
    const after = receiveSnapshot(projection, { revision: 7, project: shop })
    expect(after.projection).toEqual({ status: 'live', snapshot: { revision: 7, project: shop } })
  })

  it('re-fetches again if the patches held during a fetch have a gap after the snapshot', () => {
    const held = receiveBatch(startProjection(), [opened(9, store)])
    const { projection, refetch } = receiveSnapshot(held.projection, { revision: 7, project: shop })
    expect(refetch).toBe(true)
    expect(projection.status).toBe('fetching')
  })

  it('adopts a snapshot that arrives while live only if it is not older than what it has', () => {
    const current = live({ revision: 5, project: shop })
    expect(receiveSnapshot(current, { revision: 4, project: store }).projection).toEqual(current)
    expect(receiveSnapshot(current, { revision: 6, project: store }).projection).toEqual({
      status: 'live',
      snapshot: { revision: 6, project: store }
    })
  })
})
