import { X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import {
  certificateVerdict,
  certificateKey,
  hasCertificate,
  withoutCertificate,
  type CertificateFacts,
  type CertificateKey,
  type CertificateRequest,
  type CertificateState,
  type CertificateTrustReason,
  type TrustedCertificate
} from '../../shared/certificates'
import type { EventLog } from '../../shared/event-log'
import type { CertificateDecision } from '../../shared/routes'
import { RouteError } from '../route-error'
import type { StateFeed } from '../state-feed'
import type { CertificateStore } from './certificate-store'

/**
 * Certificate trust: the one place that answers Chromium when it will not verify the
 * certificate behind a pane's page.
 *
 * A dev server on this machine is answered for the developer and never stored — that is
 * a rule about loopback, not a decision anyone made. Every other host is asked about
 * once, and the answer is kept against the host **and** the certificate's fingerprint
 * ([ADR-0012]), so a changed certificate asks again.
 *
 * Chromium reports only the first of a certificate's faults, and reports an unreachable
 * authority ahead of an expired certificate or a mismatched name, so the error string
 * alone cannot tell a dev certificate from something else wearing one. The certificate
 * itself is read for the two things loopback's rule turns on: whether it names the host
 * it was served for, and whether it is inside its dates.
 *
 * A refusal is remembered in memory, and only in memory. Panes do not all reach the
 * certificate at the same instant, so answering "no" for the pane that got there first
 * and then asking again for each of the others is the same question three times. The
 * refusal stands until the developer deliberately goes there again — any navigation
 * clears it — or until the app restarts.
 *
 * Holds no Electron object: the callbacks it keeps are plain functions the main entry
 * hands over, which is what lets the whole lifecycle be tested without a browser.
 */

/** One refusal, as Electron's `certificate-error` describes it. */
export interface CertificateRefusal {
  /** The URL whose load Chromium refused. Its host is what trust is keyed on. */
  url: string
  /** Chromium's net error, such as `net::ERR_CERT_AUTHORITY_INVALID`. */
  error: string
  /** The certificate as PEM, from Electron's `Certificate.data`. */
  data: string
  /** Electron's own `sha256/<base64>` fingerprint, which is the key. */
  fingerprint: string
  subjectName: string
  issuerName: string
}

export type CertificateResponse = (trusted: boolean) => void

interface Waiting {
  request: CertificateRequest
  /** Every load held by this certificate. Three panes meeting it is one question. */
  responses: Set<CertificateResponse>
}

/**
 * What Breakpoint reads out of the certificate itself. A PEM that will not parse names
 * nothing and is current about nothing, which is the safe answer both times: it prompts.
 */
export function certificateFacts(
  { data, fingerprint, subjectName, issuerName }: CertificateRefusal,
  host: string,
  now: number = Date.now()
): CertificateFacts {
  const base = { fingerprint, subject: subjectName, issuer: issuerName }
  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(data)
  } catch {
    return { ...base, namesHost: false, current: false, errors: ['net::ERR_CERT_INVALID'] }
  }
  const matches = namesHost(certificate, host)
  const current =
    now >= certificate.validFromDate.getTime() && now <= certificate.validToDate.getTime()
  return {
    ...base,
    namesHost: matches,
    current,
    errors: [
      ...(!matches ? ['net::ERR_CERT_COMMON_NAME_INVALID'] : []),
      ...(!current ? ['net::ERR_CERT_DATE_INVALID'] : [])
    ]
  }
}

/** An IPv6 host arrives inside its brackets, and an address is matched as an address. */
function namesHost(certificate: X509Certificate, host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '')
  if (isIP(name) !== 0) return certificate.checkIP(name) !== undefined
  return certificate.checkHost(name) !== undefined
}

export class CertificateService {
  private certificates: TrustedCertificate[] = []
  /** Keyed by host and fingerprint, which is the key a decision is keyed on. */
  private readonly waiting = new Map<string, Waiting>()
  /** Keys already written to the log this run, so a reload does not repeat the entry. */
  private readonly announced = new Set<string>()
  /** Keys the developer said no to, until the next navigation asks the question again. */
  private readonly declined = new Set<string>()
  /** Why the stored decisions could not be read, if they could not be. */
  private unreadable: string | undefined
  private queue: Promise<void> = Promise.resolve()
  private readonly revoking = new Set<string>()

  constructor(
    private readonly store: CertificateStore,
    private readonly feed: StateFeed,
    private readonly log: EventLog,
    private readonly revokeConnections: (key: CertificateKey) => Promise<void>,
    private readonly now: () => number = () => Date.now()
  ) {
    feed.subscribe(({ patch }) => {
      // Going somewhere, or opening a project, is asking again.
      if (patch.type === 'project.url' || patch.type === 'project.opened') this.declined.clear()
    })
  }

  /**
   * Reads the stored decisions once, at startup. A file this build will not read leaves
   * every certificate prompting and every decision unstorable, rather than reporting an
   * empty list the next save would make true.
   */
  async load(): Promise<void> {
    const loaded = await this.store.load()
    if (loaded.status === 'refused') {
      this.unreadable = `${this.store.file}: ${loaded.message}`
      return
    }
    this.certificates = loaded.status === 'loaded' ? loaded.certificates : []
  }

  list(): CertificateState {
    return {
      trusted: [...this.certificates],
      waiting: [...this.waiting.values()].map(({ request }) => request)
    }
  }

  /**
   * Answers one refusal, or holds it until the developer does. `respond` is Chromium's
   * callback: called once with `true` to accept the certificate for this connection and
   * `false` to let the load fail. A held load returns its cancellation function: the
   * Electron owner calls it when that load is superseded, stopped, or destroyed.
   */
  verify(refusal: CertificateRefusal, respond: CertificateResponse): (() => void) | undefined {
    const host = hostOf(refusal.url)
    const facts = certificateFacts(refusal, host, this.now())
    const key = certificateKey({ host, fingerprint: facts.fingerprint })

    if (this.declined.has(key)) {
      answer(respond, false)
      return
    }

    const verdict = certificateVerdict({
      host,
      error: refusal.error,
      facts,
      trusted: this.revoking.has(key) ? [] : this.certificates
    })
    if (verdict !== 'prompt') {
      this.trust({ host, fingerprint: facts.fingerprint }, refusal.error, verdict)
      answer(respond, true)
      return
    }

    const held = this.waiting.get(key)
    if (held) {
      held.responses.add(respond)
      return () => this.cancel(key, held, respond)
    }
    const request: CertificateRequest = {
      host,
      fingerprint: facts.fingerprint,
      subject: facts.subject,
      issuer: facts.issuer,
      error: refusal.error,
      errors: [...new Set([refusal.error, ...facts.errors])],
      url: refusal.url,
      askedAt: this.now()
    }
    const waiting = { request, responses: new Set([respond]) }
    this.waiting.set(key, waiting)
    this.log.append(null, {
      type: 'certificate.prompted',
      host,
      fingerprint: facts.fingerprint,
      error: refusal.error,
      url: refusal.url
    })
    this.announce()
    return () => this.cancel(key, waiting, respond)
  }

  private cancel(key: string, held: Waiting, respond: CertificateResponse): void {
    if (this.waiting.get(key) !== held || !held.responses.delete(respond)) return
    if (held.responses.size === 0) {
      this.waiting.delete(key)
      this.announce()
    }
    answer(respond, false)
  }

  /** Answers a waiting certificate. Queued, so two surfaces answering at once agree. */
  decide(decision: CertificateDecision): Promise<CertificateState> {
    return this.enqueue(() => this.answer(decision))
  }

  /** Drops a stored decision, so that certificate on that host prompts again. */
  forget(key: CertificateKey): Promise<CertificateState> {
    return this.enqueue(() => this.drop(key))
  }

  private async answer({
    host,
    fingerprint,
    trusted
  }: CertificateDecision): Promise<CertificateState> {
    const key = certificateKey({ host, fingerprint })
    const held = this.waiting.get(key)
    if (!held) {
      throw new RouteError(
        'CERTIFICATE_NOT_FOUND',
        `no certificate is waiting on ${host} with fingerprint ${fingerprint}`,
        { host, fingerprint }
      )
    }
    // Refusing stores nothing, so it is the one answer a file we could not read still
    // allows: the loads are released and nothing is written over the developer's record.
    if (trusted) this.requireReadable()

    if (trusted && !hasCertificate(this.certificates, { host, fingerprint })) {
      const { request } = held
      const certificate: TrustedCertificate = {
        host,
        fingerprint,
        subject: request.subject,
        issuer: request.issuer,
        error: request.error,
        errors: request.errors,
        trustedAt: this.now()
      }
      // Saved first: a decision that could not be kept is not one the developer made.
      await this.store.save([...this.certificates, certificate])
      this.certificates = [...this.certificates, certificate]
    }

    // Loads can be canceled and replaced while the save is in flight. The consent is
    // still for this exact key, so release its current waiters, never the canceled ones.
    const active = this.waiting.get(key)
    this.waiting.delete(key)
    if (trusted) {
      this.declined.delete(key)
      this.trust({ host, fingerprint }, held.request.error, 'developer')
    } else {
      this.declined.add(key)
      this.log.append(null, {
        type: 'certificate.refused',
        host,
        fingerprint,
        error: held.request.error
      })
    }
    for (const respond of active?.responses ?? []) answer(respond, trusted)
    this.announce()
    return this.list()
  }

  private async drop({ host, fingerprint }: CertificateKey): Promise<CertificateState> {
    this.requireReadable()
    if (!hasCertificate(this.certificates, { host, fingerprint })) {
      throw new RouteError(
        'CERTIFICATE_NOT_FOUND',
        `no decision is stored for ${host} with fingerprint ${fingerprint}`,
        { host, fingerprint }
      )
    }
    const remaining = withoutCertificate(this.certificates, { host, fingerprint })
    const key = certificateKey({ host, fingerprint })
    this.revoking.add(key)
    try {
      // Closing a connection may make a page immediately request another. While this
      // is in flight, verify must not silently accept the key we are withdrawing.
      await this.revokeConnections({ host, fingerprint })
      await this.store.save(remaining)
    } finally {
      this.revoking.delete(key)
    }
    this.certificates = remaining
    // Announced again, so trusting the replacement writes a second entry rather than
    // being swallowed as one already seen.
    this.announced.delete(key)
    this.log.append(null, { type: 'certificate.forgotten', host, fingerprint })
    this.announce()
    return this.list()
  }

  /**
   * Records that a certificate was accepted, once per host and fingerprint per run: the
   * same page reloaded meets the same certificate again, and an entry each time would
   * bury the decision that mattered.
   */
  private trust(
    { host, fingerprint }: CertificateKey,
    error: string,
    reason: CertificateTrustReason
  ): void {
    const key = certificateKey({ host, fingerprint })
    if (this.announced.has(key)) return
    this.announced.add(key)
    this.log.append(null, { type: 'certificate.trusted', host, fingerprint, error, reason })
  }

  private requireReadable(): void {
    if (this.unreadable === undefined) return
    throw new RouteError('CERTIFICATES_UNREADABLE', this.unreadable, { file: this.store.file })
  }

  private announce(): void {
    this.feed.publish({ type: 'certificates.changed', certificates: this.list() })
  }

  /** One at a time, in the order asked for, so a save can never land on a stale list. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const done = this.queue.then(work)
    this.queue = done.then(
      () => undefined,
      () => undefined
    )
    return done
  }
}

/**
 * Chromium's callback, called once. A guest that went away while the question was open
 * is not a reason to leave every other pane held by the same certificate waiting, and on
 * the paths that answer straight away it is not a reason to throw back into Electron's
 * event handler either — so every answer goes through here.
 */
function answer(respond: CertificateResponse, trusted: boolean): void {
  try {
    respond(trusted)
  } catch {
    // The load it belonged to is already gone.
  }
}

/**
 * The host the certificate was served for. A URL Chromium refused always parses; the
 * fallback is there so a surprising one is keyed on something rather than throwing
 * inside a callback nothing is waiting to catch.
 */
function hostOf(url: string): string {
  return URL.parse(url)?.hostname ?? url
}
