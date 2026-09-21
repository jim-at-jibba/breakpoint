import { useEffect, useRef, useState } from 'react'
import {
  createSnapshotReader,
  type SnapshotReader,
  type SnapshotState
} from '@renderer/lib/snapshot-reader'

type SnapshotView = SnapshotState & { retry(): void }

const INITIAL_STATE: SnapshotState = { status: 'fetching', snapshot: null }

export function useSnapshot(): SnapshotView {
  const [state, setState] = useState<SnapshotState>(INITIAL_STATE)
  const reader = useRef<SnapshotReader | null>(null)

  useEffect(() => {
    const subscription = createSnapshotReader({
      fetchSnapshot: () => window.breakpoint.invoke('project.state'),
      subscribe: (listener) => window.breakpoint.onPatches(listener),
      onChange: setState
    })
    reader.current = subscription

    return () => {
      subscription.close()
      reader.current = null
    }
  }, [])

  return { ...state, retry: (): void => reader.current?.retry() }
}
