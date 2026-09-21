import { realpath, stat } from 'node:fs/promises'
import type { EventLog } from '../../shared/event-log'
import { createProject, type Project } from '../../shared/project'
import type { StateSnapshot } from '../../shared/state'
import { RouteError } from '../route-error'
import type { StateFeed } from '../state-feed'
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
  private pendingOpen: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: ProjectStore,
    private readonly feed: StateFeed,
    private readonly log: EventLog
  ) {}

  /**
   * `path` must exist and be a directory. It is canonicalised — symlinks, `..`, a trailing
   * slash — so every route to the same repo is the same project.
   */
  open(path: string): Promise<StateSnapshot> {
    const opened = this.pendingOpen.then(() => this.openNext(path))
    // The caller receives the rejection; later opens must still get their turn.
    this.pendingOpen = opened.then(
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
    this.feed.publish({ type: 'project.opened', project })
    return this.snapshot()
  }

  snapshot(): StateSnapshot {
    return { revision: this.feed.revision, cursor: this.log.cursor, project: this.current }
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
