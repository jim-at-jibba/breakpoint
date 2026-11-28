import { describe, expect, it, vi } from 'vitest'
import type { ConsoleBatch } from '../../shared/console-feed'
import { EventLog, MAX_ENTRY_TEXT_BYTES, type ConsoleEntryBody } from '../../shared/event-log'
import { createConsoleAdapter } from './console'

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

function harness(limit?: number): {
  log: EventLog
  sent: ConsoleBatch[]
  frame(): void
  scheduled(): number
  close(): void
} {
  const log = new EventLog({ limit, now: () => 0 })
  const sent: ConsoleBatch[] = []
  const frames: Array<() => void> = []
  const adapter = createConsoleAdapter(log, {
    send: (batch) => sent.push(batch),
    schedule: (flush) => frames.push(flush)
  })
  return {
    log,
    sent,
    frame: () => frames.splice(0).forEach((flush) => flush()),
    scheduled: () => frames.length,
    close: adapter.close
  }
}

describe('the console adapter', () => {
  it('ships every console entry appended within one frame as one batch, in order', () => {
    const { log, sent, frame, scheduled } = harness()

    log.append('mobile', said('one'))
    log.append('tablet', said('two'))
    expect(sent).toEqual([])
    expect(scheduled()).toBe(1)

    frame()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ after: 0, cursor: 2, evicted: [] })
    expect(sent[0].entries.map((entry) => [entry.cursor, entry.pane, entry.text])).toEqual([
      [1, 'mobile', 'one'],
      [2, 'tablet', 'two']
    ])
  })

  it('carries only console entries, but numbers the batch by every append', () => {
    const { log, sent, frame } = harness()

    log.append('mobile', { type: 'pane.loaded', url: 'http://x/' })
    log.append('mobile', said('after load'))
    frame()

    expect(sent[0]).toMatchObject({ after: 0, cursor: 2 })
    expect(sent[0].entries.map((entry) => entry.cursor)).toEqual([2])
  })

  it('sends nothing for a frame with nothing for the console, and the next batch says so', () => {
    const { log, sent, frame } = harness()

    log.append('mobile', said('one'))
    frame()
    log.append('mobile', { type: 'pane.loaded', url: 'http://x/' })
    frame()
    log.append('mobile', said('two'))
    frame()

    expect(sent.map(({ after, cursor }) => [after, cursor])).toEqual([
      [0, 1],
      [1, 3]
    ])
  })

  it('tells the window what each pane’s ring evicted', () => {
    const { log, sent, frame } = harness(2)

    log.append('mobile', said('one'))
    log.append('mobile', said('two'))
    log.append('tablet', said('other'))
    frame()
    log.append('mobile', said('three'))
    log.append('mobile', said('four'))
    frame()

    expect(sent[1].evicted).toEqual([{ pane: 'mobile', through: 2 }])
  })

  it('carries an entry as a read would, within the read’s per-field budget', () => {
    const { log, sent, frame } = harness()

    log.append('mobile', said('x'.repeat(MAX_ENTRY_TEXT_BYTES * 2)))
    frame()

    expect(sent[0].entries[0].truncated).toContain('text')
  })

  it('sends nothing once closed', () => {
    const { log, sent, frame, close } = harness()

    log.append('mobile', said('one'))
    close()
    frame()
    log.append('mobile', said('two'))
    frame()

    expect(sent).toEqual([])
  })
})
