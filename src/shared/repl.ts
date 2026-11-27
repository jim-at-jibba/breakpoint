import type { Evaluation } from './console'
import type { ConsoleLevel } from './event-log'
import type { ConsoleFilter, PlacedLine } from './console-rows'

/**
 * The Console's REPL ([#79]): an expression evaluated in one pane or in all of them, its
 * answers drawn as rows among the console's own, and the expressions typed so far kept as
 * history to step through. Pure, so the stepping and the placing are tested without a
 * window.
 *
 * What is evaluated and what it answered is this window's alone. It goes through
 * `panes.evaluate`, like any surface would, and is never written to the log: a reader of
 * the log hears what the page logged while it ran, and nothing about who asked.
 */

// ---------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------

/** Expressions kept to step back through, at most. The oldest goes first. */
export const MAX_REPL_HISTORY = 100

/**
 * The expressions typed, oldest first, and where the reader is among them: `null` is the
 * line being typed, which `draft` holds while the reader is stepping through older ones.
 */
export interface ReplHistory {
  readonly entries: readonly string[]
  readonly at: number | null
  readonly draft: string
}

export const EMPTY_REPL_HISTORY: ReplHistory = Object.freeze({ entries: [], at: null, draft: '' })

/**
 * An expression just evaluated, at the end of history, and the reader back at a fresh
 * line. The same expression twice running is kept once, as a shell keeps it.
 */
export function remember(history: ReplHistory, expression: string): ReplHistory {
  const trimmed = expression.trim()
  if (trimmed === '') return { ...history, at: null, draft: '' }
  const entries =
    history.entries.at(-1) === expression ? history.entries : [...history.entries, expression]
  return { entries: entries.slice(-MAX_REPL_HISTORY), at: null, draft: '' }
}

/**
 * One step through history, Up being `back`: the history after it and what the input
 * should now say, or `null` when there is nowhere further to go, so the key does nothing.
 * Stepping off the newest end gives back what was being typed before stepping started.
 */
export function stepHistory(
  history: ReplHistory,
  direction: 'back' | 'forward',
  current: string
): { history: ReplHistory; text: string } | null {
  const { entries, at } = history
  if (direction === 'back') {
    if (entries.length === 0 || at === 0) return null
    const next = at === null ? entries.length - 1 : at - 1
    const draft = at === null ? current : history.draft
    return { history: { entries, at: next, draft }, text: entries[next] }
  }
  if (at === null) return null
  if (at === entries.length - 1) {
    return { history: { entries, at: null, draft: '' }, text: history.draft }
  }
  return { history: { ...history, at: at + 1 }, text: entries[at + 1] }
}

// ---------------------------------------------------------------------------------------
// Exchanges
// ---------------------------------------------------------------------------------------

/**
 * One expression sent, and its answers once they come. `cursor` is the console's position
 * when it was sent, which only places it among the console's rows: after everything the
 * window had heard by then, before whatever the page said while it ran.
 */
export interface ReplExchange {
  readonly id: number
  readonly cursor: number
  readonly time: number
  readonly expression: string
  /** The pane it was sent to, or `null` for every pane. */
  readonly pane: string | null
  /** One per pane asked, in the project's order, or `null` while waiting. */
  readonly results: readonly Evaluation[] | null
  readonly answered: number | null
}

/** Exchanges the window keeps, at most. The oldest goes first. */
export const MAX_REPL_EXCHANGES = 200

export function sendExchange(
  exchanges: readonly ReplExchange[],
  exchange: Omit<ReplExchange, 'results' | 'answered'>
): ReplExchange[] {
  return [...exchanges, { ...exchange, results: null, answered: null }].slice(-MAX_REPL_EXCHANGES)
}

/** The answers to one exchange, wherever it is now; one already evicted is left gone. */
export function answerExchange(
  exchanges: readonly ReplExchange[],
  id: number,
  results: readonly Evaluation[],
  time: number
): ReplExchange[] {
  return exchanges.map((exchange) =>
    exchange.id === id ? { ...exchange, results, answered: time } : exchange
  )
}

/**
 * The route itself refused — a pane gone since it was picked, say — so the exchange has
 * one answer saying why, against the pane it was sent to.
 */
export function refuseExchange(
  exchanges: readonly ReplExchange[],
  id: number,
  message: string,
  time: number
): ReplExchange[] {
  return exchanges.map((exchange) =>
    exchange.id === id
      ? {
          ...exchange,
          results: [{ pane: exchange.pane ?? '', outcome: 'failed', text: message }],
          answered: time
        }
      : exchange
  )
}

/** The level a result is drawn at: anything that did not give back a value is an error. */
export function evaluationLevel(evaluation: Evaluation): ConsoleLevel {
  return evaluation.outcome === 'value' ? 'log' : 'error'
}

/**
 * One line the REPL adds to the list: the expression as sent, or one pane's answer to it.
 * Each takes the exchange's cursor, so an exchange's lines stay together and in place.
 */
export type ReplLine =
  | {
      readonly kind: 'input'
      readonly key: string
      readonly cursor: number
      readonly exchange: ReplExchange
    }
  | {
      readonly kind: 'result'
      readonly key: string
      readonly cursor: number
      readonly exchange: ReplExchange
      readonly evaluation: Evaluation
    }

/**
 * Clear, and navigating with preserve-log off, raise the display floor ([ADR-0022]), and
 * the REPL's exchanges go with it. An exchange holds no log position of its own — nothing
 * it did was written to the log — so it cannot be compared with the floor; what can be
 * seen is the floor rising, and everything sent before then is cleared. `seen` is the
 * floor as last followed, `null` before the first, which only records it.
 */
export function followFloor(
  exchanges: readonly ReplExchange[],
  seen: number | null,
  floor: number
): { exchanges: readonly ReplExchange[]; seen: number } {
  if (seen !== null && floor > seen) return { exchanges: [], seen: floor }
  return { exchanges, seen: seen === null ? floor : Math.max(seen, floor) }
}

/**
 * The lines of the exchanges in view. The console's filter applies to the answers as it
 * does to entries — by pane, by level, by text in the answer or in the expression — and an
 * expression is shown while it is waiting or while any of its answers is.
 */
export function replLines(exchanges: readonly ReplExchange[], filter: ConsoleFilter): ReplLine[] {
  const lines: ReplLine[] = []
  const needle = filter.text.trim().toLowerCase()
  for (const exchange of exchanges) {
    const asked = needle === '' || exchange.expression.toLowerCase().includes(needle)
    const shown = (exchange.results ?? []).filter(
      (evaluation) =>
        (filter.panes === null || filter.panes.has(evaluation.pane)) &&
        (filter.levels === null || filter.levels.has(evaluationLevel(evaluation))) &&
        (asked || evaluation.text.toLowerCase().includes(needle))
    )
    if (exchange.results !== null && shown.length === 0) continue
    const { cursor, id } = exchange
    lines.push({ kind: 'input', key: `r${id}`, cursor, exchange })
    shown.forEach((evaluation, index) => {
      lines.push({ kind: 'result', key: `r${id}.${index}`, cursor, exchange, evaluation })
    })
  }
  return lines
}

/**
 * Two runs of lines in cursor order as one, still in cursor order. A REPL line goes after
 * every console line at its cursor, which is everything the window had heard when it sent.
 */
export function mergeLines<A extends PlacedLine, B extends PlacedLine>(
  lines: readonly A[],
  repl: readonly B[]
): (A | B)[] {
  if (repl.length === 0) return lines as A[]
  const merged: (A | B)[] = []
  let at = 0
  for (const line of repl) {
    while (at < lines.length && lines[at].cursor <= line.cursor) merged.push(lines[at++])
    merged.push(line)
  }
  while (at < lines.length) merged.push(lines[at++])
  return merged
}
