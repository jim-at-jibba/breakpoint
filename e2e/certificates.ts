import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { asn1, md, pki } from 'node-forge'

/**
 * Certificates for the tests, generated when they run.
 *
 * Nothing here is committed: a certificate in the repository is a private key in the
 * repository, it expires while nobody is looking, and the expired and mismatched cases
 * this ticket needs cannot be committed at all — an expired certificate is expired the
 * day it is written, so the fixture has to be able to say "thirty days ago".
 *
 * One RSA key pair is generated for every certificate here, through Node's own
 * `generateKeyPairSync` rather than forge's: key generation is the slow part, the tests
 * are not testing key generation, and two certificates sharing a key still have
 * different fingerprints because a fingerprint is over the whole certificate.
 *
 * Imported by the Playwright fixture and by the main process's own unit tests, which
 * need the same PEMs to check what Breakpoint reads out of a certificate.
 */

export interface TestCertificate {
  /** PEM, as `tls.createServer` wants it. */
  cert: string
  /** PEM, PKCS#1. */
  key: string
  /** `sha256/<base64>` over the DER: how Electron spells a fingerprint, and how
   * Breakpoint keys trust ([ADR-0012]). */
  fingerprint: string
  /** The certificate's subject common name, as Breakpoint shows it in settings. */
  subject: string
}

export interface CertificateAuthority {
  certificate: TestCertificate
  /** Everything needed to sign a leaf with it. */
  readonly issuer: pki.CertificateField[]
  readonly key: pki.rsa.PrivateKey
}

export interface IssueOptions {
  commonName: string
  /** DNS names in the subject alternative name, defaulting to the common name. */
  dns?: readonly string[]
  /** IP addresses in the subject alternative name. */
  ips?: readonly string[]
  /** Days from now the certificate starts being valid. Negative is in the past. */
  validFromDays?: number
  /** Days from now it stops. Negative makes an expired certificate. */
  validToDays?: number
  /** Sign with this authority rather than with the certificate's own key. */
  authority?: CertificateAuthority
  /** Distinguishes two certificates for the same host. Hex, whole bytes, and with a
   * first byte inside `01`–`7f`: DER integers are signed and refuse a redundant zero. */
  serial?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

let serialCounter = 0

/**
 * A serial DER will accept: whole bytes, no redundant leading zero, and the top bit of
 * the first byte clear so it is not read as a negative integer.
 */
function nextSerial(): string {
  serialCounter += 1
  const first = (serialCounter % 0x7f) + 1
  return `${first.toString(16).padStart(2, '0')}${randomBytes(3).toString('hex')}`
}

interface KeyPair {
  publicKey: pki.rsa.PublicKey
  privateKey: pki.rsa.PrivateKey
  keyPem: string
}

function keyPair(): KeyPair {
  const generated = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  return {
    publicKey: pki.publicKeyFromPem(generated.publicKey),
    privateKey: pki.privateKeyFromPem(generated.privateKey),
    keyPem: generated.privateKey
  }
}

function attributes(commonName: string): pki.CertificateField[] {
  return [{ name: 'commonName', value: commonName }]
}

function fingerprintOf(certificate: pki.Certificate): string {
  const der = Buffer.from(asn1.toDer(pki.certificateToAsn1(certificate)).getBytes(), 'binary')
  return `sha256/${createHash('sha256').update(der).digest('base64')}`
}

/** A private authority: real enough to sign with, and in nobody's trust store. */
export function createAuthority(commonName = 'Breakpoint Test CA'): CertificateAuthority {
  const { publicKey, privateKey, keyPem } = keyPair()
  const certificate = pki.createCertificate()
  certificate.publicKey = publicKey
  certificate.serialNumber = nextSerial()
  certificate.validity.notBefore = new Date(Date.now() - DAY_MS)
  certificate.validity.notAfter = new Date(Date.now() + 365 * DAY_MS)
  const issuer = attributes(commonName)
  certificate.setSubject(issuer)
  certificate.setIssuer(issuer)
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true }
  ])
  certificate.sign(privateKey, md.sha256.create())

  return {
    certificate: {
      cert: pki.certificateToPem(certificate),
      key: keyPem,
      fingerprint: fingerprintOf(certificate),
      subject: commonName
    },
    issuer,
    key: privateKey
  }
}

export function issueCertificate({
  commonName,
  dns,
  ips = [],
  validFromDays = -1,
  validToDays = 365,
  authority,
  serial
}: IssueOptions): TestCertificate {
  const { publicKey, privateKey, keyPem } = keyPair()
  const certificate = pki.createCertificate()
  certificate.publicKey = publicKey
  certificate.serialNumber = serial ?? nextSerial()
  certificate.validity.notBefore = new Date(Date.now() + validFromDays * DAY_MS)
  certificate.validity.notAfter = new Date(Date.now() + validToDays * DAY_MS)
  certificate.setSubject(attributes(commonName))
  certificate.setIssuer(authority?.issuer ?? attributes(commonName))
  certificate.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        // Type 2 is a DNS name and type 7 an IP address, as the RFC numbers them.
        ...(dns ?? [commonName]).map((value) => ({ type: 2, value })),
        ...ips.map((ip) => ({ type: 7, ip }))
      ]
    }
  ])
  certificate.sign(authority?.key ?? privateKey, md.sha256.create())

  return {
    cert: pki.certificateToPem(certificate),
    key: keyPem,
    fingerprint: fingerprintOf(certificate),
    subject: commonName
  }
}
