import type { RefusalReason } from './project'
import { isLoopbackHost } from './urls'

/**
 * Certificate trust: what Breakpoint does when a pane is sent to an `https` origin whose
 * certificate Chromium will not verify.
 *
 * Trust is keyed on the host **and** the certificate's SHA-256 fingerprint, never the
 * host alone ([ADR-0012]). Keyed on the host alone, trusting a dev certificate today
 * would silently extend that trust to every future certificate served on that host —
 * which on `localhost` is every project on the machine, forever.
 *
 * Pure: the store in the main process reads and writes the file and the service holds
 * Chromium's callbacks. This module decides what a valid file says, and what the answer
 * to one refused certificate is.
 */

/**
 * The failures loopback is allowed to answer for itself. Chromium reports a self-signed
 * certificate and one signed by an authority it cannot reach as the same net error —
 * there is no separate self-signed code — so this single string is both of the cases
 * [ADR-0012] names. Every other failure prompts, on loopback as anywhere else.
 */
export const AUTO_TRUSTED_CERTIFICATE_ERRORS: ReadonlySet<string> = new Set([
  'net::ERR_CERT_AUTHORITY_INVALID'
])

/**
 * What is true of the certificate itself, read from it rather than from the failure
 * Chromium reported. Both of these matter because Chromium collapses a certificate's
 * several faults into one net error and reports the unreachable authority first: an
 * expired certificate and one naming the wrong host both arrive looking exactly like the
 * dev certificate loopback is allowed to trust, and only the certificate says otherwise.
 */
export interface CertificateFacts {
  /** SHA-256 over the DER, spelled `sha256/<base64>` as Electron spells it. */
  fingerprint: string
  subject: string
  issuer: string
  /** Whether the certificate names the host it was served for. */
  namesHost: boolean
  /** Whether now is inside the certificate's validity window. */
  current: boolean
  /** Faults read from the PEM, in addition to Chromium's reported error. */
  errors: string[]
}

/**
 * What one decision is named by: the host the certificate was served for, and the
 * certificate's own SHA-256 fingerprint. Never the host alone ([ADR-0012]), which is why
 * the two always travel together and do so as one type.
 */
export interface CertificateKey {
  /** The host it was served for. Never the origin: a port is a lease, not a name. */
  host: string
  fingerprint: string
}

/** A hostname contains no spaces, so the two parts cannot collide. */
export function certificateKey({ host, fingerprint }: CertificateKey): string {
  return `${host} ${fingerprint}`
}

/** A decision the developer made, kept in the app's user data directory. */
export interface TrustedCertificate extends CertificateKey {
  subject: string
  issuer: string
  /** The net error it was trusted through, so settings can say what was waived. */
  error: string
  /** All known faults at consent time. Older stored decisions have only `error`. */
  errors?: string[]
  /** Milliseconds since the epoch, when the developer trusted it. */
  trustedAt: number
}

/**
 * A certificate waiting on the developer. One per host and fingerprint however many
 * panes are held by it: three panes on one project meet the same certificate three
 * times, and that is one question.
 */
export interface CertificateRequest extends CertificateKey {
  subject: string
  issuer: string
  error: string
  /** Chromium's error plus independently detected faults. */
  errors?: string[]
  /** The URL whose load is waiting on the answer. */
  url: string
  /** Milliseconds since the epoch, when the question was raised. */
  askedAt: number
}

/**
 * Why a certificate Chromium refused was accepted. `loopback` is the rule and the other
 * two are decisions: one made now, one made before and kept ([ADR-0012]).
 */
export type CertificateTrustReason = 'loopback' | 'stored' | 'developer'

/** Certificate trust as a surface sees it: what is stored, and what is being asked. */
export interface CertificateState {
  trusted: TrustedCertificate[]
  waiting: CertificateRequest[]
}

/**
 * `stored` — the developer has already answered for this exact certificate on this host.
 * `loopback` — a dev server's certificate on this machine, which is never asked about.
 * `prompt` — everything else, which is asked once and then stored.
 */
export type CertificateVerdict = 'stored' | 'loopback' | 'prompt'

export interface CertificateQuestion {
  host: string
  /** Chromium's net error, such as `net::ERR_CERT_AUTHORITY_INVALID`. */
  error: string
  facts: CertificateFacts
  trusted: readonly TrustedCertificate[]
}

export function certificateVerdict({
  host,
  error,
  facts,
  trusted
}: CertificateQuestion): CertificateVerdict {
  if (hasCertificate(trusted, { host, fingerprint: facts.fingerprint })) return 'stored'
  if (
    isLoopbackHost(host) &&
    AUTO_TRUSTED_CERTIFICATE_ERRORS.has(error) &&
    facts.current &&
    facts.namesHost
  ) {
    return 'loopback'
  }
  return 'prompt'
}

export function hasCertificate(
  certificates: readonly TrustedCertificate[],
  { host, fingerprint }: CertificateKey
): boolean {
  return certificates.some(
    (candidate) => candidate.host === host && candidate.fingerprint === fingerprint
  )
}

/**
 * Chromium's net error in words. A developer deciding whether to trust a certificate is
 * deciding on what is wrong with it, and `net::ERR_CERT_COMMON_NAME_INVALID` is not a
 * sentence. An error this does not know is shown as it came, which is still better than
 * a shrug.
 */
export function describeCertificateError(error: string): string {
  switch (error) {
    case 'net::ERR_CERT_AUTHORITY_INVALID':
      return 'signed by an authority this machine does not know'
    case 'net::ERR_CERT_DATE_INVALID':
      return 'outside its validity dates'
    case 'net::ERR_CERT_COMMON_NAME_INVALID':
      return 'issued for a different host'
    case 'net::ERR_CERT_REVOKED':
      return 'revoked by its issuer'
    case 'net::ERR_CERT_WEAK_SIGNATURE_ALGORITHM':
      return 'signed with an algorithm that is no longer trusted'
    case 'net::ERR_CERT_WEAK_KEY':
      return 'using a key that is too weak'
    case 'net::ERR_CERT_INVALID':
      return 'malformed'
    default:
      return error
  }
}

export function describeCertificateErrors({
  error,
  errors = []
}: {
  error: string
  errors?: readonly string[]
}): string {
  return [...new Set([error, ...errors])].map(describeCertificateError).join(' and ')
}

/** Why a certificate was accepted, in words, for the surfaces that print entries. */
export function describeCertificateTrustReason(reason: CertificateTrustReason): string {
  switch (reason) {
    case 'loopback':
      return 'a dev server on this machine'
    case 'stored':
      return 'a stored decision'
    case 'developer':
      return 'just decided'
  }
}

/** The list without the one decision that key names, in the order it was held. */
export function withoutCertificate(
  certificates: readonly TrustedCertificate[],
  { host, fingerprint }: CertificateKey
): TrustedCertificate[] {
  return certificates.filter(
    (candidate) => !(candidate.host === host && candidate.fingerprint === fingerprint)
  )
}

// ---------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------

/**
 * One global file, beside the projects directory rather than inside it: a certificate is
 * a property of a host and a machine, and two projects on one staging server are one
 * decision.
 */
export const CERTIFICATE_FILE_VERSION = 1

export interface CertificateFile {
  version: number
  certificates: TrustedCertificate[]
}

export type ReadCertificatesResult =
  | { ok: true; certificates: TrustedCertificate[] }
  | { ok: false; reason: RefusalReason; message: string }

export function writeCertificateFile(certificates: readonly TrustedCertificate[]): CertificateFile {
  return { version: CERTIFICATE_FILE_VERSION, certificates: [...certificates] }
}

export function readCertificateFile(raw: unknown): ReadCertificatesResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return corrupt('the file is not a JSON object')
  }
  const file = raw as Record<string, unknown>
  if (!Number.isInteger(file.version)) return corrupt('the file has no integer version')
  if ((file.version as number) > CERTIFICATE_FILE_VERSION) {
    return {
      ok: false,
      reason: 'newer',
      message: `written by a newer Breakpoint (file version ${String(file.version)}, this build reads ${CERTIFICATE_FILE_VERSION})`
    }
  }
  if (!Array.isArray(file.certificates)) return corrupt('the file holds no certificate list')

  const certificates: TrustedCertificate[] = []
  for (const [index, entry] of file.certificates.entries()) {
    const certificate = parseTrustedCertificate(entry)
    if (!certificate) return corrupt(`certificate ${index + 1} is not a stored decision`)
    // Two decisions under one key would make "is this certificate trusted" two answers.
    if (hasCertificate(certificates, certificate)) {
      return corrupt(
        `two decisions share the host ${certificate.host} and fingerprint ${certificate.fingerprint}`
      )
    }
    certificates.push(certificate)
  }
  return { ok: true, certificates }
}

function corrupt(message: string): ReadCertificatesResult {
  return { ok: false, reason: 'corrupt', message }
}

/** Every field checked, and only the known fields copied out. */
export function parseTrustedCertificate(value: unknown): TrustedCertificate | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const text = (name: string): string | undefined =>
    typeof raw[name] === 'string' && raw[name].length > 0 ? raw[name] : undefined

  const host = text('host')
  const fingerprint = text('fingerprint')
  const error = text('error')
  if (host === undefined || fingerprint === undefined || error === undefined) return undefined
  if (typeof raw.subject !== 'string' || typeof raw.issuer !== 'string') return undefined
  if (!Number.isFinite(raw.trustedAt)) return undefined
  if (
    raw.errors !== undefined &&
    (!Array.isArray(raw.errors) || raw.errors.some((error) => typeof error !== 'string' || !error))
  )
    return undefined

  return {
    host,
    fingerprint,
    subject: raw.subject,
    issuer: raw.issuer,
    error,
    ...(raw.errors === undefined ? {} : { errors: [...(raw.errors as string[])] }),
    trustedAt: raw.trustedAt as number
  }
}
