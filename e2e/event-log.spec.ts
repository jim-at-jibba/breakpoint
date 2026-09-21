import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { LogRead } from '../src/shared/event-log'
import { PROJECT_FILE_VERSION, projectFileName } from '../src/shared/project'
import { encodeLine, MAX_FRAME_BYTES, MAX_REQUEST_ID_BYTES } from '../src/shared/protocol'
import type { StateSnapshot } from '../src/shared/state'
import {
  closeApp,
  launchApp,
  MAIN_ENTRY,
  requestLine,
  runCli,
  Sandbox,
  sendRaw,
  type LaunchedApp
} from './harness'

/**
 * The event log, probed the way an agent reaches it: a cursor out of the state payload
 * and a read from that cursor over the real socket. Nothing here asks the log to
 * describe itself — eviction, which needs ten thousand entries, is a unit test.
 */

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repos: string

function makeRepo(name: string): string {
  const path = join(repos, name)
  mkdirSync(path, { recursive: true })
  return realpathSync.native(path)
}

/** A project file this build refuses, so opening the repo fails the way #9 asks about. */
function writeUnreadableProject(repoPath: string): void {
  const projects = join(sandbox.userDataDir, 'projects')
  mkdirSync(projects, { recursive: true })
  writeFileSync(
    join(projects, projectFileName(repoPath)),
    JSON.stringify({ version: PROJECT_FILE_VERSION + 1, project: { name: 'from the future' } })
  )
}

async function state(): Promise<StateSnapshot> {
  const run = await runCli(sandbox, ['state', '--json'])
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as StateSnapshot
}

async function logsSince(cursor: number): Promise<LogRead> {
  const run = await runCli(sandbox, ['logs', '--since', String(cursor), '--json'])
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as LogRead
}

test.beforeEach(() => {
  sandbox = new Sandbox()
  launched = undefined
  repos = mkdtempSync(join(tmpdir(), 'bp-repos-'))
})

test.afterEach(async () => {
  if (launched) await closeApp(launched)
  sandbox.dispose()
  rmSync(repos, { recursive: true, force: true })
})

test('a project that refuses to load reaches a terminal reading from a cursor', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop')
  writeUnreadableProject(shop)

  const before = await state()
  expect(before.cursor).toBe(0)
  expect(await logsSince(before.cursor)).toEqual({ entries: [], cursor: 0 })

  // The failure a human would see in a dialog. The terminal sees the same thing.
  const failed = await runCli(sandbox, ['.', '--json'], shop)
  expect(failed.code).toBe(1)
  expect(JSON.parse(failed.stderr).error.code).toBe('PROJECT_UNREADABLE')

  const read = await logsSince(before.cursor)
  expect(read.droppedBefore).toBeUndefined()
  expect(read.entries).toHaveLength(1)
  expect(read.entries[0]).toMatchObject({
    cursor: 1,
    pane: null,
    type: 'project.openFailed',
    path: shop,
    code: 'PROJECT_UNREADABLE'
  })
  expect(read.entries[0]).toMatchObject({
    message: expect.stringContaining(`file version ${PROJECT_FILE_VERSION + 1}`)
  })
  expect(read.cursor).toBe(1)

  // And the state payload carries the position, so the next read starts where this ended.
  expect((await state()).cursor).toBe(1)
  expect(await logsSince(read.cursor)).toEqual({ entries: [], cursor: 1 })
})

test('a single oversized failure remains readable and can be passed by cursor', async () => {
  launched = await launchApp(sandbox)
  const path = join(repos, 'x'.repeat(600_000))
  const request = requestLine('project.open', { path })
  expect(Buffer.byteLength(request) - 1).toBeLessThan(MAX_FRAME_BYTES)
  const failed = await sendRaw(sandbox.socketPath, request)
  expect(failed.ok).toBe(false)

  const read = await logsSince(0)
  expect(read.entries).toHaveLength(1)
  expect(read.entries[0]).toMatchObject({ cursor: 1, truncated: ['path', 'message'] })
  expect(read.cursor).toBe(1)
  expect(await logsSince(read.cursor)).toEqual({ entries: [], cursor: 1 })
})

test('byte-limited pages drain through the CLI without losing entries', async () => {
  launched = await launchApp(sandbox)
  for (let index = 0; index < 80; index += 1) {
    const failed = await sendRaw(
      sandbox.socketPath,
      requestLine('project.open', { path: join(repos, `${index}-${'x'.repeat(10_000)}`) })
    )
    expect(failed.ok).toBe(false)
  }

  const first = await logsSince(0)
  expect(first.entries.length).toBeGreaterThan(0)
  expect(first.entries.length).toBeLessThan(80)
  expect(first.cursor).toBe(first.entries.at(-1)?.cursor)
  const id = 'x'.repeat(MAX_REQUEST_ID_BYTES - 2)
  const overSocket = await sendRaw(sandbox.socketPath, encodeLine({ id, route: 'log.read' }))
  expect(overSocket).toMatchObject({ id, ok: true, data: { cursor: first.cursor } })
  expect(Buffer.byteLength(encodeLine(overSocket)) - 1).toBeLessThanOrEqual(MAX_FRAME_BYTES)

  const refused = await sendRaw(sandbox.socketPath, encodeLine({ id: `${id}x`, route: 'log.read' }))
  expect(refused).toMatchObject({ id: '0', ok: false, error: { code: 'INVALID_REQUEST' } })
  const second = await logsSince(first.cursor)
  expect([...first.entries, ...second.entries].map((entry): number => entry.cursor)).toEqual(
    Array.from({ length: 80 }, (_, index: number): number => index + 1)
  )
  expect(second.cursor).toBe(80)
  expect(await logsSince(second.cursor)).toEqual({ entries: [], cursor: 80 })
})

test('a launch argument that cannot be opened is logged too, with no one to throw at', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop')
  writeUnreadableProject(shop)

  // A second copy handing its argv over: the open has no caller to reject, and the log
  // is the only way anyone hears about it.
  const second = spawn(launched.app.process().spawnfile, [MAIN_ENTRY, shop], {
    env: sandbox.env,
    stdio: 'ignore'
  })
  await new Promise<void>((resolve) => second.once('close', () => resolve()))

  await expect.poll(async () => (await logsSince(0)).entries.length, { timeout: 10_000 }).toBe(1)
  expect((await logsSince(0)).entries[0]).toMatchObject({
    pane: null,
    type: 'project.openFailed',
    path: shop,
    code: 'PROJECT_UNREADABLE'
  })
})

test('the human output prints the cursor beside the project and reads the log by it', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop')
  writeUnreadableProject(shop)
  await runCli(sandbox, ['.'], shop)

  const quiet = await runCli(sandbox, ['logs', '--since', '1'])
  expect(quiet.code).toBe(0)
  expect(quiet.stdout).toBe('Nothing after cursor 1.\n')

  const all = await runCli(sandbox, ['logs'])
  expect(all.stdout).toContain('1  app  could not open')
  expect(all.stdout).toContain('PROJECT_UNREADABLE')

  const store = makeRepo('store')
  const opened = await runCli(sandbox, ['.'], store)
  expect(opened.stdout).toContain('Cursor 1')
})

test('a cursor that is not a position is refused by the terminal and by the route', async () => {
  launched = await launchApp(sandbox)

  const usage = await runCli(sandbox, ['logs', '--since', 'yesterday'])
  expect(usage.code).toBe(2)
  expect(usage.stdout).toBe('')
  expect(usage.stderr).toContain('INVALID_USAGE: --since takes a cursor position')

  const missing = await runCli(sandbox, ['logs', '--since'])
  expect(missing.code).toBe(2)

  // The route refuses it on its own account, for a surface that is not the CLI.
  const overSocket = await sendRaw(sandbox.socketPath, requestLine('log.read', { since: -3 }))
  expect(overSocket.ok === false && overSocket.error.code).toBe('INVALID_PARAMS')
})

test('a missing cursor preserves JSON error output and never launches the app', async () => {
  const run = await runCli(sandbox, ['logs', '--since', '--json', '--no-launch'])
  expect(run.code).toBe(2)
  expect(run.stdout).toBe('')
  expect(JSON.parse(run.stderr)).toEqual({
    error: { code: 'INVALID_USAGE', message: '--since needs <cursor>' }
  })
})
