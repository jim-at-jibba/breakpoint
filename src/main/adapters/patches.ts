import { BrowserWindow } from 'electron'
import { PATCH_CHANNEL } from '../../shared/ipc'
import type { PatchBatch, RevisionedPatch } from '../../shared/state'
import type { StateFeed } from '../state-feed'

/**
 * The renderer's push adapter. Patches published within one frame go out as one
 * batch, so a burst of changes costs one message and one render rather than one each.
 * Like the other adapters it holds no behaviour: it collects, and it sends.
 */

const FRAME_MS = 16

export interface PatchAdapterOptions {
  send(batch: PatchBatch): void
  /** Runs `flush` at the next frame. Injected so the cadence is testable without a clock. */
  schedule(flush: () => void): void
}

export interface PatchAdapter {
  close(): void
}

export function createPatchAdapter(
  feed: StateFeed,
  { send, schedule }: PatchAdapterOptions = defaultOptions()
): PatchAdapter {
  let pending: RevisionedPatch[] = []
  let scheduled = false
  let closed = false

  const flush = (): void => {
    scheduled = false
    if (closed || pending.length === 0) return
    const batch = pending
    pending = []
    send(batch)
  }

  const unsubscribe = feed.subscribe((patch) => {
    if (closed) return
    pending.push(patch)
    if (scheduled) return
    scheduled = true
    schedule(flush)
  })

  return {
    close: () => {
      closed = true
      pending = []
      unsubscribe()
    }
  }
}

function defaultOptions(): PatchAdapterOptions {
  return {
    send: (batch) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(PATCH_CHANNEL, batch)
      }
    },
    schedule: (flush) => setTimeout(flush, FRAME_MS)
  }
}
