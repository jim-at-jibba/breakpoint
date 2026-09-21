import type { EventLog, PaneEntryBody } from '../../shared/event-log'
import {
  compareGeometry,
  foldPaneStatus,
  type PaneObservation,
  type PaneStatus
} from '../../shared/panes'
import type { Project } from '../../shared/project'
import type { GeometryReport, PaneListing } from '../../shared/routes'
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
    private readonly log: EventLog
  ) {}

  /**
   * Called by the project service as a project opens, before it is announced. The feed
   * patch that announces it carries no statuses: the window reconciles its own through
   * the same shared function, so both sides agree without a patch per pane.
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

  list(): { panes: PaneListing[] } {
    const panes = this.project?.panes ?? []
    return { panes: panes.map((pane) => ({ ...pane, status: this.current[pane.id] })) }
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

  loadFailed({ pane, url, code, message }: LoadFailure): void {
    this.record(pane, { type: 'pane.loadFailed', url, code, message })
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
    if (!this.has(pane))
      throw new RouteError('PANE_NOT_FOUND', `no pane ${pane} in the open project`)
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
