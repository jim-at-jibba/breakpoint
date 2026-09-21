import { useEffect, useRef, useState } from 'react'
import {
  receiveBatch,
  receiveSnapshot,
  startProjection,
  type Projection,
  type ProjectionStep
} from '@shared/projection'
import type { StateSnapshot } from '@shared/state'

/**
 * The renderer's read path. Fetches the snapshot over `project.state`, folds in the
 * patch batches the main process pushes, and on any gap re-fetches wholesale. The rules
 * live in the shared projection module; this only runs them against the bridge.
 */
export function useSnapshot(): StateSnapshot | null {
  const [projection, setProjection] = useState<Projection>(startProjection)
  const current = useRef(projection)

  useEffect(() => {
    let disposed = false

    const step = (result: ProjectionStep): void => {
      current.current = result.projection
      setProjection(result.projection)
      if (result.refetch) void fetchSnapshot()
    }

    const fetchSnapshot = async (): Promise<void> => {
      const response = await window.breakpoint.invoke('project.state')
      if (disposed || !response.ok) return
      step(receiveSnapshot(current.current, response.data))
    }

    const unsubscribe = window.breakpoint.onPatches((batch) => {
      if (!disposed) step(receiveBatch(current.current, batch))
    })
    void fetchSnapshot()

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return projection.status === 'live' ? projection.snapshot : null
}
