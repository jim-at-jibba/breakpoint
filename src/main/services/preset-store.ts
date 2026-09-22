import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  readPresetFile,
  writePresetFile,
  type Preset,
  type ReadPresetResult
} from '../../shared/presets'
import type { RefusalReason } from '../../shared/project'

/**
 * One file for every project: presets are global, so a developer's idea of "Mobile" does
 * not change per repo. It sits in the app's user data directory as plain JSON and is the
 * developer's to edit by hand, which is why nothing here rewrites a file it could not
 * read — a typo would otherwise be made permanent by the next seed.
 */

export type LoadPresetsResult =
  | { status: 'loaded'; presets: Preset[] }
  | { status: 'missing' }
  | { status: 'refused'; reason: RefusalReason; message: string }

export class PresetStore {
  constructor(readonly file: string) {}

  async load(): Promise<LoadPresetsResult> {
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

    const read: ReadPresetResult = readPresetFile(raw)
    if (!read.ok) return { status: 'refused', reason: read.reason, message: read.message }
    return { status: 'loaded', presets: read.presets }
  }

  /** Written beside the target and renamed over it, as projects are, so a crash mid-write
   * leaves the developer's old file rather than half of a new one. */
  async save(presets: readonly Preset[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const partial = `${this.file}.${process.pid}.tmp`
    await writeFile(partial, `${JSON.stringify(writePresetFile(presets), null, 2)}\n`)
    await rename(partial, this.file)
  }
}
