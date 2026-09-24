import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  readSettingsFile,
  writeSettingsFile,
  type AppSettings,
  type ReadSettingsResult
} from '../../shared/settings'
import type { RefusalReason } from '../../shared/project'

/**
 * One file for the whole app, beside `presets.json` and `certificates.json`: these are
 * the developer's choices about the tool, not about any repo, so opening a second
 * project does not open a second idea of what the chrome looks like.
 *
 * Nothing here rewrites a file it could not read. A file this build refuses is the
 * developer's record of what they set, and saving over it would turn one bad byte into a
 * silent reset.
 */

export type LoadSettingsResult =
  | { status: 'loaded'; settings: AppSettings }
  | { status: 'missing' }
  | { status: 'refused'; reason: RefusalReason; message: string }

export class SettingsStore {
  constructor(readonly file: string) {}

  async load(): Promise<LoadSettingsResult> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
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
      return { status: 'refused', reason: 'corrupt', message: 'the file is not JSON' }
    }

    const read: ReadSettingsResult = readSettingsFile(raw)
    if (!read.ok) return { status: 'refused', reason: read.reason, message: read.message }
    return { status: 'loaded', settings: read.settings }
  }

  /** Written beside the target and renamed over it, as projects and presets are, so a
   * crash mid-write leaves the old file rather than half of a new one. */
  async save(settings: AppSettings): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const partial = `${this.file}.${process.pid}.tmp`
    await writeFile(partial, `${JSON.stringify(writeSettingsFile(settings), null, 2)}\n`)
    await rename(partial, this.file)
  }
}
