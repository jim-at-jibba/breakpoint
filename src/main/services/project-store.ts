import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  projectFileName,
  readProjectFile,
  writeProjectFile,
  type Project,
  type ReadProjectResult,
  type RefusalReason
} from '../../shared/project'
import {
  compareProjectListings,
  salvageProjectIdentity,
  type ProjectListing
} from '../../shared/project-listing'

/**
 * One file per project in the app's user data directory, named by a hash of the repo
 * path. There is no index: the directory is the list, so nothing can fall out of step
 * with it, and a corrupt file costs the one project it holds.
 */

export type LoadResult =
  | { status: 'loaded'; project: Project }
  | { status: 'missing' }
  | { status: 'refused'; reason: RefusalReason; message: string; file: string }

/** The extension every project file carries. A partial write is named `.tmp` and is not one. */
const PROJECT_FILE_EXTENSION = '.json'

/** One file read and parsed, before a caller decides what its refusal means. */
type FileRead =
  | { status: 'loaded'; project: Project }
  | { status: 'missing' }
  /** `raw` is what parsed as JSON, for salvaging an identity out of a file that is not a project. */
  | { status: 'refused'; reason: RefusalReason; message: string; raw: unknown }

export class ProjectStore {
  constructor(readonly directory: string) {}

  fileFor(repoPath: string): string {
    return join(this.directory, projectFileName(repoPath))
  }

  async load(repoPath: string): Promise<LoadResult> {
    const file = this.fileFor(repoPath)
    const read = await this.read(file)
    if (read.status === 'missing') return read
    if (read.status === 'refused') {
      return { status: 'refused', reason: read.reason, message: read.message, file }
    }
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
   * Every project the directory holds, in the order the switcher lists them. The
   * directory is the list, so a project another window created is here the next time
   * this is called, and a file that will not load costs its own entry rather than the
   * list.
   *
   * A directory that does not exist is an empty list rather than a failure: that is what
   * a first run looks like before anything has been saved.
   */
  async list(): Promise<ProjectListing[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      throw error
    }

    const listings = await Promise.all(
      names
        .filter((name) => name.endsWith(PROJECT_FILE_EXTENSION))
        .map((name) => this.listOne(name))
    )
    // A file removed between reading the directory and reading it is not in the list,
    // which is the answer a directory read a moment later would have given anyway.
    return listings
      .filter((listing): listing is ProjectListing => listing !== undefined)
      .sort(compareProjectListings)
  }

  private async listOne(file: string): Promise<ProjectListing | undefined> {
    const read = await this.read(join(this.directory, file))
    if (read.status === 'missing') return undefined
    if (read.status === 'refused') {
      return {
        file,
        openable: false,
        ...salvageProjectIdentity(read.raw),
        reason: read.reason,
        message: read.message
      }
    }
    const { name, repoPath } = read.project
    // A file not named for the repo path it stores is a file `load` would never find,
    // so listing it as openable would offer an open that opens something else.
    if (projectFileName(repoPath) !== file) {
      return {
        file,
        openable: false,
        name,
        repoPath,
        reason: 'corrupt',
        message: `the file is not the one repo path ${repoPath} is stored in`
      }
    }
    return { file, openable: true, name, repoPath }
  }

  private async read(file: string): Promise<FileRead> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { status: 'missing' }
      throw error
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return {
        status: 'refused',
        reason: 'corrupt',
        message: 'the file is not JSON',
        raw: undefined
      }
    }

    const parsed: ReadProjectResult = readProjectFile(raw)
    if (!parsed.ok) {
      return { status: 'refused', reason: parsed.reason, message: parsed.message, raw }
    }
    return { status: 'loaded', project: parsed.project }
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

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
