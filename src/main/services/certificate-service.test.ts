import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createAuthority, issueCertificate, type TestCertificate } from '../../../e2e/certificates'
import type { TrustedCertificate } from '../../shared/certificates'
import { EventLog, type Entry } from '../../shared/event-log'
import type { RevisionedPatch } from '../../shared/state'
import { RouteError } from '../route-error'
import { StateFeed } from '../state-feed'
import {
  certificateFacts,
  CertificateService,
  type CertificateRefusal
} from './certificate-service'
import type { LoadCertificatesResult } from './certificate-store'

/**
 * The certificates the tests use are generated here rather than committed, by the same
 * helper the Playwright fixture uses: an expired certificate cannot be committed, and a
 * private key in a repository is a private key in a repository. Reading a real PEM is
 * also the only honest way to test what Breakpoint reads out of one.
 */

const AUTHORITY = 'net::ERR_CERT_AUTHORITY_INVALID'

/**
 * The service's clock is frozen, but the certificates are generated against the real one,
 * so it is frozen to a moment they are actually valid at rather than to a round number.
 */
const NOW = Date.now()

class FakeStore {
  readonly file = '/tmp/certificates.json'
  saved: TrustedCertificate[][] = []
  loaded: LoadCertificatesResult = { status: 'missing' }

  load(): Promise<LoadCertificatesResult> {
    return Promise.resolve(this.loaded)
  }

  save(certificates: readonly TrustedCertificate[]): Promise<void> {
    this.saved.push([...certificates])
    return Promise.resolve()
  }
}

let store: FakeStore
let feed: StateFeed
let log: EventLog
let patches: RevisionedPatch[]
let service: CertificateService
let revokeConnections: ReturnType<typeof vi.fn<() => Promise<void>>>

function refusal(certificate: TestCertificate, url: string, error = AUTHORITY): CertificateRefusal {
  return {
    url,
    error,
    data: certificate.cert,
    fingerprint: certificate.fingerprint,
    subjectName: certificate.subject,
    issuerName: certificate.subject
  }
}

function entries(): Entry[] {
  return [...log.read().entries]
}

function types(): string[] {
  return entries().map((entry) => entry.type)
}

async function start(loaded: LoadCertificatesResult = { status: 'missing' }): Promise<void> {
  store.loaded = loaded
  await service.load()
  patches.length = 0
}

beforeEach(() => {
  store = new FakeStore()
  feed = new StateFeed()
  log = new EventLog()
  patches = []
  feed.subscribe((patch) => patches.push(patch))
  revokeConnections = vi.fn().mockResolvedValue(undefined)
  service = new CertificateService(store, feed, log, revokeConnections, () => NOW)
})

describe('what the certificate itself says', () => {
  test('a certificate naming the host it was served for, inside its dates', () => {
    const certificate = issueCertificate({
      commonName: 'localhost',
      dns: ['localhost'],
      ips: ['127.0.0.1']
    })
    const facts = certificateFacts(refusal(certificate, 'https://localhost:8443/'), 'localhost')
    expect(facts).toMatchObject({ namesHost: true, current: true, subject: 'localhost' })
  })

  test('an IP address matches the certificate that names it as an address', () => {
    const certificate = issueCertificate({
      commonName: 'localhost',
      dns: ['localhost'],
      ips: ['127.0.0.1']
    })
    const served = refusal(certificate, 'https://127.0.0.1:8443/')
    expect(certificateFacts(served, '127.0.0.1').namesHost).toBe(true)
    expect(certificateFacts(served, '127.0.0.2').namesHost).toBe(false)
  })

  test('an expired certificate is not current, whatever error Chromium reported', () => {
    const certificate = issueCertificate({
      commonName: 'localhost',
      validFromDays: -30,
      validToDays: -1
    })
    const facts = certificateFacts(refusal(certificate, 'https://localhost:8443/'), 'localhost')
    expect(facts).toMatchObject({ namesHost: true, current: false })
  })

  test('a certificate for another host does not name this one', () => {
    const certificate = issueCertificate({ commonName: 'other.example' })
    const facts = certificateFacts(refusal(certificate, 'https://localhost:8443/'), 'localhost')
    expect(facts).toMatchObject({ namesHost: false, current: true })
  })

  test('a certificate that cannot be parsed names nothing and is current about nothing', () => {
    const served = {
      ...refusal(issueCertificate({ commonName: 'x' }), 'https://x/'),
      data: 'not a PEM'
    }
    expect(certificateFacts(served, 'x')).toMatchObject({ namesHost: false, current: false })
  })
})

describe('loopback', () => {
  test('a self-signed certificate is trusted without asking or storing anything', async () => {
    await start()
    const certificate = issueCertificate({
      commonName: 'localhost',
      dns: ['localhost'],
      ips: ['127.0.0.1']
    })
    const respond = vi.fn()

    service.verify(refusal(certificate, 'https://localhost:8443/'), respond)

    expect(respond).toHaveBeenCalledExactlyOnceWith(true)
    expect(service.list()).toEqual({ trusted: [], waiting: [] })
    expect(store.saved).toEqual([])
    expect(entries()).toEqual([
      expect.objectContaining({
        type: 'certificate.trusted',
        host: 'localhost',
        fingerprint: certificate.fingerprint,
        reason: 'loopback'
      })
    ])
  })

  test('a certificate from an authority nobody knows is trusted the same way', async () => {
    await start()
    const authority = createAuthority()
    const certificate = issueCertificate({ commonName: 'localhost', authority })
    const respond = vi.fn()

    service.verify(refusal(certificate, 'https://localhost:8443/'), respond)

    expect(respond).toHaveBeenCalledExactlyOnceWith(true)
    expect(service.list().waiting).toEqual([])
  })

  test('an expired certificate prompts', async () => {
    await start()
    const certificate = issueCertificate({
      commonName: 'localhost',
      validFromDays: -30,
      validToDays: -1
    })
    const respond = vi.fn()

    service.verify(refusal(certificate, 'https://localhost:8443/'), respond)

    expect(respond).not.toHaveBeenCalled()
    expect(service.list().waiting).toEqual([
      expect.objectContaining({ host: 'localhost', fingerprint: certificate.fingerprint })
    ])
    expect(types()).toEqual(['certificate.prompted'])
  })

  test('a certificate for another host prompts', async () => {
    await start()
    const certificate = issueCertificate({ commonName: 'other.example' })
    const respond = vi.fn()

    service.verify(refusal(certificate, 'https://localhost:8443/'), respond)

    expect(respond).not.toHaveBeenCalled()
    expect(service.list().waiting).toHaveLength(1)
  })

  test('a failure other than an unreachable authority prompts', async () => {
    await start()
    const certificate = issueCertificate({ commonName: 'localhost' })
    const respond = vi.fn()

    service.verify(
      refusal(certificate, 'https://localhost:8443/', 'net::ERR_CERT_REVOKED'),
      respond
    )

    expect(respond).not.toHaveBeenCalled()
    expect(service.list().waiting).toHaveLength(1)
  })

  test('the same certificate met again does not write the entry twice', async () => {
    await start()
    const certificate = issueCertificate({ commonName: 'localhost' })
    service.verify(refusal(certificate, 'https://localhost:8443/'), vi.fn())
    service.verify(refusal(certificate, 'https://localhost:8443/other'), vi.fn())

    expect(types()).toEqual(['certificate.trusted'])
  })
})

describe('every other host', () => {
  const staging = (): TestCertificate => issueCertificate({ commonName: 'staging.example.com' })

  test('prompts once, and every pane held by it is released together', async () => {
    await start()
    const certificate = staging()
    const first = vi.fn()
    const second = vi.fn()

    service.verify(refusal(certificate, 'https://staging.example.com/'), first)
    service.verify(refusal(certificate, 'https://staging.example.com/'), second)

    // One question, however many panes met it.
    expect(service.list().waiting).toHaveLength(1)
    expect(types()).toEqual(['certificate.prompted'])

    const state = await service.decide({
      host: 'staging.example.com',
      fingerprint: certificate.fingerprint,
      trusted: true
    })

    expect(first).toHaveBeenCalledExactlyOnceWith(true)
    expect(second).toHaveBeenCalledExactlyOnceWith(true)
    expect(state.waiting).toEqual([])
    expect(state.trusted).toEqual([
      {
        host: 'staging.example.com',
        fingerprint: certificate.fingerprint,
        subject: 'staging.example.com',
        issuer: 'staging.example.com',
        error: AUTHORITY,
        errors: [AUTHORITY],
        trustedAt: NOW
      }
    ])
    expect(store.saved).toEqual([state.trusted])
    expect(types()).toEqual(['certificate.prompted', 'certificate.trusted'])
  })

  test('the decision answers the next time without asking', async () => {
    await start()
    const certificate = staging()
    service.verify(refusal(certificate, 'https://staging.example.com/'), vi.fn())
    await service.decide({
      host: 'staging.example.com',
      fingerprint: certificate.fingerprint,
      trusted: true
    })

    const respond = vi.fn()
    service.verify(refusal(certificate, 'https://staging.example.com/cart'), respond)

    expect(respond).toHaveBeenCalledExactlyOnceWith(true)
    expect(service.list().waiting).toEqual([])
  })

  test('a different certificate on a trusted host prompts again ([ADR-0012])', async () => {
    await start()
    const first = staging()
    service.verify(refusal(first, 'https://staging.example.com/'), vi.fn())
    await service.decide({
      host: 'staging.example.com',
      fingerprint: first.fingerprint,
      trusted: true
    })

    const second = staging()
    expect(second.fingerprint).not.toBe(first.fingerprint)
    const respond = vi.fn()
    service.verify(refusal(second, 'https://staging.example.com/'), respond)

    expect(respond).not.toHaveBeenCalled()
    expect(service.list().waiting).toEqual([
      expect.objectContaining({ fingerprint: second.fingerprint })
    ])
  })

  test('refusing releases the panes with nothing stored, so the next one asks again', async () => {
    await start()
    const certificate = staging()
    const respond = vi.fn()
    service.verify(refusal(certificate, 'https://staging.example.com/'), respond)

    const state = await service.decide({
      host: 'staging.example.com',
      fingerprint: certificate.fingerprint,
      trusted: false
    })

    expect(respond).toHaveBeenCalledExactlyOnceWith(false)
    expect(state).toEqual({ trusted: [], waiting: [] })
    expect(store.saved).toEqual([])
    expect(types()).toEqual(['certificate.prompted', 'certificate.refused'])

    feed.publish({ type: 'project.url', url: 'https://staging.example.com/' })
    const again = vi.fn()
    service.verify(refusal(certificate, 'https://staging.example.com/'), again)
    expect(again).not.toHaveBeenCalled()
    expect(service.list().waiting).toHaveLength(1)
  })

  test('a refusal answers the panes that had not got there yet, without asking again', async () => {
    await start()
    const certificate = staging()
    service.verify(refusal(certificate, 'https://staging.example.com/'), vi.fn())
    await service.decide({
      host: 'staging.example.com',
      fingerprint: certificate.fingerprint,
      trusted: false
    })

    // The pane that reached the certificate a moment later is the same question, not a
    // second one.
    const late = vi.fn()
    service.verify(refusal(certificate, 'https://staging.example.com/'), late)

    expect(late).toHaveBeenCalledExactlyOnceWith(false)
    expect(service.list().waiting).toEqual([])
    expect(types()).toEqual(['certificate.prompted', 'certificate.refused'])
  })

  test('navigating there again asks again: the refusal was never stored', async () => {
    await start()
    const certificate = staging()
    service.verify(refusal(certificate, 'https://staging.example.com/'), vi.fn())
    await service.decide({
      host: 'staging.example.com',
      fingerprint: certificate.fingerprint,
      trusted: false
    })

    feed.publish({ type: 'project.url', url: 'https://staging.example.com/' })
    const respond = vi.fn()
    service.verify(refusal(certificate, 'https://staging.example.com/'), respond)

    expect(respond).not.toHaveBeenCalled()
    expect(service.list().waiting).toHaveLength(1)
  })

  test('deciding for something nothing is waiting on is refused', async () => {
    await start()
    await expect(
      service.decide({ host: 'staging.example.com', fingerprint: 'sha256/nope', trusted: true })
    ).rejects.toMatchObject({ code: 'CERTIFICATE_NOT_FOUND' })
  })
})

describe('settings', () => {
  const stored: TrustedCertificate = {
    host: 'staging.example.com',
    fingerprint: 'sha256/AAAA',
    subject: 'staging.example.com',
    issuer: 'Acme Dev CA',
    error: AUTHORITY,
    trustedAt: 1
  }

  test('decisions survive a restart', async () => {
    await start({ status: 'loaded', certificates: [stored] })
    expect(service.list()).toEqual({ trusted: [stored], waiting: [] })
  })

  test('forgetting one makes that certificate prompt again', async () => {
    await start({ status: 'loaded', certificates: [stored] })

    const state = await service.forget({ host: stored.host, fingerprint: stored.fingerprint })

    expect(state).toEqual({ trusted: [], waiting: [] })
    expect(store.saved).toEqual([[]])
    expect(types()).toEqual(['certificate.forgotten'])
    expect(revokeConnections).toHaveBeenCalledExactlyOnceWith({
      host: stored.host,
      fingerprint: stored.fingerprint
    })
  })

  test('does not report success or delete the decision when connection closure fails', async () => {
    await start({ status: 'loaded', certificates: [stored] })
    revokeConnections.mockRejectedValueOnce(new Error('could not close connections'))
    await expect(service.forget(stored)).rejects.toThrow('could not close connections')
    expect(service.list().trusted).toEqual([stored])
    expect(store.saved).toEqual([])
    expect(types()).toEqual([])
    await expect(service.forget(stored)).resolves.toEqual({ trusted: [], waiting: [] })
  })

  test('does not reaccept a certificate while its live connections are being revoked', async () => {
    const certificate = issueCertificate({ commonName: stored.host })
    const decision = { ...stored, fingerprint: certificate.fingerprint }
    await start({ status: 'loaded', certificates: [decision] })
    let finish!: () => void
    revokeConnections.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const forgotten = service.forget(decision)
    await Promise.resolve()
    const respond = vi.fn()
    service.verify(refusal(certificate, `https://${stored.host}/`), respond)
    expect(respond).not.toHaveBeenCalled()
    expect(service.list().waiting).toHaveLength(1)
    expect(store.saved).toEqual([])
    finish()
    await forgotten
    expect(service.list().trusted).toEqual([])
    expect(respond).not.toHaveBeenCalled()
  })

  test('forgetting something that is not stored is refused', async () => {
    await start({ status: 'loaded', certificates: [stored] })
    await expect(
      service.forget({ host: stored.host, fingerprint: 'sha256/BBBB' })
    ).rejects.toMatchObject({ code: 'CERTIFICATE_NOT_FOUND' })
  })

  test('every change is announced once, carrying both lists', async () => {
    await start()
    const certificate = issueCertificate({ commonName: 'staging.example.com' })
    service.verify(refusal(certificate, 'https://staging.example.com/'), vi.fn())
    await service.decide({
      host: 'staging.example.com',
      fingerprint: certificate.fingerprint,
      trusted: true
    })

    expect(patches.map(({ patch }) => patch.type)).toEqual([
      'certificates.changed',
      'certificates.changed'
    ])
    expect(patches.at(-1)!.patch).toEqual({
      type: 'certificates.changed',
      certificates: service.list()
    })
  })
})

describe('canceled loads', () => {
  test('removes only the canceled waiter, and retires the question with the last one', async () => {
    await start()
    const certificate = issueCertificate({ commonName: 'staging.example.com' })
    const served = refusal(certificate, 'https://staging.example.com/')
    const first = vi.fn()
    const second = vi.fn()
    const cancelFirst = service.verify(served, first)!
    const cancelSecond = service.verify(served, second)!
    cancelFirst()
    expect(first).toHaveBeenCalledExactlyOnceWith(false)
    expect(second).not.toHaveBeenCalled()
    expect(service.list().waiting).toHaveLength(1)
    cancelSecond()
    cancelFirst()
    cancelSecond()
    expect(second).toHaveBeenCalledExactlyOnceWith(false)
    expect(service.list()).toEqual({ trusted: [], waiting: [] })
    expect(types()).toEqual(['certificate.prompted'])
    expect(patches.at(-1)?.patch).toEqual({
      type: 'certificates.changed',
      certificates: { trusted: [], waiting: [] }
    })
    // Cancellation is not refusal: returning deliberately asks again.
    expect(service.verify(served, vi.fn())).toBeTypeOf('function')
    expect(service.list().waiting).toHaveLength(1)
  })

  test('trust releases the remaining waiter without answering the canceled load twice', async () => {
    await start()
    const certificate = issueCertificate({ commonName: 'staging.example.com' })
    const served = refusal(certificate, 'https://staging.example.com/')
    const first = vi.fn()
    const second = vi.fn()
    service.verify(served, first)!()
    const cancel = service.verify(served, second)!
    await service.decide({
      host: 'staging.example.com',
      fingerprint: certificate.fingerprint,
      trusted: true
    })
    cancel()
    expect(first).toHaveBeenCalledExactlyOnceWith(false)
    expect(second).toHaveBeenCalledExactlyOnceWith(true)
    expect(service.list().waiting).toEqual([])
  })

  test('a replacement arriving during persistence is released by consent for the same key', async () => {
    await start()
    const certificate = issueCertificate({ commonName: 'staging.example.com' })
    const served = refusal(certificate, 'https://staging.example.com/')
    const first = vi.fn()
    const cancel = service.verify(served, first)!
    let finish!: () => void
    vi.spyOn(store, 'save').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const deciding = service.decide({
      host: 'staging.example.com',
      fingerprint: certificate.fingerprint,
      trusted: true
    })
    await Promise.resolve()
    cancel()
    const replacement = vi.fn()
    service.verify(served, replacement)
    finish()
    await deciding
    expect(first).toHaveBeenCalledExactlyOnceWith(false)
    expect(replacement).toHaveBeenCalledExactlyOnceWith(true)
    expect(service.list().waiting).toEqual([])
  })
})

describe('a file this build will not read', () => {
  const refused: LoadCertificatesResult = {
    status: 'refused',
    reason: 'corrupt',
    message: 'the file is not JSON'
  }

  test('leaves every certificate prompting rather than pretending nothing was trusted', async () => {
    await start(refused)
    const certificate = issueCertificate({ commonName: 'staging.example.com' })
    const respond = vi.fn()

    service.verify(refusal(certificate, 'https://staging.example.com/'), respond)

    expect(respond).not.toHaveBeenCalled()
    expect(service.list().waiting).toHaveLength(1)
  })

  test('refuses to store a decision over it, and says where the file is', async () => {
    await start(refused)
    const certificate = issueCertificate({ commonName: 'staging.example.com' })
    service.verify(refusal(certificate, 'https://staging.example.com/'), vi.fn())

    const failure = await service
      .decide({
        host: 'staging.example.com',
        fingerprint: certificate.fingerprint,
        trusted: true
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(RouteError)
    expect(failure).toMatchObject({ code: 'CERTIFICATES_UNREADABLE' })
    expect(String((failure as RouteError).message)).toContain(store.file)
    expect(store.saved).toEqual([])
    // A decision that could not be kept is not made, so the question is still there and
    // the panes are still held: the developer sees the refusal and can still say no.
    expect(service.list().waiting).toHaveLength(1)
  })

  test('still lets a certificate be refused, which stores nothing', async () => {
    await start(refused)
    const certificate = issueCertificate({ commonName: 'staging.example.com' })
    const respond = vi.fn()
    service.verify(refusal(certificate, 'https://staging.example.com/'), respond)

    await service.decide({
      host: 'staging.example.com',
      fingerprint: certificate.fingerprint,
      trusted: false
    })

    expect(respond).toHaveBeenCalledExactlyOnceWith(false)
  })
})
