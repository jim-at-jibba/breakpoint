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
  _before: StateSnapshot,
  { revision, patch }: RevisionedPatch
): StateSnapshot {
  switch (patch.type) {
    case 'project.opened':
      return { revision, project: patch.project }
  }
}
