import { useSyncExternalStore } from 'react'
import {
  answerExchange,
  EMPTY_REPL_HISTORY,
  followFloor,
  refuseExchange,
  remember,
  sendExchange,
  type ReplExchange,
  type ReplHistory
} from '../../../shared/repl'

export interface ReplState {
  readonly exchanges: readonly ReplExchange[]
  readonly history: ReplHistory
}

/**
 * The REPL's state lives as long as the window rather than as long as the Console is
 * drawn: hiding the panel unmounts the tab, and an answer still on its way, or the history
 * typed so far, must be there when it comes back.
 */
let state: ReplState = { exchanges: [], history: EMPTY_REPL_HISTORY }
/** The display floor as last followed, kept here so a rise is seen even while hidden. */
let floorSeen: number | null = null
let nextId = 1
const listeners = new Set<() => void>()

function update(change: (current: ReplState) => ReplState): void {
  state = change(state)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export interface Repl extends ReplState {
  /** Sends an expression to one pane, or every pane with `null`, placed at `cursor`. */
  evaluate(expression: string, pane: string | null, cursor: number): void
  /** History after the reader stepped through it. */
  setHistory(history: ReplHistory): void
  /** The display floor as the snapshot now has it; a rise clears every exchange. */
  followFloor(floor: number): void
}

export function useRepl(): Repl {
  const current = useSyncExternalStore(subscribe, () => state)
  return { ...current, evaluate, setHistory, followFloor: follow }
}

function follow(floor: number): void {
  const followed = followFloor(state.exchanges, floorSeen, floor)
  floorSeen = followed.seen
  if (followed.exchanges !== state.exchanges) {
    update((current) => ({ ...current, exchanges: followed.exchanges }))
  }
}

function setHistory(history: ReplHistory): void {
  update((current) => ({ ...current, history }))
}

function evaluate(expression: string, pane: string | null, cursor: number): void {
  const id = nextId++
  update(({ exchanges, history }) => ({
    exchanges: sendExchange(exchanges, { id, cursor, time: Date.now(), expression, pane }),
    history: remember(history, expression)
  }))
  const refuse = (message: string): void =>
    update((current) => ({
      ...current,
      exchanges: refuseExchange(current.exchanges, id, message, Date.now())
    }))
  window.breakpoint
    .invoke('panes.evaluate', pane === null ? { expression } : { expression, pane })
    .then(
      (response) => {
        if (!response.ok) return refuse(response.error.message)
        update((current) => ({
          ...current,
          exchanges: answerExchange(current.exchanges, id, response.data.results, Date.now())
        }))
      },
      (error: unknown) => refuse(error instanceof Error ? error.message : String(error))
    )
}
