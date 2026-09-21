import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  projectFileName,
  readProjectFile,
  writeProjectFile,
  type Project,
  type ReadProjectResult
} from '../../shared/project'

/**
 * One file per project in the app's user data directory, named by a hash of the repo
 * path. There is no index: the directory is the list, so nothing can fall out of step
 * with it, and a corrupt file costs the one project it holds.
 */

export type LoadResult =
  | { status: 'loaded'; project: Project }
  | { status: 'missing' }
  | { status: 'refused'; reason: 'newer' | 'corrupt'; message: string; file: string }

export class ProjectStore {
  constructor(readonly directory: string) {}

  fileFor(repoPath: string): string {
    return join(this.directory, projectFileName(repoPath))
  }

  load(repoPath: string): LoadResult {
    const file = this.fileFor(repoPath)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
      throw error
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return { status: 'refused', reason: 'corrupt', message: 'the file is not JSON', file }
    }

    const read: ReadProjectResult = readProjectFile(raw)
    if (!read.ok) return { status: 'refused', reason: read.reason, message: read.message, file }
    return { status: 'loaded', project: read.project }
  }

  /**
   * Written beside the target and renamed over it, so a crash mid-write leaves the old
   * file rather than half of the new one.
   */
  save(project: Project): void {
    mkdirSync(this.directory, { recursive: true })
    const file = this.fileFor(project.repoPath)
    const partial = `${file}.${process.pid}.tmp`
    writeFileSync(partial, `${JSON.stringify(writeProjectFile(project), null, 2)}\n`)
    renameSync(partial, file)
  }

  /** Every file in the directory, loadable or not. #19 lists them from here. */
  files(): string[] {
    try {
      return readdirSync(this.directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => join(this.directory, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}
