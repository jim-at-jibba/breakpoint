import { stat } from 'node:fs/promises'
import {
  isConsoleError,
  propertiesOf,
  type Expansion,
  type HeardHandles
} from '../../shared/console'
import { affectedCapabilities, type EmulationResult } from '../../shared/emulation'
import type { ConsoleEntryBody, Entry, EventLog, PaneEntryBody } from '../../shared/event-log'
import {
  compareGeometry,
  foldPaneStatus,
  type PaneObservation,
  type PaneStatus
} from '../../shared/panes'
import type { Pane, PaneChanges, Project } from '../../shared/project'
import { resolveEntry, type FetchText, type IsFile } from '../../shared/resolution'
import type {
  EmulationSetting,
  ExpansionRequest,
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

/** What resolution asks the disk: whether a path is a file, and a failed look is a no. */
export function isFileOnDisk(absolute: string): Promise<boolean> {
  return stat(absolute).then(
    (found) => found.isFile(),
    () => false
  )
}

/** The largest script or map resolution will read. A bigger one is not worth the wait. */
export const MAX_FETCHED_BYTES = 64 * 1024 * 1024

/**
 * What resolution asks the network, through `request`: a successful response's text, and
 * nothing for anything else, a body declared larger than `MAX_FETCHED_BYTES` included.
 */
export function fetchTextWith(
  request: (url: string, init: RequestInit) => Promise<Response>
): FetchText {
  return async (url, signal) => {
    const response = await request(url, { signal })
    const length = Number(response.headers.get('content-length'))
    if (!response.ok || length > MAX_FETCHED_BYTES) {
      await response.body?.cancel().catch(() => {})
      return null
    }
    const text = await response.text()
    return { text, header: (name) => response.headers.get(name) }
  }
}

/**
 * The handles behind one entry's arguments, and the way to ask the page that minted them
 * about one. The pane host binds `properties` to the guest it heard them from, so a pane
 * whose guest has been replaced can never be asked about the old one's objects.
 */
export interface LiveHandles extends HeardHandles {
  properties(handle: string): Promise<unknown>
}

interface HandleTable {
  entries: Map<number, LiveHandles>
  pendingByContext: Map<number, Set<PendingHandleCapture>>
}

interface PendingHandleCapture {
  invalidated: boolean
}

/**
 * Entries per pane whose handles are held. V8 keeps no more console messages than this
 * per page, and lets go of the objects of the ones it drops, so holding more would only
 * hold handles that answer "no longer live" anyway.
 */
export const MAX_HELD_PER_PANE = 1_000

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
  /** The last entry queued behind a resolving one, settling once it is appended. */
  private written: Promise<void> = Promise.resolve()
  /** Entries queued and not yet appended. */
  private waiting = 0
  /**
   * Handles beside the log rather than in it ([ADR-0021]): per pane, by the cursor of
   * the entry they belong to, oldest first. A pane's table is replaced whole when its
   * page is, so an entry still resolving when that happens finds its table gone.
   */
  private held = new Map<string, HandleTable>()

  constructor(
    private readonly feed: StateFeed,
    private readonly log: EventLog,
    private readonly projects: PaneProjects,
    private readonly isFile: IsFile = isFileOnDisk
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
    for (const pane of this.held.keys()) if (!this.has(pane)) this.forget(pane)
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
    this.forget(pane)
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

  /** A new guest is a new page: nothing the one before it minted can be asked about. */
  guestCreated(pane: string, url: string): void {
    this.forget(pane)
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

  /** A connection that had attached ended while its pane remained. */
  detached(pane: string, reason: string): void {
    const message = `debugger detached: ${reason}`
    this.forget(pane)
    this.record(pane, { type: 'pane.detached', reason })
    this.observe(pane, { type: 'attachFailed', message })
  }

  /** The attachment stands, but its console could not be enabled: degraded, with why. */
  consoleFailed(pane: string, message: string): void {
    this.record(pane, { type: 'pane.consoleFailed', message })
    this.observe(pane, { type: 'consoleFailed', message })
  }

  /**
   * A load has started: a navigation, or a frame inside the page. No entry: the log
   * records where a pane got to, and "it set off" is said by the navigation entry that
   * caused it.
   */
  loading(pane: string): void {
    this.observe(pane, { type: 'loading' })
  }

  /**
   * The page in the pane has been replaced by another, so its error count starts again,
   * and only this does ([ADR-0022]). No entry, for the same reason `loading` writes none.
   */
  pageReplaced(pane: string): void {
    this.forget(pane)
    this.observe(pane, { type: 'pageReplaced' })
  }

  /** One of a pane's execution contexts has gone, a frame's say, and its objects with it. */
  contextDestroyed(pane: string, context: number): void {
    const table = this.held.get(pane)
    if (!table) return
    for (const pending of table.pendingByContext.get(context) ?? []) pending.invalidated = true
    table.pendingByContext.delete(context)
    for (const [cursor, objects] of table.entries) {
      if (objects.context === context) table.entries.delete(cursor)
    }
  }

  /**
   * A logged object's properties, asked of the page that logged it. "No longer live" is
   * an answer rather than a failure ([ADR-0021]): whether the page has gone, the page has
   * let go of the object, or the argument was never an object, there is nothing to read.
   */
  async expand({ cursor, arg = 0 }: ExpansionRequest): Promise<Expansion> {
    for (const [pane, table] of this.held) {
      const objects = table.entries.get(cursor)
      const handle = objects?.handles[arg]
      if (!objects || typeof handle !== 'string') continue
      let result: unknown
      try {
        result = await objects.properties(handle)
      } catch (error) {
        if (!this.isHeld(pane, table, cursor, objects) || handleNoLongerLives(error)) {
          return { live: false }
        }
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`could not expand argument ${arg} of entry ${cursor}: ${message}`, {
          cause: error
        })
      }
      if (!this.isHeld(pane, table, cursor, objects)) return { live: false }
      return { live: true, ...propertiesOf(result) }
    }
    return { live: false }
  }

  loaded(pane: string, url: string): void {
    this.record(pane, { type: 'pane.loaded', url })
    this.observe(pane, { type: 'loaded' })
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
    if (!current) return
    this.forget(pane)
    this.observe(pane, { type: 'guestDestroyed' })
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

  /**
   * What a pane's page said, or what the browser said about it, as the pane host heard it
   * over the attachment while showing `page`. Only for a pane of the open project: a page
   * the project has let go of is not the developer's to hear from.
   *
   * Its locations are resolved against the repo before it is appended, within the
   * resolution timeout ([ADR-0020]), fetching a bundle and its map through `fetchText`.
   * Whether it is the project's is decided now, when it was heard, so what a pane said
   * just before it went is kept, ahead of its going. An error is counted now too: waiting
   * until resolution finished could put one heard just before a load onto the next page.
   * The handles behind its arguments are held against its cursor once it has one, unless
   * the page that minted them was replaced while it resolved. Settles once appended.
   */
  async console(
    pane: string,
    body: ConsoleEntryBody,
    page: string,
    fetchText: FetchText,
    objects: LiveHandles | null = null
  ): Promise<void> {
    if (!this.has(pane)) return
    if (isConsoleError(body)) this.observe(pane, { type: 'errorHeard' })
    const context = { repoPath: this.project?.repoPath ?? null, page }
    const table = objects ? this.tableFor(pane) : undefined
    const objectContext = objects?.context
    const pending: PendingHandleCapture | null =
      typeof objectContext === 'number' && table ? { invalidated: false } : null
    if (pending && table && typeof objectContext === 'number') {
      let contextPending = table.pendingByContext.get(objectContext)
      if (!contextPending) {
        contextPending = new Set()
        table.pendingByContext.set(objectContext, contextPending)
      }
      contextPending.add(pending)
    }
    try {
      const entry = await this.record(
        pane,
        resolveEntry(body, context, { isFile: this.isFile, fetch: fetchText })
      )
      if (!objects || !table || this.held.get(pane) !== table || pending?.invalidated) return
      table.entries.set(entry.cursor, objects)
      if (table.entries.size > MAX_HELD_PER_PANE) {
        table.entries.delete(table.entries.keys().next().value as number)
      }
    } finally {
      if (pending && table && typeof objectContext === 'number') {
        const contextPending = table.pendingByContext.get(objectContext)
        contextPending?.delete(pending)
        if (contextPending?.size === 0) table.pendingByContext.delete(objectContext)
      }
    }
  }

  /** Every handle a pane's page minted, once nothing it minted can be asked about. */
  private forget(pane: string): void {
    this.held.delete(pane)
  }

  private tableFor(pane: string): HandleTable {
    let table = this.held.get(pane)
    if (!table) {
      table = { entries: new Map(), pendingByContext: new Map() }
      this.held.set(pane, table)
    }
    return table
  }

  private isHeld(pane: string, table: HandleTable, cursor: number, objects: LiveHandles): boolean {
    return this.held.get(pane) === table && table.entries.get(cursor) === objects
  }

  /**
   * Appends in the order things were observed. Only a console entry waits on anything, so
   * the log is written at once while none is resolving, and behind it while one is: a
   * page's error heard before it navigated never lands after the navigation.
   */
  private record(pane: string, body: PaneEntryBody | Promise<PaneEntryBody>): Promise<Entry> {
    if (this.waiting === 0 && !(body instanceof Promise)) {
      return Promise.resolve(this.log.append(pane, body))
    }
    this.waiting += 1
    const appended = this.written.then(async () => {
      try {
        return this.log.append(pane, await body)
      } finally {
        this.waiting -= 1
      }
    })
    // One entry that could not be appended must not hold up everything observed after it.
    this.written = appended.then(
      () => {},
      () => {}
    )
    return appended
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

/** CDP's expected answers when the execution context or remote object has gone. */
function handleNoLongerLives(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return [
    'Cannot find context with specified id',
    'Could not find object with given id',
    'Inspected target navigated or closed',
    'Debugger is not attached',
    'No debugger is attached',
    'Target closed'
  ].some((known) => message.includes(known))
}
