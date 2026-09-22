import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { CertificateState } from '../src/shared/certificates'
import type { Entry, LogRead } from '../src/shared/event-log'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type Project
} from '../src/shared/project'
import type { StateSnapshot } from '../src/shared/state'
import { createAuthority, issueCertificate, type TestCertificate } from './certificates'
import { startSecureFixture, type SecureFixture } from './fixture'
import { closeApp, launchApp, runCli, Sandbox, type LaunchedApp } from './harness'

/**
 * Self-signed certificates: what loopback answers for itself, what gets asked about, and
 * what a decision is keyed on ([ADR-0012]).
 *
 * Every certificate here is generated when the test runs. The host that is not this
 * machine is `staging.test`, pointed at the fixture with Chromium's own
 * `--host-resolver-rules`: the rule under test is about the host in the URL, and the only
 * thing a real remote host would add is a network.
 */

const REMOTE_HOST = 'staging.test'
const RESOLVE_REMOTE = `--host-resolver-rules=MAP ${REMOTE_HOST} 127.0.0.1`
const LOOPBACK_NAMES = { dns: ['localhost'], ips: ['127.0.0.1', '::1'] }

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repos: string
let servers: SecureFixture[]

async function serve(certificate: TestCertificate, host = 'localhost'): Promise<SecureFixture> {
  const fixture = await startSecureFixture({ host, certificate })
  servers.push(fixture)
  return fixture
}

function makeRepo(name: string, startUrl: string): Project {
  const path = join(repos, name)
  mkdirSync(path, { recursive: true })
  const project: Project = {
    ...createProject(realpathSync.native(path)),
    startUrl,
    allowedOrigins: [new URL(startUrl).origin],
    zoom: 100
  }
  const projects = join(sandbox.userDataDir, 'projects')
  mkdirSync(projects, { recursive: true })
  writeFileSync(
    join(projects, projectFileName(project.repoPath)),
    JSON.stringify(writeProjectFile(project))
  )
  return project
}

async function open(project: Project): Promise<void> {
  const run = await runCli(sandbox, ['.', '--json'], project.repoPath)
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
}

async function state(): Promise<StateSnapshot> {
  const run = await runCli(sandbox, ['state', '--json'])
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as StateSnapshot
}

async function certificates(): Promise<CertificateState> {
  return (await state()).certificates
}

async function logs(since = 0): Promise<Entry[]> {
  const run = await runCli(sandbox, ['logs', '--since', String(since), '--json'])
  expect(run.code).toBe(0)
  return [...(JSON.parse(run.stdout) as LogRead).entries]
}

/** Every pane of the project finished loading `url`, which is what "loads" means here. */
async function expectPanesLoaded(project: Project, url: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const entries = await logs()
        return project.panes.every((pane) =>
          entries.some(
            (entry) => entry.type === 'pane.loaded' && entry.pane === pane.id && entry.url === url
          )
        )
      },
      { timeout: 25_000 }
    )
    .toBe(true)
}

/** The one question, with every pane held behind it. */
async function expectPrompt(host: string, fingerprint: string): Promise<void> {
  await expect
    .poll(async () => (await certificates()).waiting, { timeout: 25_000 })
    .toEqual([expect.objectContaining({ host, fingerprint })])

  const page = await launched!.app.firstWindow()
  const prompt = page.getByTestId('certificate-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt).toHaveAttribute('data-host', host)
  await expect(prompt).toHaveAttribute('data-fingerprint', fingerprint)

  // Held, not failed: nothing loaded, and nothing was told it could not load either.
  const entries = await logs()
  expect(entries.filter((entry) => entry.type === 'pane.loaded')).toEqual([])
}

test.beforeEach(() => {
  sandbox = new Sandbox()
  launched = undefined
  servers = []
  repos = mkdtempSync(join(tmpdir(), 'bp-repos-'))
})

test.afterEach(async () => {
  if (launched) await closeApp(launched)
  for (const server of servers) await server.close()
  sandbox.dispose()
  rmSync(repos, { recursive: true, force: true })
})

test('a self-signed certificate on loopback loads with no prompt', async () => {
  const fixture = await serve(issueCertificate({ commonName: 'localhost', ...LOOPBACK_NAMES }))
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop', `${fixture.origin}/`)
  await open(shop)

  await expectPanesLoaded(shop, `${fixture.origin}/`)

  // Never asked, and never stored: loopback is a rule, not a decision anyone made.
  expect(await certificates()).toEqual({ trusted: [], waiting: [] })
  expect((await logs()).filter((entry) => entry.type === 'certificate.trusted')).toEqual([
    expect.objectContaining({ pane: null, host: 'localhost', reason: 'loopback' })
  ])
})

test('a certificate from an authority nobody knows loads on loopback with no prompt', async () => {
  const authority = createAuthority()
  const leaf = issueCertificate({ commonName: 'localhost', ...LOOPBACK_NAMES, authority })
  // The chain as a real dev server serves it: the leaf, then the authority that signed it.
  const fixture = await serve({
    ...leaf,
    cert: `${leaf.cert}${authority.certificate.cert}`
  })
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop', `${fixture.origin}/`)
  await open(shop)

  await expectPanesLoaded(shop, `${fixture.origin}/`)
  expect(await certificates()).toEqual({ trusted: [], waiting: [] })
})

test('an expired certificate on loopback prompts', async () => {
  const certificate = issueCertificate({
    commonName: 'localhost',
    ...LOOPBACK_NAMES,
    validFromDays: -30,
    validToDays: -1
  })
  const fixture = await serve(certificate)
  launched = await launchApp(sandbox)
  await open(makeRepo('shop', `${fixture.origin}/`))

  await expectPrompt('localhost', certificate.fingerprint)
})

test('a hostname mismatch on loopback prompts', async () => {
  // A perfectly current certificate that simply is not this host's. Chromium reports the
  // unreachable authority ahead of the wrong name, so only the certificate says so.
  const certificate = issueCertificate({ commonName: 'other.example' })
  const fixture = await serve(certificate)
  launched = await launchApp(sandbox)
  await open(makeRepo('shop', `${fixture.origin}/`))

  await expectPrompt('localhost', certificate.fingerprint)
})

test('a certificate on another host prompts once, then loads every time after', async () => {
  const certificate = issueCertificate({ commonName: REMOTE_HOST })
  const fixture = await serve(certificate, REMOTE_HOST)
  launched = await launchApp(sandbox, [RESOLVE_REMOTE])
  let page = await launched.app.firstWindow()
  const shop = makeRepo('shop', `${fixture.origin}/`)
  await open(shop)

  await expectPrompt(REMOTE_HOST, certificate.fingerprint)
  // One question for three panes: they all met the same certificate.
  await expect(page.getByTestId('certificate-prompt')).toHaveCount(1)

  await page.getByTestId('trust-certificate').click()

  await expectPanesLoaded(shop, `${fixture.origin}/`)
  await expect(page.getByTestId('certificate-prompt')).toHaveCount(0)
  expect(await certificates()).toEqual({
    trusted: [
      {
        host: REMOTE_HOST,
        // Electron's spelling of the fingerprint and the fixture's are the same string,
        // which is what makes the key mean anything.
        fingerprint: certificate.fingerprint,
        subject: REMOTE_HOST,
        issuer: REMOTE_HOST,
        error: 'net::ERR_CERT_AUTHORITY_INVALID',
        trustedAt: expect.any(Number)
      }
    ],
    waiting: []
  })

  // The decision is visible in settings and survives a restart.
  await closeApp(launched)
  launched = await launchApp(sandbox, [RESOLVE_REMOTE])
  page = await launched.app.firstWindow()
  await open(shop)

  await expectPanesLoaded(shop, `${fixture.origin}/`)
  expect((await certificates()).trusted).toEqual([
    expect.objectContaining({ host: REMOTE_HOST, fingerprint: certificate.fingerprint })
  ])
  await expect(page.getByTestId('certificate-prompt')).toHaveCount(0)

  await page.getByTestId('trusted-certificates').click()
  const listed = page.getByTestId('trusted-certificate')
  await expect(listed).toHaveCount(1)
  await expect(listed).toHaveAttribute('data-fingerprint', certificate.fingerprint)
})

test("the decisions are the app's, so they are in settings with no project open", async () => {
  const certificate = issueCertificate({ commonName: REMOTE_HOST })
  const fixture = await serve(certificate, REMOTE_HOST)
  launched = await launchApp(sandbox, [RESOLVE_REMOTE])
  let page = await launched.app.firstWindow()
  await open(makeRepo('shop', `${fixture.origin}/`))
  await expectPrompt(REMOTE_HOST, certificate.fingerprint)
  await page.getByTestId('trust-certificate').click()
  await expect.poll(async () => (await certificates()).trusted).toHaveLength(1)

  // A fresh window with nothing open: the certificate belongs to a host, not to the
  // project that happened to meet it ([ADR-0012]).
  await closeApp(launched)
  launched = await launchApp(sandbox, [RESOLVE_REMOTE])
  page = await launched.app.firstWindow()
  await expect(page.getByTestId('project-name')).toHaveCount(0)

  await page.getByTestId('trusted-certificates').click()
  await expect(page.getByTestId('trusted-certificate')).toHaveAttribute('data-host', REMOTE_HOST)
})

test('a different certificate on an already-trusted host prompts again', async () => {
  const first = issueCertificate({ commonName: REMOTE_HOST })
  const fixture = await serve(first, REMOTE_HOST)
  launched = await launchApp(sandbox, [RESOLVE_REMOTE])
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop', `${fixture.origin}/`)
  await open(shop)

  await expectPrompt(REMOTE_HOST, first.fingerprint)
  await page.getByTestId('trust-certificate').click()
  await expectPanesLoaded(shop, `${fixture.origin}/`)

  // The same host, a new certificate. Keyed on the host alone this would be silent.
  const second = issueCertificate({ commonName: REMOTE_HOST })
  expect(second.fingerprint).not.toBe(first.fingerprint)
  const replaced = await serve(second, REMOTE_HOST)

  await page.getByTestId('project-url').fill(`${replaced.origin}/`)
  await page.getByTestId('project-url').press('Enter')

  await expect
    .poll(async () => (await certificates()).waiting, { timeout: 25_000 })
    .toEqual([expect.objectContaining({ host: REMOTE_HOST, fingerprint: second.fingerprint })])
  await expect(page.getByTestId('certificate-prompt')).toHaveAttribute(
    'data-fingerprint',
    second.fingerprint
  )
})

test('a refused certificate is not stored, and forgetting one makes it ask again', async () => {
  const certificate = issueCertificate({ commonName: REMOTE_HOST })
  const fixture = await serve(certificate, REMOTE_HOST)
  launched = await launchApp(sandbox, [RESOLVE_REMOTE])
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop', `${fixture.origin}/`)
  await open(shop)

  await expectPrompt(REMOTE_HOST, certificate.fingerprint)
  await page.getByTestId('refuse-certificate').click()

  // The question goes away for every pane it was holding, not just the first one to have
  // reached it, and nothing is stored.
  await expect(page.getByTestId('certificate-prompt')).toHaveCount(0)
  await expect
    .poll(async () => (await logs()).some((entry) => entry.type === 'pane.loadFailed'))
    .toBe(true)
  expect(await certificates()).toEqual({ trusted: [], waiting: [] })

  // Asked again, because nothing was kept.
  await page.getByTestId('project-url').fill(`${fixture.origin}/`)
  await page.getByTestId('project-url').press('Enter')
  await expect
    .poll(async () => (await certificates()).waiting, { timeout: 25_000 })
    .toEqual([expect.objectContaining({ fingerprint: certificate.fingerprint })])

  await page.getByTestId('trust-certificate').click()
  await expectPanesLoaded(shop, `${fixture.origin}/`)

  // Forgetting it in settings puts it back to asking.
  await page.getByTestId('trusted-certificates').click()
  await page.getByTestId('forget-certificate').click()
  await expect(page.getByTestId('trusted-certificates-empty')).toBeVisible()
  await expect.poll(async () => (await certificates()).trusted).toEqual([])
  expect((await logs()).filter((entry) => entry.type === 'certificate.forgotten')).toEqual([
    expect.objectContaining({ pane: null, host: REMOTE_HOST })
  ])
})
