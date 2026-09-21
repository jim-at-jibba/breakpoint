import type { Project } from './project'

/**
 * What the renderer renders from: a snapshot, kept current by patches.
 *
 * The snapshot is what `project.state` returns to every surface. Patches are the
 * renderer's push channel, a discriminated union of the things that can change rather
 * than JSON Patch paths, each numbered so the renderer can tell when it missed one. The
 * event log is a separate channel and is not this.
 */

export interface StateSnapshot {
  /** The revision of the last patch folded into this snapshot. */
  revision: number
  /**
   * The event log position this snapshot was taken at, for a reader that wants to ask
   * the log what has happened since ([ADR-0006]). Patches never move it: the log is a
   * separate channel, and one patch per appended entry would be a flood. A projection
   * therefore carries the cursor of the snapshot it was fetched with, which is exactly
   * what a caller wanting "everything since I looked" should ask from.
   */
  cursor: number
  project: Project | null
}

export type StatePatch = { type: 'project.opened'; project: Project }

export interface RevisionedPatch {
  revision: number
  patch: StatePatch
}

/** Patches are shipped in batches, one per frame, so a burst costs one message. */
export type PatchBatch = RevisionedPatch[]

export function applyPatch(
  before: StateSnapshot,
  { revision, patch }: RevisionedPatch
): StateSnapshot {
  switch (patch.type) {
    case 'project.opened':
      return { revision, cursor: before.cursor, project: patch.project }
  }
}
