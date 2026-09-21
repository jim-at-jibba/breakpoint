import { realpath, stat } from 'node:fs/promises'
import type { EventLog } from '../../shared/event-log'
import type { EmulationChanges } from '../../shared/emulation'
import { createProject, type Pane, type Project } from '../../shared/project'
import type { StateSnapshot } from '../../shared/state'
import { RouteError } from '../route-error'
import type { StateFeed } from '../state-feed'
import type { PaneService, PaneUpdate } from './pane-service'
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
    private readonly panes: PaneService
  ) {}

  /**
   * `path` must exist and be a directory. It is canonicalised — symlinks, `..`, a trailing
   * slash — so every route to the same repo is the same project.
   */
  open(path: string): Promise<StateSnapshot> {
    const opened = this.queue.then(() => this.openNext(path))
    // The caller receives the rejection; later opens must still get their turn.
    this.queue = opened.then(
      () => undefined,
      () => undefined
    )
    return opened
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
      project = createProject(repoPath)
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
  updatePane(id: string, changes: EmulationChanges): Promise<PaneUpdate> {
    const updated = this.queue.then(() => this.replacePane(id, changes))
    this.queue = updated.then(
      () => undefined,
      () => undefined
    )
    return updated
  }

  private async replacePane(id: string, changes: EmulationChanges): Promise<PaneUpdate> {
    const project = this.current
    const pane = project?.panes.find((candidate) => candidate.id === id)
    if (!project || !pane)
      throw new RouteError('PANE_NOT_FOUND', `no pane ${id} in the open project`)

    const changed = Object.fromEntries(
      Object.entries(changes).filter(
        ([name, value]) => value !== undefined && pane[name as keyof EmulationChanges] !== value
      )
    ) as EmulationChanges
    if (Object.keys(changed).length === 0) return { pane, changes: changed }

    const next: Pane = { ...pane, ...changed }
    const updated: Project = {
      ...project,
      panes: project.panes.map((candidate) => (candidate.id === id ? next : candidate))
    }
    // Saved first: a change that could not be kept is not made.
    await this.store.save(updated)
    this.current = updated
    this.panes.open(updated)
    this.panes.invalidateEmulation(id, changed)
    this.feed.publish({ type: 'pane.changed', pane: next })
    return { pane: next, changes: changed }
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
