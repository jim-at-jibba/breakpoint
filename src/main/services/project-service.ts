import { realpath, stat } from 'node:fs/promises'
import type { EventLog } from '../../shared/event-log'
import { clampZoom } from '../../shared/canvas'
import { rotateSize } from '../../shared/panes'
import { paneFromPreset, paneFromSize, presetById, type PaneDraft } from '../../shared/presets'
import {
  createProject,
  newPaneId,
  type Pane,
  type PaneChanges,
  type Project,
  type Zoom
} from '../../shared/project'
import type { LayoutSetting, LayoutState, Navigation, Surface } from '../../shared/routes'
import { isOriginAllowed, normaliseOrigins, sameOrigins } from '../../shared/urls'
import type { StateSnapshot } from '../../shared/state'
import type { PaneCreation } from '../../shared/routes'
import { RouteError } from '../route-error'
import type { StateFeed } from '../state-feed'
import type { PaneAddition, PaneService, PaneUpdate } from './pane-service'
import type { PresetService } from './preset-service'
import type { ProjectStore } from './project-store'

/**
 * Projects: the repo the developer is working on and everything Breakpoint remembers
 * about it. Opening one loads it from the store or creates it, and announces it on the
 * feed so every window follows.
 *
 * An open that fails is written to the event log as well as thrown, so "the project
 * failed to open" reaches an agent through the channel it already polls rather than
 * through a dialog only a human sees ([ADR-0006]). That covers the launch path too,
 * where there is no caller holding the rejection.
 */
export class ProjectService {
  private current: Project | null = null
  /** Opens and pane changes, one at a time, in the order they were asked for. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: ProjectStore,
    private readonly feed: StateFeed,
    private readonly log: EventLog,
    private readonly panes: PaneService,
    private readonly presets: PresetService
  ) {}

  /**
   * `path` must exist and be a directory. It is canonicalised — symlinks, `..`, a trailing
   * slash — so every route to the same repo is the same project.
   */
  open(path: string): Promise<StateSnapshot> {
    return this.enqueue(() => this.openNext(path))
  }

  /**
   * One at a time, in the order they were asked for, so a change can never land on the
   * project an open is replacing. The caller receives the rejection; whatever is waiting
   * still gets its turn.
   */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const done = this.queue.then(work)
    this.queue = done.then(
      () => undefined,
      () => undefined
    )
    return done
  }

  private async openNext(path: string): Promise<StateSnapshot> {
    try {
      return await this.openOrCreate(path)
    } catch (error) {
      // Untagged: no pane produced it, and saying so is the entry's job.
      this.log.append(null, {
        type: 'project.openFailed',
        path,
        code: error instanceof RouteError ? error.code : 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  private async openOrCreate(path: string): Promise<StateSnapshot> {
    const repoPath = await canonicalRepoPath(path)

    const loaded = await this.store.load(repoPath)
    if (loaded.status === 'refused') {
      // Left untouched on disk: rewriting a file we could not read is how a downgrade
      // or a bad byte becomes permanent.
      throw new RouteError('PROJECT_UNREADABLE', `${repoPath}: ${loaded.message}`, {
        reason: loaded.reason,
        file: loaded.file
      })
    }

    let project: Project
    if (loaded.status === 'loaded') {
      project = loaded.project
    } else {
      // A new project's panes are resolved from the presets as they are now, exactly as a
      // pane added later is. A presets file that cannot be read refuses the open rather
      // than quietly creating the project from a set the developer did not write.
      const { presets } = await this.presets.list()
      project = createProject(repoPath, presets)
      await this.store.save(project)
    }

    this.current = project
    this.panes.open(project)
    this.feed.publish({ type: 'project.opened', project })
    return this.snapshot()
  }

  /**
   * Changes one of the open project's panes, saves the project and announces the pane.
   * Queued behind any open in flight, so a change can never land on the project an open
   * is replacing. Values the pane already has are not a change: nothing is saved or
   * announced for them.
   */
  updatePane(id: string, changes: PaneChanges): Promise<PaneUpdate> {
    return this.enqueue(() => this.replacePane(id, changes))
  }

  /**
   * Swaps a pane's width and height. Queued like every other change and resolved against
   * the pane as it is when its turn comes, so rotating while a resize is in flight
   * rotates what the resize left rather than what the caller last saw.
   */
  rotatePane(id: string): Promise<PaneUpdate> {
    return this.enqueue(() => {
      const pane = this.current?.panes.find((candidate) => candidate.id === id)
      if (!pane) throw noSuchPane(id)
      return this.replacePane(id, rotateSize(pane))
    })
  }

  /** Resolves and appends a pane in one queued operation ([ADR-0011]). */
  addPane(creation: PaneCreation): Promise<PaneAddition> {
    return this.enqueue(() => this.appendPane(creation))
  }

  removePane(id: string): Promise<{ pane: Pane }> {
    return this.enqueue(() => this.dropPane(id))
  }

  /**
   * Arranges the open project's panes, and names the pane Focus draws at 100%. Naming
   * no pane leaves the focused one as it was, so changing the layout and changing which
   * pane is focused are the same call with different arguments.
   */
  setLayout(setting: LayoutSetting): Promise<LayoutState> {
    return this.enqueue(() => this.replaceLayout(setting))
  }

  /**
   * Sets the zoom the project reopens at. Fit is one of its values, not a mode beside
   * the layouts ([ADR-0009]); what Fit draws to is the renderer's, and never stored.
   */
  setZoom(zoom: Zoom): Promise<{ zoom: Zoom }> {
    return this.enqueue(() => this.replaceZoom(zoom))
  }

  /**
   * Points every pane at one URL, already expanded by the route. `surface` is who asked:
   * navigation from the CLI is automation acting on the developer's behalf and is held
   * to the project's allowed origins; navigation from the window is the developer, and
   * is never held to anything ([ADR-0013]).
   */
  navigate(url: string, surface: Surface): Promise<Navigation> {
    return this.enqueue(() => this.pointPanes(url, surface))
  }

  /** Replaces the origins automation may navigate to, and keeps them with the project. */
  setAllowedOrigins(origins: readonly string[]): Promise<{ origins: string[] }> {
    return this.enqueue(() => this.replaceAllowedOrigins(origins))
  }

  private async appendPane(creation: PaneCreation): Promise<PaneAddition> {
    const project = this.current
    if (!project) throw new RouteError('PANE_NOT_FOUND', 'no project is open')
    const draft = await this.draftFor(creation)

    // The project's first session is its default; a pane on a session it does not have
    // is a project that will not load again.
    const pane: Pane = { ...draft, id: newPaneId(), session: project.sessions[0].id }
    const panes = [...project.panes, pane]
    await this.save({ ...project, panes })
    const index = panes.length - 1
    this.feed.publish({ type: 'pane.added', pane, index })
    return { pane, index }
  }

  private async draftFor(creation: PaneCreation): Promise<PaneDraft> {
    if (creation.preset === undefined) {
      return paneFromSize({ width: creation.width, height: creation.height })
    }
    const { presets } = await this.presets.list()
    const preset = presetById(presets, creation.preset)
    if (!preset) {
      throw new RouteError('PRESET_NOT_FOUND', `no preset ${creation.preset} in the presets file`)
    }
    return paneFromPreset(preset)
  }

  private async dropPane(id: string): Promise<{ pane: Pane }> {
    const project = this.current
    const pane = project?.panes.find((candidate) => candidate.id === id)
    if (!project || !pane) throw noSuchPane(id)

    await this.save({
      ...project,
      panes: project.panes.filter((candidate) => candidate.id !== id)
    })
    this.feed.publish({ type: 'pane.removed', pane: id })
    return { pane }
  }

  private async replacePane(id: string, changes: PaneChanges): Promise<PaneUpdate> {
    const project = this.current
    const pane = project?.panes.find((candidate) => candidate.id === id)
    if (!project || !pane) throw noSuchPane(id)

    const changed = Object.fromEntries(
      Object.entries(changes).filter(
        ([name, value]) => value !== undefined && pane[name as keyof PaneChanges] !== value
      )
    ) as PaneChanges
    if (Object.keys(changed).length === 0) return { pane, changes: changed }

    const next: Pane = { ...pane, ...changed }
    await this.save({
      ...project,
      panes: project.panes.map((candidate) => (candidate.id === id ? next : candidate))
    })
    this.panes.invalidateEmulation(id, changed)
    this.feed.publish({ type: 'pane.changed', pane: next })
    return { pane: next, changes: changed }
  }

  private async replaceLayout({ layout, focusedPane }: LayoutSetting): Promise<LayoutState> {
    const project = this.requireOpen()
    if (focusedPane !== undefined && !project.panes.some((pane) => pane.id === focusedPane)) {
      throw new RouteError('PANE_NOT_FOUND', `no pane ${focusedPane} in the open project`)
    }

    const next: LayoutState = { layout, focusedPane: focusedPane ?? project.focusedPane }
    // The layout it already has is not a change: nothing is saved, logged or announced.
    if (project.layout === next.layout && project.focusedPane === next.focusedPane) return next

    await this.save({ ...project, ...next })
    this.log.append(null, { type: 'project.layoutChanged', ...next })
    this.feed.publish({ type: 'project.layout', ...next })
    return next
  }

  private async replaceZoom(requested: Zoom): Promise<{ zoom: Zoom }> {
    const project = this.requireOpen()
    // The ends of the control are not an error: a zoom past them is clamped, not refused.
    const zoom: Zoom = requested === 'fit' ? 'fit' : clampZoom(requested)
    if (project.zoom === zoom) return { zoom }

    await this.save({ ...project, zoom })
    this.log.append(null, { type: 'project.zoomChanged', zoom })
    this.feed.publish({ type: 'project.zoom', zoom })
    return { zoom }
  }

  private async pointPanes(url: string, surface: Surface): Promise<Navigation> {
    const project = this.requireOpen()
    if (surface === 'cli' && !isOriginAllowed(url, project.allowedOrigins)) {
      this.log.append(null, { type: 'project.navigationRefused', url })
      throw new RouteError(
        'ORIGIN_NOT_ALLOWED',
        `${url} is outside this project's allowed origins`,
        { url, allowedOrigins: [...project.allowedOrigins] }
      )
    }

    // Saved only when it is different, announced always. The patch is what sends the
    // panes, and a pane that followed a link is somewhere else even when the project's
    // URL has not moved.
    if (project.startUrl !== url) await this.save({ ...project, startUrl: url })
    this.log.append(null, { type: 'project.navigated', url })
    this.feed.publish({ type: 'project.url', url })
    // The pane set is what it was: navigating moves the pages, not the panes.
    return { url, panes: project.panes.map((pane) => pane.id) }
  }

  private async replaceAllowedOrigins(given: readonly string[]): Promise<{ origins: string[] }> {
    const project = this.requireOpen()
    const origins = normaliseOrigins(given)
    if (!origins) {
      throw new RouteError('INVALID_PARAMS', 'every allowed origin must be an http or https URL')
    }
    if (sameOrigins(project.allowedOrigins, origins)) return { origins }

    await this.save({ ...project, allowedOrigins: origins })
    this.log.append(null, { type: 'project.originsChanged', origins })
    this.feed.publish({ type: 'project.allowedOrigins', origins })
    return { origins }
  }

  private requireOpen(): Project {
    if (!this.current) throw new RouteError('PROJECT_NOT_OPEN', 'no project is open')
    return this.current
  }

  /** Saved first: a change that could not be kept is not made. */
  private async save(project: Project): Promise<void> {
    await this.store.save(project)
    this.current = project
    this.panes.open(project)
  }

  snapshot(): StateSnapshot {
    return {
      revision: this.feed.revision,
      cursor: this.log.cursor,
      project: this.current,
      panes: this.panes.statuses()
    }
  }
}

function noSuchPane(id: string): RouteError {
  return new RouteError('PANE_NOT_FOUND', `no pane ${id} in the open project`)
}

async function canonicalRepoPath(path: string): Promise<string> {
  let repoPath: string
  try {
    repoPath = await realpath(path)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      throw new RouteError('INVALID_PARAMS', `no such directory: ${path}`)
    }
    throw error
  }
  if (!(await stat(repoPath)).isDirectory()) {
    throw new RouteError('INVALID_PARAMS', `not a directory: ${path}`)
  }
  return repoPath
}
