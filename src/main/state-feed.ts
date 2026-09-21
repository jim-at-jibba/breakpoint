import type { RevisionedPatch, StatePatch } from '../shared/state'

/**
 * Where services announce that state changed. One counter across every service, so
 * the renderer has a single sequence to check for gaps, and one place for the push
 * adapter to listen.
 */
export class StateFeed {
  private current = 0
  private readonly listeners = new Set<(patch: RevisionedPatch) => void>()

  /** The revision of the last patch published; what a snapshot taken now is stamped with. */
  get revision(): number {
    return this.current
  }

  publish(patch: StatePatch): RevisionedPatch {
    this.current += 1
    const revisioned: RevisionedPatch = { revision: this.current, patch }
    for (const listener of this.listeners) listener(revisioned)
    return revisioned
  }

  subscribe(listener: (patch: RevisionedPatch) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
