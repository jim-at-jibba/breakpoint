import { reconcilePaneStatuses, whyPaneIsNotReady, type PaneStatus } from './panes'
import type { Layout, Pane, Project, Zoom } from './project'

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
  /**
   * What is observed of each of the open project's panes, keyed by pane id: its
   * attachment, its last geometry check, and why it is degraded if it is. Not stored —
   * a pane's status is true of this run only. Empty when nothing is open.
   */
  panes: Record<string, PaneStatus>
}

export type StatePatch =
  | { type: 'project.opened'; project: Project }
  | { type: 'pane.status'; pane: string; status: PaneStatus }
  /** A saved declaration; any affected capabilities were marked pending before this patch. */
  | { type: 'pane.changed'; pane: Pane }
  /** A pane added to the open project, at the position it was added at. */
  | { type: 'pane.added'; pane: Pane; index: number }
  | { type: 'pane.removed'; pane: string }
  /** How the panes are arranged, and which one Focus draws at 100%. */
  | { type: 'project.layout'; layout: Layout; focusedPane: string | null }
  /** The zoom control's value, which may be Fit ([ADR-0009]). */
  | { type: 'project.zoom'; zoom: Zoom }
  /**
   * Where the project's panes are pointed. Published on every navigation, including one
   * to the URL the project already held: it is what tells a pane that wandered off on a
   * link to come back, so it is an announcement of an act and not of a difference.
   */
  | { type: 'project.url'; url: string }
  /** The origins automation may navigate to ([ADR-0013]). */
  | { type: 'project.allowedOrigins'; origins: string[] }

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
      return {
        revision,
        cursor: before.cursor,
        project: patch.project,
        panes: paneStatusesFor(patch.project, before.panes)
      }
    case 'pane.status':
      if (!Object.hasOwn(before.panes, patch.pane)) return { ...before, revision }
      return { ...before, revision, panes: { ...before.panes, [patch.pane]: patch.status } }
    case 'pane.changed': {
      const { project } = before
      const { pane } = patch
      if (!project?.panes.some((candidate) => candidate.id === pane.id)) {
        return { ...before, revision }
      }
      const panes = project.panes.map((candidate) => (candidate.id === pane.id ? pane : candidate))
      return { ...before, revision, project: { ...project, panes } }
    }
    case 'pane.added': {
      const { project } = before
      // A pane the project already has is a patch seen twice, not a second pane.
      if (!project || project.panes.some((candidate) => candidate.id === patch.pane.id)) {
        return { ...before, revision }
      }
      const panes = [...project.panes]
      panes.splice(Math.min(patch.index, panes.length), 0, patch.pane)
      return withPanes(before, revision, { ...project, panes })
    }
    case 'pane.removed': {
      const { project } = before
      if (!project?.panes.some((candidate) => candidate.id === patch.pane)) {
        return { ...before, revision }
      }
      const panes = project.panes.filter((candidate) => candidate.id !== patch.pane)
      return withPanes(before, revision, { ...project, panes })
    }
    case 'project.layout': {
      const { project } = before
      if (!project) return { ...before, revision }
      const { layout, focusedPane } = patch
      return { ...before, revision, project: { ...project, layout, focusedPane } }
    }
    case 'project.zoom': {
      const { project } = before
      if (!project) return { ...before, revision }
      return { ...before, revision, project: { ...project, zoom: patch.zoom } }
    }
    case 'project.url': {
      const { project } = before
      if (!project) return { ...before, revision }
      return { ...before, revision, project: { ...project, startUrl: patch.url } }
    }
    case 'project.allowedOrigins': {
      const { project } = before
      if (!project) return { ...before, revision }
      return { ...before, revision, project: { ...project, allowedOrigins: patch.origins } }
    }
  }
}

/**
 * A new pane set, with the statuses reconciled through the same function the main process
 * uses: surviving panes keep what is known about them, a new pane starts over, and a pane
 * that has gone is forgotten.
 */
function withPanes(before: StateSnapshot, revision: number, project: Project): StateSnapshot {
  return { ...before, revision, project, panes: paneStatusesFor(project, before.panes) }
}

/**
 * The statuses a project's panes have once it is open, given what was known before. The
 * main process and the renderer both call this on every open, so they agree without the
 * reset having to be announced pane by pane.
 */
export function paneStatusesFor(
  project: Project,
  previous: Readonly<Record<string, PaneStatus>>
): Record<string, PaneStatus> {
  return reconcilePaneStatuses(
    previous,
    project.panes.map((pane) => pane.id)
  )
}

/**
 * Whether every pane of the open project is ready — loaded where it was sent and drawn
 * at the size it claims — and what is holding it up if not.
 *
 * This is what `--wait` resolves on ([#16]). The reason is written for the terminal that
 * gave up waiting: an agent told the wait timed out needs to know which pane never
 * arrived, and "the page never loaded" and "the pane is the wrong size" are different
 * bugs to go and look at.
 */
export type Readiness = { ready: true } | { ready: false; reason: string }

export function snapshotReadiness(snapshot: StateSnapshot): Readiness {
  const { project } = snapshot
  // Nothing open is not a quiet success: there are no panes to have loaded, so a caller
  // waiting for them is waiting for something that is not going to happen on its own.
  if (!project) return { ready: false, reason: 'no project is open' }

  const outstanding = project.panes
    .map((pane) => describeOutstanding(pane.name, snapshot.panes[pane.id]))
    .filter((reason): reason is string => reason !== null)

  if (outstanding.length === 0) return { ready: true }
  return { ready: false, reason: outstanding.join('; ') }
}

/** One pane's reason with its name on the front, or null if that pane is ready. */
function describeOutstanding(name: string, status: PaneStatus | undefined): string | null {
  // A pane the snapshot has no status for is a desync, not a pane in some state.
  if (!status) return `${name} has not reported yet`
  const why = whyPaneIsNotReady(status)
  return why === null ? null : `${name} ${why}`
}
