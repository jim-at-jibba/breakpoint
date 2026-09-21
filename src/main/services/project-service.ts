import { realpathSync, statSync } from 'node:fs'
import { createProject, type Project } from '../../shared/project'
import type { StateSnapshot } from '../../shared/state'
import { RouteError } from '../route-error'
import type { StateFeed } from '../state-feed'
import type { ProjectStore } from './project-store'

/**
 * Projects: the repo the developer is working on and everything Breakpoint remembers
 * about it. Opening one loads it from the store or creates it, and announces it on the
 * feed so every window follows.
 */
export class ProjectService {
  private current: Project | null = null

  constructor(
    private readonly store: ProjectStore,
    private readonly feed: StateFeed
  ) {}

  /**
   * `path` must exist and be a directory. It is canonicalised — symlinks, `..`, a trailing
   * slash — so every route to the same repo is the same project.
   */
  open(path: string): StateSnapshot {
    const repoPath = canonicalRepoPath(path)

    const loaded = this.store.load(repoPath)
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
      this.store.save(project)
    }

    this.current = project
    this.feed.publish({ type: 'project.opened', project })
    return this.snapshot()
  }

  snapshot(): StateSnapshot {
    return { revision: this.feed.revision, project: this.current }
  }
}

function canonicalRepoPath(path: string): string {
  let repoPath: string
  try {
    repoPath = realpathSync.native(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RouteError('INVALID_PARAMS', `no such directory: ${path}`)
    }
    throw error
  }
  if (!statSync(repoPath).isDirectory()) {
    throw new RouteError('INVALID_PARAMS', `not a directory: ${path}`)
  }
  return repoPath
}
