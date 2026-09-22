import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  readCertificateFile,
  writeCertificateFile,
  type ReadCertificatesResult,
  type TrustedCertificate
} from '../../shared/certificates'
import type { RefusalReason } from '../../shared/project'

/**
 * One file for every project: a certificate belongs to a host and a machine, not to a
 * repo ([ADR-0012]), so two projects on one staging server share the decision. It sits
 * in the app's user data directory beside `presets.json` as plain JSON.
 *
 * Nothing here rewrites a file it could not read. A file this build refuses is the
 * developer's record of what they trusted, and saving over it would turn one bad byte
 * into a silent reset of every decision they ever made.
 */

export type LoadCertificatesResult =
  | { status: 'loaded'; certificates: TrustedCertificate[] }
  | { status: 'missing' }
  | { status: 'refused'; reason: RefusalReason; message: string }

export class CertificateStore {
  constructor(readonly file: string) {}

  async load(): Promise<LoadCertificatesResult> {
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

    const read: ReadCertificatesResult = readCertificateFile(raw)
    if (!read.ok) return { status: 'refused', reason: read.reason, message: read.message }
    return { status: 'loaded', certificates: read.certificates }
  }

  /** Written beside the target and renamed over it, as projects and presets are, so a
   * crash mid-write leaves the old file rather than half of a new one. */
  async save(certificates: readonly TrustedCertificate[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const partial = `${this.file}.${process.pid}.tmp`
    await writeFile(partial, `${JSON.stringify(writeCertificateFile(certificates), null, 2)}\n`)
    await rename(partial, this.file)
  }
}
