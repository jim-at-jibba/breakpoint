import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  projectFileName,
  readProjectFile,
  writeProjectFile,
  type Project,
  type ReadProjectResult,
  type RefusalReason
} from '../../shared/project'

/**
 * One file per project in the app's user data directory, named by a hash of the repo
 * path. There is no index: the directory is the list, so nothing can fall out of step
 * with it, and a corrupt file costs the one project it holds.
 */

export type LoadResult =
  | { status: 'loaded'; project: Project }
  | { status: 'missing' }
  | { status: 'refused'; reason: RefusalReason; message: string; file: string }

export class ProjectStore {
  constructor(readonly directory: string) {}

  fileFor(repoPath: string): string {
    return join(this.directory, projectFileName(repoPath))
  }

  async load(repoPath: string): Promise<LoadResult> {
    const file = this.fileFor(repoPath)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { status: 'missing' }
      }
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
    if (read.project.repoPath !== repoPath) {
      return {
        status: 'refused',
        reason: 'corrupt',
        message: `stored repo path ${read.project.repoPath} does not match ${repoPath}`,
        file
      }
    }
    return { status: 'loaded', project: read.project }
  }

  /**
   * Written beside the target and renamed over it, so a crash mid-write leaves the old
   * file rather than half of the new one.
   */
  async save(project: Project): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const file = this.fileFor(project.repoPath)
    const partial = `${file}.${process.pid}.tmp`
    await writeFile(partial, `${JSON.stringify(writeProjectFile(project), null, 2)}\n`)
    await rename(partial, file)
  }
}
