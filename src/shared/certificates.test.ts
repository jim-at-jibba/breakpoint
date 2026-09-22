import { describe, expect, test } from 'vitest'
import {
  CERTIFICATE_FILE_VERSION,
  certificateVerdict,
  readCertificateFile,
  withoutCertificate,
  writeCertificateFile,
  type CertificateFacts,
  type TrustedCertificate
} from './certificates'

const facts = (changes: Partial<CertificateFacts> = {}): CertificateFacts => ({
  fingerprint: 'sha256/AAAA',
  subject: 'localhost',
  issuer: 'localhost',
  namesHost: true,
  current: true,
  ...changes
})

const trusted = (changes: Partial<TrustedCertificate> = {}): TrustedCertificate => ({
  host: 'staging.example.com',
  fingerprint: 'sha256/AAAA',
  subject: 'staging.example.com',
  issuer: 'Acme Dev CA',
  error: 'net::ERR_CERT_AUTHORITY_INVALID',
  trustedAt: 1_763_731_200_000,
  ...changes
})

const AUTHORITY = 'net::ERR_CERT_AUTHORITY_INVALID'

describe('certificateVerdict', () => {
  test('a certificate with no chain of trust on loopback is trusted without asking', () => {
    for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '[::1]', 'shop.localhost']) {
      expect(certificateVerdict({ host, error: AUTHORITY, facts: facts(), trusted: [] })).toBe(
        'loopback'
      )
    }
  })

  test('an expired certificate on loopback still prompts', () => {
    const verdict = certificateVerdict({
      host: 'localhost',
      error: AUTHORITY,
      facts: facts({ current: false }),
      trusted: []
    })
    expect(verdict).toBe('prompt')
  })

  test('a certificate that does not name the loopback host it was served for prompts', () => {
    const verdict = certificateVerdict({
      host: 'localhost',
      error: AUTHORITY,
      facts: facts({ namesHost: false }),
      trusted: []
    })
    expect(verdict).toBe('prompt')
  })

  test('a failure other than an unreachable authority prompts, loopback or not', () => {
    for (const error of ['net::ERR_CERT_REVOKED', 'net::ERR_CERT_WEAK_KEY']) {
      expect(certificateVerdict({ host: 'localhost', error, facts: facts(), trusted: [] })).toBe(
        'prompt'
      )
    }
  })

  test('a certificate on any other host prompts, however ordinary its failure', () => {
    const verdict = certificateVerdict({
      host: 'staging.example.com',
      error: AUTHORITY,
      facts: facts(),
      trusted: []
    })
    expect(verdict).toBe('prompt')
  })

  test('a stored decision for that host and fingerprint answers without asking again', () => {
    const verdict = certificateVerdict({
      host: 'staging.example.com',
      error: AUTHORITY,
      facts: facts(),
      trusted: [trusted()]
    })
    expect(verdict).toBe('stored')
  })

  test('a different certificate on a trusted host prompts again ([ADR-0012])', () => {
    const verdict = certificateVerdict({
      host: 'staging.example.com',
      error: AUTHORITY,
      facts: facts({ fingerprint: 'sha256/BBBB' }),
      trusted: [trusted()]
    })
    expect(verdict).toBe('prompt')
  })

  test('the same certificate on a different host prompts: the key is both', () => {
    const verdict = certificateVerdict({
      host: 'other.example.com',
      error: AUTHORITY,
      facts: facts(),
      trusted: [trusted()]
    })
    expect(verdict).toBe('prompt')
  })

  test('a stored decision outranks the loopback rule, so the error it was trusted through is irrelevant', () => {
    const verdict = certificateVerdict({
      host: 'localhost',
      error: 'net::ERR_CERT_DATE_INVALID',
      facts: facts({ current: false }),
      trusted: [trusted({ host: 'localhost', error: 'net::ERR_CERT_DATE_INVALID' })]
    })
    expect(verdict).toBe('stored')
  })
})

describe('withoutCertificate', () => {
  test('drops the one entry keyed on that host and fingerprint', () => {
    const other = trusted({ fingerprint: 'sha256/BBBB' })
    expect(
      withoutCertificate([trusted(), other], {
        host: 'staging.example.com',
        fingerprint: 'sha256/AAAA'
      })
    ).toEqual([other])
  })

  test('leaves a list that does not hold it exactly as it was', () => {
    const list = [trusted()]
    expect(
      withoutCertificate(list, { host: 'staging.example.com', fingerprint: 'sha256/BBBB' })
    ).toEqual(list)
  })
})

describe('the certificates file', () => {
  test('round-trips what was stored', () => {
    const file = writeCertificateFile([trusted()])
    expect(file.version).toBe(CERTIFICATE_FILE_VERSION)
    expect(readCertificateFile(file)).toEqual({ ok: true, certificates: [trusted()] })
  })

  test('an empty file is a file with no decisions in it', () => {
    expect(readCertificateFile({ version: 1, certificates: [] })).toEqual({
      ok: true,
      certificates: []
    })
  })

  test('a file from a newer build is refused rather than guessed at', () => {
    const read = readCertificateFile({ version: CERTIFICATE_FILE_VERSION + 1, certificates: [] })
    expect(read).toMatchObject({ ok: false, reason: 'newer' })
  })

  test('anything that is not a certificate list is corrupt', () => {
    for (const raw of [null, 'certificates', { version: 1 }, { certificates: [] }]) {
      expect(readCertificateFile(raw)).toMatchObject({ ok: false, reason: 'corrupt' })
    }
  })

  test('an entry missing a field is corrupt, and named so it can be found', () => {
    const read = readCertificateFile({
      version: 1,
      certificates: [{ ...trusted(), fingerprint: undefined }]
    })
    expect(read).toMatchObject({ ok: false, reason: 'corrupt' })
  })

  test('two decisions under one host and fingerprint is corrupt: the key names one', () => {
    const read = readCertificateFile({ version: 1, certificates: [trusted(), trusted()] })
    expect(read).toMatchObject({ ok: false, reason: 'corrupt' })
  })

  test('only the known fields are copied out, so the file cannot smuggle any in', () => {
    const read = readCertificateFile({
      version: 1,
      certificates: [{ ...trusted(), smuggled: true }]
    })
    expect(read).toEqual({ ok: true, certificates: [trusted()] })
  })
})
