import { describe, expect, it, vi, type Mock } from 'vitest'
import { createConsoleAdapter } from '../../../main/adapters/console'
import type { ConsoleBatch } from '../../../shared/console-feed'
import {
  ENTRIES_PER_READ,
  EventLog,
  type ConsoleEntryBody,
  type LogRead,
  type ReadParams
} from '../../../shared/event-log'
import { failure, success, type RouteResponse } from '../../../shared/protocol'
import { createConsoleReader, type ConsoleReader, type ConsoleState } from './console-reader'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

function said(text: string): ConsoleEntryBody {
  return {
    type: 'console.message',
    level: 'log',
    source: 'console',
    text,
    args: [text],
    url: null,
    location: null,
    stack: []
  }
}

/**
 * The real log and the real adapter, with the channel between them in the test's hands:
 * a frame delivers what the adapter sent, and `drop` loses the next batch on the way.
 */
interface ReaderHarness {
  log: EventLog
  read: Mock<(params: ReadParams) => Promise<RouteResponse<LogRead>>>
  start(): ConsoleReader
  states: ConsoleState[]
  latest(): ConsoleState
  texts(): string[]
  frame(): void
  drop(): void
  settle(): Promise<void>
}

function harness(limit?: number): ReaderHarness {
  const log = new EventLog({ limit, now: () => 0 })
  const frames: Array<() => void> = []
  const listeners = new Set<(batch: ConsoleBatch) => void>()
  let dropping = 0
  createConsoleAdapter(log, {
    send: (batch) => {
      if (dropping > 0) {
        dropping -= 1
        return
      }
      for (const listener of listeners) listener(batch)
    },
    schedule: (flush) => frames.push(flush)
  })
  const read = vi.fn((params: ReadParams): Promise<RouteResponse<LogRead>> =>
    Promise.resolve(success('read', log.read(params)))
  )
  const states: ConsoleState[] = []
  const start = (): ConsoleReader =>
    createConsoleReader({
      read,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      onChange: (state) => states.push(state)
    })
  const latest = (): ConsoleState => states.at(-1)!
  return {
    log,
    read,
    start,
    states,
    latest,
    texts: () => latest().history.entries.map((entry) => entry.text),
    frame: () => frames.splice(0).forEach((flush) => flush()),
    drop: () => {
      dropping += 1
    },
    settle: () =>
      vi.waitFor(() => {
        expect(latest().status).not.toBe('fetching')
      })
  }
}

describe('the console reader', () => {
  it('reads what the log already holds, then follows the channel', async () => {
    const { log, start, frame, settle, texts, latest } = harness()
    log.append('mobile', said('before'))
    start()
    frame()
    await settle()
    expect(texts()).toEqual(['before'])

    log.append('mobile', said('after'))
    frame()

    expect(latest().status).toBe('live')
    expect(texts()).toEqual(['before', 'after'])
  })

  it('pages through a log longer than one read', async () => {
    const { log, start, settle, latest } = harness()
    for (let n = 0; n < ENTRIES_PER_READ * 2 + 5; n += 1) log.append('mobile', said(`${n}`))
    start()

    await settle()

    expect(latest().history.entries).toHaveLength(ENTRIES_PER_READ * 2 + 5)
  })

  it('refetches when a batch is dropped, and the window ends up with everything', async () => {
    const { log, read, start, frame, drop, settle, texts } = harness()
    start()
    await settle()
    expect(read).toHaveBeenCalledTimes(1)

    drop()
    log.append('mobile', said('lost'))
    frame()
    log.append('mobile', said('next'))
    frame()
    await settle()

    expect(read.mock.calls.length).toBeGreaterThan(1)
    expect(read.mock.calls[1][0]).toEqual({ since: 0 })
    expect(texts()).toEqual(['lost', 'next'])
  })

  it('holds batches that arrive during a read, and folds them in after it once each', async () => {
    const { log, start, frame, settle, texts } = harness()
    log.append('mobile', said('one'))
    start()
    // The read is under way, and this batch overlaps what it returns.
    log.append('mobile', said('two'))
    frame()
    await settle()

    expect(texts()).toEqual(['one', 'two'])
  })

  it('mirrors what the log evicts', async () => {
    const { log, start, frame, settle, texts } = harness(2)
    start()
    await settle()

    log.append('mobile', said('one'))
    log.append('mobile', said('two'))
    log.append('mobile', said('three'))
    frame()

    expect(texts()).toEqual(['two', 'three'])
    expect(log.read({ pane: 'mobile' }).entries.map((entry) => entry.cursor)).toEqual([2, 3])
  })

  it('joins the channel without waiting for a busy log to return an empty read', async () => {
    const { log, read, start, frame, settle, latest, texts } = harness()
    log.append('mobile', said('before'))
    frame()
    read.mockImplementation(async (params) => {
      if (read.mock.calls.length > 3) return failure('read', 'INTERNAL_ERROR', 'never joined')
      const response = success('read', log.read(params))
      log.append('mobile', said('during'))
      frame()
      return response
    })
    const reader = start()
    await settle()

    expect(latest().status).toBe('live')
    expect(read).toHaveBeenCalledTimes(1)
    expect(texts()).toEqual(['before', 'during'])
    reader.close()
  })

  it('says so when the log cannot be read, and keeps what it last showed', async () => {
    vi.useFakeTimers()
    try {
      const { read, start, latest } = harness()
      read.mockResolvedValueOnce(failure('read', 'INTERNAL_ERROR', 'nope'))
      start()
      await vi.advanceTimersByTimeAsync(0)

      expect(latest()).toMatchObject({ status: 'error', message: 'INTERNAL_ERROR: nope' })

      await vi.advanceTimersByTimeAsync(250)
      expect(latest().status).toBe('live')
    } finally {
      vi.useRealTimers()
    }
  })
})
