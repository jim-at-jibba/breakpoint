import {
  EMPTY_CONSOLE_HISTORY,
  foldConsoleBatch,
  foldConsoleRead,
  type ConsoleBatch,
  type ConsoleHistory
} from '../../../shared/console-feed'
import type { LogRead, ReadParams } from '../../../shared/event-log'
import type { RouteResponse } from '../../../shared/protocol'

export type ConsoleState =
  | { status: 'fetching'; history: ConsoleHistory }
  | { status: 'live'; history: ConsoleHistory }
  | { status: 'error'; history: ConsoleHistory; message: string }

interface ConsoleReaderOptions {
  read(params: ReadParams): Promise<RouteResponse<LogRead>>
  subscribe(listener: (batch: ConsoleBatch) => void): () => void
  onChange(state: ConsoleState): void
}

export interface ConsoleReader {
  close(): void
}

const RETRY_DELAYS_MS: readonly number[] = [250, 1000, 2000]

/**
 * The window's copy of the log's console entries: read once through `log.read`, then kept
 * current by the console channel's batches. A batch that follows on from a position this
 * reader never reached means one went missing, and the answer is to read the log again —
 * the console's own refetch, which leaves the snapshot alone ([#49]).
 *
 * Batches that arrive while a read is under way are held and folded in after it, so
 * nothing appended during the read is missed and nothing it already returned is doubled.
 * What is drawn meanwhile is the last history there was, never an empty console.
 */
export function createConsoleReader({
  read,
  subscribe,
  onChange
}: ConsoleReaderOptions): ConsoleReader {
  let history: ConsoleHistory = EMPTY_CONSOLE_HISTORY
  let shown: ConsoleHistory = EMPTY_CONSOLE_HISTORY
  /** Batches heard during a read; `null` while none is under way. */
  let held: ConsoleBatch[] | null = null
  let closed = false
  let failures = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  function apply(batch: ConsoleBatch): boolean {
    const folded = foldConsoleBatch(history, batch)
    if (folded.gap) return false
    history = folded.history
    return true
  }

  async function refetch(): Promise<void> {
    if (closed || held) return
    held = []
    history = EMPTY_CONSOLE_HISTORY
    onChange({ status: 'fetching', history: shown })
    try {
      // Once a held batch joins this history, the channel carries the rest. Waiting
      // for an empty read would never finish on a page that logs between every read.
      for (;;) {
        const response = await read({ since: history.cursor })
        if (closed) return
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
        const before = history.cursor
        history = foldConsoleRead(history, response.data)
        if (response.data.entries.length === 0 || history.cursor === before) break
        if (held.length > 0 && held[0].after <= history.cursor) break
      }
    } catch (error) {
      if (closed) return
      held = null
      history = EMPTY_CONSOLE_HISTORY
      onChange({
        status: 'error',
        history: shown,
        message: error instanceof Error ? error.message : String(error)
      })
      const delay = RETRY_DELAYS_MS[failures]
      failures += 1
      if (delay !== undefined) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          void refetch()
        }, delay)
      }
      return
    }
    const waiting = held
    held = null
    failures = 0
    for (const batch of waiting) {
      if (!apply(batch)) {
        void refetch()
        return
      }
    }
    publish()
  }

  function publish(): void {
    shown = history
    onChange({ status: 'live', history })
  }

  const unsubscribe = subscribe((batch) => {
    if (closed) return
    if (held) {
      held.push(batch)
      return
    }
    // Between a failed read and its retry there is nothing to fold into.
    if (retryTimer !== undefined) return
    if (apply(batch)) publish()
    else void refetch()
  })
  void refetch()

  return {
    close: () => {
      closed = true
      clearTimeout(retryTimer)
      unsubscribe()
    }
  }
}
