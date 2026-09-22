import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { failure, success, type RouteResponse } from '../../../shared/protocol'
import { createProject } from '../../../shared/project'
import { paneStatusesFor, type PatchBatch, type StateSnapshot } from '../../../shared/state'
import { createSnapshotReader, type SnapshotReader, type SnapshotState } from './snapshot-reader'

const shop = createProject('/repos/shop')
const snapshot: StateSnapshot = {
  revision: 1,
  cursor: 0,
  project: shop,
  panes: paneStatusesFor(shop, {}),
  certificates: { trusted: [], waiting: [] }
}

interface SnapshotHarness {
  fetchSnapshot: Mock<() => Promise<RouteResponse<StateSnapshot>>>
  onChange: Mock<(state: SnapshotState) => void>
  unsubscribe: Mock<() => void>
  start(): SnapshotReader
  push(batch: PatchBatch): void
}

function harness(): SnapshotHarness {
  const listeners = new Set<(batch: PatchBatch) => void>()
  const fetchSnapshot = vi.fn<() => Promise<RouteResponse<StateSnapshot>>>()
  const onChange = vi.fn<(state: SnapshotState) => void>()
  const unsubscribe = vi.fn<() => void>()
  const start = (): ReturnType<typeof createSnapshotReader> =>
    createSnapshotReader({
      fetchSnapshot,
      onChange,
      subscribe: (listener: (batch: PatchBatch) => void): (() => void) => {
        listeners.add(listener)
        return (): void => {
          unsubscribe()
          listeners.delete(listener)
        }
      }
    })
  const push = (batch: PatchBatch): void => {
    for (const listener of listeners) listener(batch)
  }
  return { fetchSnapshot, onChange, unsubscribe, start, push }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('snapshot recovery', () => {
  it.each(['envelope', 'rejection'] as const)(
    'retries a failed %s and applies patches received during the successful fetch',
    async (kind) => {
      const h = harness()
      if (kind === 'envelope') {
        h.fetchSnapshot.mockResolvedValueOnce(failure('test', 'INTERNAL_ERROR', 'unavailable'))
      } else {
        h.fetchSnapshot.mockRejectedValueOnce(new Error('unavailable'))
      }
      h.fetchSnapshot.mockImplementationOnce(async () => {
        h.push([
          { revision: 2, patch: { type: 'project.opened', project: { ...shop, name: 'updated' } } }
        ])
        return success('test', snapshot)
      })
      const reader = h.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.onChange).toHaveBeenLastCalledWith({
        status: 'error',
        snapshot: null,
        message: expect.stringContaining('unavailable')
      })

      // A stale patch during backoff must not poison the next snapshot's revision stream.
      h.push([{ revision: 100, patch: { type: 'project.opened', project: shop } }])
      await vi.advanceTimersByTimeAsync(250)
      expect(h.fetchSnapshot).toHaveBeenCalledTimes(2)
      expect(h.onChange).toHaveBeenLastCalledWith({
        status: 'live',
        snapshot: {
          revision: 2,
          cursor: 0,
          project: { ...shop, name: 'updated' },
          panes: paneStatusesFor(shop, {}),
          certificates: snapshot.certificates
        }
      })
      reader.close()
    }
  )

  it('stops automatic retries, ignores patches while failed, and allows a manual retry', async () => {
    const h = harness()
    h.fetchSnapshot.mockResolvedValue(failure('test', 'INTERNAL_ERROR', 'unavailable'))
    const reader = h.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(4)
    const calls = h.onChange.mock.calls.length
    h.push([{ revision: 100, patch: { type: 'project.opened', project: shop } }])
    expect(h.onChange).toHaveBeenCalledTimes(calls)
    expect(vi.getTimerCount()).toBe(0)

    h.fetchSnapshot.mockResolvedValueOnce(success('test', snapshot))
    reader.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(5)
    expect(h.onChange).toHaveBeenLastCalledWith({ status: 'live', snapshot })
    reader.close()
  })

  it('cancels scheduled retries and unsubscribes on close', async () => {
    const h = harness()
    h.fetchSnapshot.mockRejectedValue(new Error('disconnected'))
    const reader = h.start()
    await vi.advanceTimersByTimeAsync(0)
    reader.close()
    h.onChange.mockClear()
    reader.retry()
    h.push([{ revision: 2, patch: { type: 'project.opened', project: shop } }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.unsubscribe).toHaveBeenCalledOnce()
    expect(h.fetchSnapshot).toHaveBeenCalledOnce()
    expect(h.onChange).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores an in-flight rejection after close without scheduling a retry', async () => {
    const h = harness()
    let rejectFetch: (error: Error) => void = (): void => {
      throw new Error('fetch has not started')
    }
    h.fetchSnapshot.mockReturnValue(
      new Promise<RouteResponse<StateSnapshot>>((_resolve, reject) => {
        rejectFetch = reject
      })
    )
    const reader = h.start()
    reader.close()
    h.onChange.mockClear()
    rejectFetch(new Error('disconnected'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.onChange).not.toHaveBeenCalled()
    expect(h.fetchSnapshot).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recovers when a gap triggers a refetch that fails once', async () => {
    const h = harness()
    h.fetchSnapshot.mockResolvedValueOnce(success('test', snapshot))
    const reader = h.start()
    await vi.advanceTimersByTimeAsync(0)
    h.fetchSnapshot.mockRejectedValueOnce(new Error('disconnected'))
    h.fetchSnapshot.mockResolvedValueOnce(success('test', { ...snapshot, revision: 3 }))
    h.push([{ revision: 3, patch: { type: 'project.opened', project: shop } }])
    expect(h.onChange).toHaveBeenLastCalledWith({ status: 'fetching', snapshot })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.onChange).toHaveBeenLastCalledWith({
      status: 'error',
      snapshot,
      message: 'disconnected'
    })
    await vi.advanceTimersByTimeAsync(250)
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(3)
    expect(h.onChange).toHaveBeenLastCalledWith({
      status: 'live',
      snapshot: { ...snapshot, revision: 3 }
    })
    reader.close()
  })

  it('keeps the last committed snapshot through failed manual retries until a new project arrives', async () => {
    const h = harness()
    h.fetchSnapshot.mockResolvedValueOnce(success('test', snapshot))
    const reader = h.start()
    await vi.advanceTimersByTimeAsync(0)
    const updated: StateSnapshot = { ...snapshot, revision: 2 }
    h.push([{ revision: 2, patch: { type: 'project.opened', project: shop } }])

    h.fetchSnapshot.mockResolvedValue(failure('test', 'INTERNAL_ERROR', 'unavailable'))
    reader.retry()
    expect(h.onChange).toHaveBeenLastCalledWith({ status: 'fetching', snapshot: updated })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.onChange).toHaveBeenLastCalledWith({
      status: 'error',
      snapshot: updated,
      message: 'INTERNAL_ERROR: unavailable'
    })

    const store = createProject('/repos/store')
    const switched: StateSnapshot = {
      revision: 3,
      cursor: 0,
      project: store,
      panes: paneStatusesFor(store, {}),
      certificates: { trusted: [], waiting: [] }
    }
    h.fetchSnapshot.mockResolvedValueOnce(success('test', switched))
    reader.retry()
    expect(h.onChange).toHaveBeenLastCalledWith({ status: 'fetching', snapshot: updated })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.onChange).toHaveBeenLastCalledWith({ status: 'live', snapshot: switched })
    reader.close()
  })
})
