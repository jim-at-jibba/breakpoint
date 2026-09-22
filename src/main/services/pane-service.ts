import { affectedCapabilities, type EmulationResult } from '../../shared/emulation'
import type { EventLog, PaneEntryBody } from '../../shared/event-log'
import {
  compareGeometry,
  foldPaneStatus,
  type PaneObservation,
  type PaneStatus
} from '../../shared/panes'
import type { Pane, PaneChanges, Project } from '../../shared/project'
import type {
  EmulationSetting,
  GeometryReport,
  PaneCreation,
  PaneListing,
  PaneResize
} from '../../shared/routes'
import { paneStatusesFor } from '../../shared/state'
import { RouteError } from '../route-error'
import type { StateFeed } from '../state-feed'

interface AttachmentFailure {
  pane: string
  attempt: 1 | 2
  retrying: boolean
  message: string
}

interface LoadFailure {
  pane: string
  url: string
  code: number
  message: string
}

interface GuestDestruction {
  pane: string
  current: boolean
}

/** A pane after a change, and which of the asked-for values were actually different. */
export interface PaneUpdate {
  pane: Pane
  changes: PaneChanges
}

/** A pane as added, and where in the set it landed. */
export interface PaneAddition {
  pane: Pane
  index: number
}

/**
 * Where a pane's declared values are changed. The project service owns the open project
 * and its file; these are the things panes need from it. Every one of them is queued
 * there, so two surfaces changing the pane set at once still agree on the result.
 */
export interface PaneProjects {
  updatePane(pane: string, changes: PaneChanges): Promise<PaneUpdate>
  addPane(creation: PaneCreation): Promise<PaneAddition>
  removePane(pane: string): Promise<{ pane: Pane }>
  rotatePane(pane: string): Promise<PaneUpdate>
}

/**
 * Panes as the app observes them while it runs: whether each has its attachment, whether
 * it is drawn at the size it claims, and why it is degraded if it is.
 *
 * Every observation is written to the event log tagged with the pane — pane lifecycle is
 * the log's first pane-tagged producer — and every change of status goes out on the feed
 * so the window follows. The Electron side of a pane lives in `PaneHost`, which reports
 * here by pane id; nothing in this class holds an Electron object ([ADR-0005]).
 */
export class PaneService {
  private project: Project | null = null
  private current: Record<string, PaneStatus> = {}

  constructor(
    private readonly feed: StateFeed,
    private readonly log: EventLog,
    private readonly projects: PaneProjects
  ) {}

  /**
   * Called by the project service as a project opens or one of its panes changes, before
   * either is announced. The feed patch that announces it carries no statuses: the window
   * reconciles its own through the same shared function, so both sides agree without a
   * patch per pane.
   */
  open(project: Project): void {
    this.project = project
    this.current = paneStatusesFor(project, this.current)
  }

  statuses(): Record<string, PaneStatus> {
    return this.current
  }

  has(pane: string): boolean {
    return Object.hasOwn(this.current, pane)
  }

  /** What a pane declares, for whatever emulates it. */
  paneFor(pane: string): Pane | undefined {
    return this.project?.panes.find((candidate) => candidate.id === pane)
  }

  list(): { panes: PaneListing[] } {
    const panes = this.project?.panes ?? []
    return { panes: panes.map((pane) => ({ ...pane, status: this.current[pane.id] })) }
  }

  /**
   * Adds a pane from a preset or at a size the caller gave. The queued project mutation
   * resolves a preset into the pane's own values once, and the pane remembers only which
   * preset it came from ([ADR-0011]) — so later edits leave this pane exactly as it is.
   */
  async add(creation: PaneCreation): Promise<{ pane: PaneListing; index: number }> {
    const { pane, index } = await this.projects.addPane(creation)
    this.record(pane.id, {
      type: 'pane.added',
      width: pane.width,
      height: pane.height,
      preset: pane.preset
    })
    return { pane: { ...pane, status: this.current[pane.id] }, index }
  }

  /**
   * Takes a pane out of the project. Every other pane keeps what is observed of it: their
   * guests are the same ones, and the pane that went is simply forgotten.
   */
  async remove(pane: string): Promise<{ pane: Pane }> {
    if (!this.has(pane)) throw noSuchPane(pane)
    const removed = await this.projects.removePane(pane)
    this.record(pane, { type: 'pane.removed' })
    return removed
  }

  /** Exact dimensions, typed rather than dragged. The emulated viewport follows. */
  async resize({ pane, ...size }: PaneResize): Promise<{ pane: PaneListing }> {
    return this.resized(pane, await this.projects.updatePane(pane, size))
  }

  /** Landscape from portrait and back, without the developer doing the arithmetic. */
  async rotate(pane: string): Promise<{ pane: PaneListing }> {
    return this.resized(pane, await this.projects.rotatePane(pane))
  }

  private resized(pane: string, update: PaneUpdate): { pane: PaneListing } {
    if (update.changes.width !== undefined || update.changes.height !== undefined) {
      this.record(pane, {
        type: 'pane.resized',
        width: update.pane.width,
        height: update.pane.height
      })
    }
    return { pane: { ...update.pane, status: this.current[pane] } }
  }

  guestCreated(pane: string, url: string): void {
    this.record(pane, { type: 'pane.created', url })
    this.observe(pane, { type: 'guestCreated' })
  }

  attached(pane: string, attempt: 1 | 2): void {
    this.record(pane, { type: 'pane.attached', attempt })
    this.observe(pane, { type: 'attached' })
  }

  attachFailed({ pane, attempt, retrying, message }: AttachmentFailure): void {
    this.record(pane, { type: 'pane.attachFailed', attempt, retrying, message })
    this.observe(pane, { type: 'attachFailed', message })
  }

  loaded(pane: string, url: string): void {
    this.record(pane, { type: 'pane.loaded', url })
  }

  /**
   * A page that did not load is an error against the pane, counted by its header. It is
   * not a degradation: the attachment and the overrides may be perfectly in force, and
   * saying a pane is degraded because the dev server was down would make the marker mean
   * nothing.
   */
  loadFailed({ pane, url, code, message }: LoadFailure): void {
    this.record(pane, { type: 'pane.loadFailed', url, code, message })
    this.observe(pane, { type: 'loadFailed' })
  }

  /**
   * `current` is false for a guest the pane has already replaced: its going is recorded,
   * but what is observed of the replacement stands.
   */
  guestDestroyed({ pane, current }: GuestDestruction): void {
    this.record(pane, { type: 'pane.destroyed' })
    if (current) this.observe(pane, { type: 'guestDestroyed' })
  }

  /**
   * Deliberately never corrects the pane: a mismatch means our model of it is wrong, and
   * resizing to match is how the original instance of this bug stayed hidden ([ADR-0004]).
   * An entry is written when the pane goes wrong or comes right, not on every report.
   */
  reportGeometry({ pane, expected, measured }: GeometryReport): { status: PaneStatus } {
    if (!this.has(pane)) throw noSuchPane(pane)
    const before = this.current[pane]

    const result = compareGeometry(expected, measured)
    if (!result.ok) {
      const known = before.degraded.find((degradation) => degradation.cause === 'geometry')
      if (known?.message !== result.message) {
        this.record(pane, {
          type: 'pane.geometryMismatch',
          expected,
          measured,
          message: result.message
        })
      }
    } else if (before.geometry === 'mismatch') {
      this.record(pane, { type: 'pane.geometryMatched' })
    }

    this.observe(pane, { type: 'geometryChecked', result })
    return { status: this.current[pane] }
  }

  /**
   * Changes what a pane emulates. The pane host follows the announcement and reapplies
   * the overrides to the pane's guest; what it manages to apply is reported separately,
   * through `emulated`, because a change that is saved is not yet a change in force.
   */
  async setEmulation({ pane, ...changes }: EmulationSetting): Promise<{ pane: PaneListing }> {
    const update = await this.projects.updatePane(pane, changes)
    if (Object.keys(update.changes).length > 0) {
      this.record(pane, { type: 'pane.emulationChanged', changes: update.changes })
    }
    return { pane: { ...update.pane, status: this.current[pane] } }
  }

  invalidateEmulation(pane: string, changes: PaneChanges): void {
    this.observe(pane, { type: 'emulationPending', capabilities: affectedCapabilities(changes) })
  }

  /**
   * What the latest application of a pane's overrides achieved, capability by capability.
   * An entry is written when a capability starts failing, fails differently, or recovers —
   * not on every reapply, which happens on every navigation and says nothing new.
   */
  emulated(pane: string, results: readonly EmulationResult[]): void {
    if (!this.has(pane)) return
    const before = this.current[pane]
    for (const result of results) {
      const { capability } = result
      if (!result.ok) {
        const known = before.degraded.find((degradation) => degradation.cause === capability)
        if (known?.message !== result.message) {
          this.record(pane, { type: 'pane.emulationFailed', capability, message: result.message })
        }
      } else if (before.degraded.some((degradation) => degradation.cause === capability)) {
        this.record(pane, { type: 'pane.emulationRecovered', capability })
      }
    }
    this.observe(pane, { type: 'emulated', results })
  }

  private record(pane: string, body: PaneEntryBody): void {
    this.log.append(pane, body)
  }

  /** Statuses change only for panes of the open project, and are announced only on change. */
  private observe(pane: string, observation: PaneObservation): void {
    if (!this.has(pane)) return
    const before = this.current[pane]
    const after = foldPaneStatus(before, observation)
    if (JSON.stringify(after) === JSON.stringify(before)) return
    this.current = { ...this.current, [pane]: after }
    this.feed.publish({ type: 'pane.status', pane, status: after })
  }
}

function noSuchPane(pane: string): RouteError {
  return new RouteError('PANE_NOT_FOUND', `no pane ${pane} in the open project`)
}
