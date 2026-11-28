import { useEffect, useState } from 'react'
import { createConsoleReader, type ConsoleState } from '@renderer/lib/console-reader'
import { EMPTY_CONSOLE_HISTORY } from '../../../shared/console-feed'

const INITIAL_STATE: ConsoleState = { status: 'fetching', history: EMPTY_CONSOLE_HISTORY }

/** The log's console entries, as the window keeps them while it is mounted. */
export function useConsole(): ConsoleState {
  const [state, setState] = useState<ConsoleState>(INITIAL_STATE)

  useEffect(() => {
    const reader = createConsoleReader({
      read: (params) => window.breakpoint.invoke('log.read', params),
      subscribe: (listener) => window.breakpoint.onConsole(listener),
      onChange: setState
    })
    return () => reader.close()
  }, [])

  return state
}
