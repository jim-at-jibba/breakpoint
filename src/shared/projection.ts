import { applyPatch, type PatchBatch, type RevisionedPatch, type StateSnapshot } from './state'

/**
 * The renderer's side of the read path, as a pure state machine. It starts by fetching
 * a snapshot, folds in every contiguous patch after it, and on any gap throws the lot
 * away and asks for a fresh snapshot rather than reconciling.
 *
 * Reconciling would mean guessing what the missed patch did. A fresh snapshot is one
 * round trip and is always right.
 */

export type Projection =
  { status: 'fetching'; held: RevisionedPatch[] } | { status: 'live'; snapshot: StateSnapshot }

export interface ProjectionStep {
  projection: Projection
  /** The caller owes a `project.state` call, whose answer goes to `receiveSnapshot`. */
  refetch: boolean
}

export function startProjection(): Projection {
  return { status: 'fetching', held: [] }
}

export function receiveBatch(projection: Projection, batch: PatchBatch): ProjectionStep {
  if (projection.status === 'fetching') {
    return {
      projection: { status: 'fetching', held: [...projection.held, ...batch] },
      refetch: false
    }
  }
  return fold(projection.snapshot, batch)
}

export function receiveSnapshot(projection: Projection, snapshot: StateSnapshot): ProjectionStep {
  if (projection.status === 'live' && snapshot.revision < projection.snapshot.revision) {
    return { projection, refetch: false }
  }
  const held = projection.status === 'fetching' ? projection.held : []
  return fold(snapshot, held)
}

function fold(snapshot: StateSnapshot, patches: RevisionedPatch[]): ProjectionStep {
  let current = snapshot
  for (const patch of patches) {
    if (patch.revision <= current.revision) continue
    if (patch.revision !== current.revision + 1) {
      return { projection: startProjection(), refetch: true }
    }
    current = applyPatch(current, patch)
  }
  return { projection: { status: 'live', snapshot: current }, refetch: false }
}
