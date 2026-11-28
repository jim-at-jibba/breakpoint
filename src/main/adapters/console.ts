import { BrowserWindow } from 'electron'
import { isConsoleEntry, type ConsoleBatch, type ConsoleEntry } from '../../shared/console-feed'
import { entryForRead, type EventLog } from '../../shared/event-log'
import { CONSOLE_CHANNEL } from '../../shared/ipc'

/**
 * The console's push adapter. Console entries appended within one frame go out as one
 * batch on their own channel, never through the state feed, so a page logging thousands
 * of entries a second moves no snapshot revision ([#49]). Like the other adapters it holds
 * no behaviour: it collects, and it sends.
 *
 * A frame that appended nothing the console draws sends nothing, and the next batch says
 * it follows on from the last one sent rather than from the last append, so a reader can
 * still tell a quiet frame from a lost batch.
 */

const FRAME_MS = 16

export interface ConsoleAdapterOptions {
  send(batch: ConsoleBatch): void
  /** Runs `flush` at the next frame. Injected so the cadence is testable without a clock. */
  schedule(flush: () => void): void
}

export interface ConsoleAdapter {
  close(): void
}

export function createConsoleAdapter(
  log: EventLog,
  { send, schedule }: ConsoleAdapterOptions = defaultOptions()
): ConsoleAdapter {
  let sent = log.cursor
  let cursor = log.cursor
  let entries: ConsoleEntry[] = []
  let evicted = new Map<string | null, number>()
  let scheduled = false
  let closed = false

  const flush = (): void => {
    scheduled = false
    if (closed || (entries.length === 0 && evicted.size === 0)) return
    const batch: ConsoleBatch = {
      after: sent,
      cursor,
      entries,
      evicted: [...evicted].map(([pane, through]) => ({ pane, through }))
    }
    sent = cursor
    entries = []
    evicted = new Map()
    send(batch)
  }

  const unsubscribe = log.subscribe(({ entry, evicted: gone }) => {
    if (closed) return
    cursor = entry.cursor
    // As a read would carry it, so the window never holds more of an entry than a reader can.
    if (isConsoleEntry(entry)) entries.push(entryForRead(entry) as ConsoleEntry)
    if (gone && isConsoleEntry(gone)) {
      evicted.set(gone.pane, Math.max(evicted.get(gone.pane) ?? 0, gone.cursor))
    }
    if (scheduled) return
    scheduled = true
    schedule(flush)
  })

  return {
    close: () => {
      closed = true
      entries = []
      evicted = new Map()
      unsubscribe()
    }
  }
}

function defaultOptions(): ConsoleAdapterOptions {
  return {
    send: (batch) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(CONSOLE_CHANNEL, batch)
      }
    },
    schedule: (flush) => setTimeout(flush, FRAME_MS)
  }
}
