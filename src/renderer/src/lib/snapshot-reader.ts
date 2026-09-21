import type { RouteResponse } from '../../../shared/protocol'
import {
  receiveBatch,
  receiveSnapshot,
  startProjection,
  type Projection,
  type ProjectionStep
} from '../../../shared/projection'
import type { PatchBatch, StateSnapshot } from '../../../shared/state'

export type SnapshotState =
  | { status: 'fetching'; snapshot: StateSnapshot | null }
  | { status: 'live'; snapshot: StateSnapshot }
  | { status: 'error'; snapshot: StateSnapshot | null; message: string }

interface SnapshotReaderOptions {
  fetchSnapshot(): Promise<RouteResponse<StateSnapshot>>
  subscribe(listener: (batch: PatchBatch) => void): () => void
  onChange(state: SnapshotState): void
}

export interface SnapshotReader {
  retry(): void
  close(): void
}

const RETRY_DELAYS_MS: readonly number[] = [250, 1000, 2000]

export function createSnapshotReader({
  fetchSnapshot,
  subscribe,
  onChange
}: SnapshotReaderOptions): SnapshotReader {
  let projection: Projection = startProjection()
  let lastSnapshot: StateSnapshot | null = null
  let closed = false
  let inFlight = false
  let acceptingPatches = true
  let failures = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  function step(result: ProjectionStep): void {
    projection = result.projection
    if (projection.status === 'live') {
      failures = 0
      lastSnapshot = projection.snapshot
      onChange(projection)
    }
    if (result.refetch) void requestSnapshot()
  }

  function failed(message: string): void {
    projection = startProjection()
    acceptingPatches = false
    onChange({ status: 'error', snapshot: lastSnapshot, message })
    const delay = RETRY_DELAYS_MS[failures]
    failures += 1
    if (delay !== undefined) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        void requestSnapshot()
      }, delay)
    }
  }

  async function requestSnapshot(): Promise<void> {
    if (closed || inFlight) return
    inFlight = true
    acceptingPatches = true
    onChange({ status: 'fetching', snapshot: lastSnapshot })
    let response: RouteResponse<StateSnapshot>
    try {
      response = await fetchSnapshot()
    } catch (error) {
      if (closed) return
      inFlight = false
      failed(error instanceof Error ? error.message : String(error))
      return
    }
    if (closed) return
    inFlight = false
    if (response.ok) {
      step(receiveSnapshot(projection, response.data))
    } else {
      failed(`${response.error.code}: ${response.error.message}`)
    }
  }

  const unsubscribe = subscribe((batch: PatchBatch): void => {
    if (closed || !acceptingPatches) return
    step(receiveBatch(projection, batch))
  })
  void requestSnapshot()

  return {
    retry: (): void => {
      if (closed || inFlight) return
      clearTimeout(retryTimer)
      retryTimer = undefined
      failures = 0
      projection = startProjection()
      void requestSnapshot()
    },
    close: (): void => {
      closed = true
      clearTimeout(retryTimer)
      unsubscribe()
    }
  }
}
