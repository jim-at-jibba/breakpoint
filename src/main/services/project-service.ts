import { realpath, stat } from 'node:fs/promises'
import type { EventLog } from '../../shared/event-log'
import { rotateSize } from '../../shared/panes'
import { paneFromPreset, paneFromSize, presetById, type PaneDraft } from '../../shared/presets'
import {
  createProject,
  newPaneId,
  type Pane,
  type PaneChanges,
  type Project
} from '../../shared/project'
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
    return this.queued(() => this.openNext(path))
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
    return this.queued(() => this.replacePane(id, changes))
  }

  /**
   * Swaps a pane's width and height. Queued like every other change and resolved against
   * the pane as it is when its turn comes, so rotating while a resize is in flight
   * rotates what the resize left rather than what the caller last saw.
   */
  rotatePane(id: string): Promise<PaneUpdate> {
    return this.queued(() => {
      const pane = this.current?.panes.find((candidate) => candidate.id === id)
      if (!pane) throw noSuchPane(id)
      return this.replacePane(id, rotateSize(pane))
    })
  }

  /** Resolves and appends a pane in one queued operation ([ADR-0011]). */
  addPane(creation: PaneCreation): Promise<PaneAddition> {
    return this.queued(() => this.appendPane(creation))
  }

  removePane(id: string): Promise<{ pane: Pane }> {
    return this.queued(() => this.dropPane(id))
  }

  /** Behind whatever is already in flight, and never blocking what comes after it. */
  private queued<T>(step: () => T | Promise<T>): Promise<T> {
    const done = this.queue.then(step)
    this.queue = done.then(
      () => undefined,
      () => undefined
    )
    return done
  }

  private async appendPane(creation: PaneCreation): Promise<PaneAddition> {
    const project = this.current
    if (!project) throw new RouteError('PANE_NOT_FOUND', 'no project is open')
    const draft = await this.draftFor(creation)

    // The project's first session is its default; a pane on a session it does not have
    // is a project that will not load again.
    const pane: Pane = { ...draft, id: newPaneId(), session: project.sessions[0].id }
    const panes = [...project.panes, pane]
    await this.keep({ ...project, panes })
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

    await this.keep({
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
    await this.keep({
      ...project,
      panes: project.panes.map((candidate) => (candidate.id === id ? next : candidate))
    })
    this.panes.invalidateEmulation(id, changed)
    this.feed.publish({ type: 'pane.changed', pane: next })
    return { pane: next, changes: changed }
  }

  /**
   * Saved first, then held, then the panes reconciled: a change that could not be kept is
   * not made, and nothing is announced that a reopen would contradict.
   */
  private async keep(project: Project): Promise<void> {
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
