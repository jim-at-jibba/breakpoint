import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  levelOf,
  type Entry,
  type EntryOf,
  type LogRead,
  type SourceLocation
} from '../src/shared/event-log'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type StoredProject
} from '../src/shared/project'
import { bundle, bundledPageFor, BUNDLED_SOURCES } from './bundle'
import { startFixture, type Fixture } from './fixture'
import { closeApp, launchApp, runCli, Sandbox, type LaunchedApp } from './harness'

/**
 * Phase 2a's exit criterion, end to end, sharpened the way [ADR-0004] sharpened Phase 1's
 * (#57): panes at three widths load a production bundle whose nav throws below 640 CSS px,
 * and every width asks another origin for something it will not share. What an agent
 * reads back with `breakpoint logs --errors --json` is the exception from the mobile pane
 * alone and the cross-origin failure from every pane, each tagged with its pane.
 *
 * Phase 1's obvious assertion passed for three probe runs while every pane was 150px tall.
 * The same shape of mistake here is asserting that an error arrived without asserting where
 * it says it came from: that passes against a pipeline that captured everything and
 * resolved nothing. So the exception's repo-relative path and line are asserted, and the
 * bundle is minified onto one line, where its raw location — line 1 of a hashed script, no
 * path — cannot be mistaken for the line in the repo it was built from.
 */

/** Where `e2e/bundled/src/nav.js` throws, and where `responsive.js` calls it. */
const THROWS = { path: 'src/nav.js', line: 3 } as const
const CALLS = { path: 'src/responsive.js', line: 6 } as const
const NAV_FITS_FROM = 640

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repo: string
let fixture: Fixture

test.beforeEach(async () => {
  sandbox = new Sandbox()
  launched = undefined
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'bp-repo-')))
  fixture = await startFixture()
})

test.afterEach(async () => {
  if (launched) await closeApp(launched)
  sandbox.dispose()
  rmSync(repo, { recursive: true, force: true })
  await fixture.close()
})

async function read(args: string[]): Promise<Entry[]> {
  const run = await runCli(sandbox, ['logs', ...args, '--json'])
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return [...(JSON.parse(run.stdout) as LogRead).entries]
}

function ofPane(entries: Entry[], pane: string): Entry[] {
  return entries.filter((entry) => entry.pane === pane)
}

function exceptions(entries: Entry[]): EntryOf<'console.exception'>[] {
  return entries.filter(
    (entry): entry is EntryOf<'console.exception'> => entry.type === 'console.exception'
  )
}

function messages(entries: Entry[]): EntryOf<'console.message'>[] {
  return entries.filter(
    (entry): entry is EntryOf<'console.message'> => entry.type === 'console.message'
  )
}

test('a mobile-only exception and a cross-origin failure come back from --errors, by pane, resolved to the repo', async () => {
  test.setTimeout(120_000)

  const project: StoredProject = {
    ...createProject(repo),
    startUrl: `${fixture.a}${bundledPageFor('responsive')}`
  }
  const projects = join(sandbox.userDataDir, 'projects')
  mkdirSync(projects, { recursive: true })
  writeFileSync(join(projects, projectFileName(repo)), JSON.stringify(writeProjectFile(project)))
  // The repo the bundle was built from, so a resolved location has a file to point at.
  cpSync(BUNDLED_SOURCES, join(repo, 'src'), { recursive: true })

  // One narrower than the nav, two wider: "mobile only" has something to differ from.
  const [mobile, ...wider] = project.panes
  expect(project.panes.map((pane) => [pane.name, pane.width])).toEqual([
    ['Mobile', 390],
    ['Tablet', 820],
    ['Desktop', 1440]
  ])
  expect(mobile.width).toBeLessThan(NAV_FITS_FROM)
  for (const pane of wider) expect(pane.width).toBeGreaterThanOrEqual(NAV_FITS_FROM)

  launched = await launchApp(sandbox)
  const open = await runCli(sandbox, ['.', '--json'], repo)
  expect(open.stderr).toBe('')
  expect(open.code).toBe(0)

  const notShared = `${fixture.b}/not-shared`
  const refused = (entries: Entry[]): EntryOf<'console.message'>[] =>
    messages(entries).filter(
      (entry) =>
        (entry.source === 'network' && entry.url === notShared) ||
        (entry.source === 'javascript' && entry.text.includes(`'${notShared}'`))
    )

  // Every pane has run the script at its own width — so a pane with no exception is one
  // whose page did not throw, not one that never got that far — and every pane has
  // reported the refusal, and the mobile pane its exception.
  let everything: Entry[] = []
  await expect
    .poll(
      async () => {
        everything = await read([])
        return project.panes.every((pane) => {
          const own = ofPane(everything, pane.id)
          return (
            messages(own).some((entry) => entry.text === `laid out at ${pane.width}px`) &&
            refused(own).length === 2 &&
            exceptions(own).length === (pane === mobile ? 1 : 0)
          )
        })
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  // Past the point of the last thing any pane could say, so the read below is final.
  await expect
    .poll(async () => exceptions(await read(['--errors'])).length, { timeout: 2_000 })
    .toBe(1)

  const errors = await read(['--errors'])

  // Nothing that is not an error, though the full log has plenty that is not.
  expect(everything.some((entry) => levelOf(entry) !== 'error')).toBe(true)
  for (const entry of errors) expect(levelOf(entry), JSON.stringify(entry)).toBe('error')

  // Every error is one of the two this criterion is about, and from one of these panes.
  const panes = project.panes.map((pane) => pane.id)
  for (const entry of errors) expect(panes).toContain(entry.pane)
  expect(errors).toHaveLength(1 + 2 * project.panes.length)

  // The cross-origin failure from every pane, the browser's own two accounts of it.
  for (const pane of project.panes) {
    expect(refused(ofPane(errors, pane.id)), `${pane.name}'s refused request`).toEqual([
      expect.objectContaining({ level: 'error', source: 'javascript' }),
      expect.objectContaining({
        level: 'error',
        source: 'network',
        text: 'Failed to load resource: net::ERR_FAILED',
        url: notShared
      })
    ])
  }

  // The exception, from the mobile pane and nowhere else…
  const thrown = exceptions(errors)
  expect(thrown.map((entry) => entry.pane)).toEqual([mobile.id])
  const [exception] = thrown
  expect(exception.text).toBe(`Uncaught RangeError: the nav does not fit in ${mobile.width}px`)

  // …and where it says it came from: the file in the repo and the line in it, through the
  // bundle's map. Unresolved, this would be line 1 of the hashed script with no path.
  const script = `${fixture.a}${(await bundle()).entries.responsive}`
  const at = (where: { path: string; line: number }): Record<keyof SourceLocation, unknown> => ({
    url: script,
    line: where.line,
    column: expect.any(Number),
    resolution: 'resolved',
    path: where.path
  })
  expect(exception.location).toEqual(at(THROWS))
  expect(exception.stack).toEqual([
    expect.objectContaining(at(THROWS)),
    expect.objectContaining(at(CALLS))
  ])

  // What a terminal prints says the same, the repo's file and line in place of the script.
  const text = await runCli(sandbox, ['logs', '--errors'])
  expect(text.code).toBe(0)
  expect(text.stdout).toContain(
    `  ${mobile.id}  error ${exception.text} at ${THROWS.path}:${THROWS.line}:`
  )
  for (const pane of wider) {
    expect(text.stdout).not.toMatch(new RegExp(`  ${pane.id}  error Uncaught`))
  }
})
