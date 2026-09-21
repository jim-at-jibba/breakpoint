import { describe, expect, it } from 'vitest'
import { createProject } from './project'
import { startProjection, receiveBatch, receiveSnapshot, type Projection } from './projection'
import { paneStatusesFor, type RevisionedPatch, type StateSnapshot } from './state'

const shop = createProject('/repos/shop')
const store = createProject('/repos/store')

function opened(revision: number, project = shop): RevisionedPatch {
  return { revision, patch: { type: 'project.opened', project } }
}

/**
 * A snapshot at a cursor position. The cursor is deliberately not zero: folding a patch
 * has to carry it through untouched, because the log is a channel of its own.
 */
function snap(revision: number, project: StateSnapshot['project'], cursor = 12): StateSnapshot {
  return { revision, cursor, project, panes: project ? paneStatusesFor(project, {}) : {} }
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

    const { projection, refetch } = receiveSnapshot(held.projection, snap(3, shop))
    expect(refetch).toBe(false)
    expect(projection).toEqual({ status: 'live', snapshot: snap(4, store) })
  })

  it('leaves the cursor where the snapshot put it, patch after patch', () => {
    const { projection } = receiveBatch(live(snap(1, null, 99)), [opened(2), opened(3, store)])
    expect(projection).toEqual({ status: 'live', snapshot: snap(3, store, 99) })
  })

  it('applies a contiguous batch and advances the revision', () => {
    const { projection, refetch } = receiveBatch(live(snap(1, null)), [opened(2), opened(3, store)])
    expect(refetch).toBe(false)
    expect(projection).toEqual({ status: 'live', snapshot: snap(3, store) })
  })

  it('ignores a patch it has already seen', () => {
    const { projection, refetch } = receiveBatch(live(snap(5, shop)), [opened(5, store)])
    expect(refetch).toBe(false)
    expect(projection).toEqual({ status: 'live', snapshot: snap(5, shop) })
  })

  it('re-fetches the snapshot wholesale on a gap rather than applying what it can', () => {
    const { projection, refetch } = receiveBatch(live(snap(5, shop)), [opened(7, store)])
    expect(refetch).toBe(true)
    expect(projection.status).toBe('fetching')
    // Nothing from the gapped batch survives: the snapshot is the truth now.
    const after = receiveSnapshot(projection, snap(7, shop))
    expect(after.projection).toEqual({ status: 'live', snapshot: snap(7, shop) })
  })

  it('re-fetches again if the patches held during a fetch have a gap after the snapshot', () => {
    const held = receiveBatch(startProjection(), [opened(9, store)])
    const { projection, refetch } = receiveSnapshot(held.projection, snap(7, shop))
    expect(refetch).toBe(true)
    expect(projection.status).toBe('fetching')
  })

  it('adopts a snapshot that arrives while live only if it is not older than what it has', () => {
    const current = live(snap(5, shop))
    expect(receiveSnapshot(current, snap(4, store)).projection).toEqual(current)
    expect(receiveSnapshot(current, snap(6, store)).projection).toEqual({
      status: 'live',
      snapshot: snap(6, store)
    })
  })
})
