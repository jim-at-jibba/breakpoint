import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  attachedAll,
  Box,
  BUNDLED_SOURCES,
  bundledPageFor,
  cli,
  cliTranscript,
  close,
  createProject,
  frame,
  inPane,
  launch,
  makeRepo,
  PROOF,
  requestLine,
  ROOTS,
  save,
  sendRaw,
  shot,
  startFixture,
  state,
  type App
} from './kit'

const rows = (page: Page) => page.getByTestId('console-row')

async function drawnRows(page: Page) {
  return rows(page).evaluateAll((all) =>
    all.map((r) => ({
      level: (r as HTMLElement).dataset.level,
      panes: (r as HTMLElement).dataset.panes,
      message: r.querySelector('[data-testid="console-message"]')?.textContent,
      location: r.querySelector('[data-testid="console-location"]')?.textContent ?? null
    }))
  )
}

async function logsSummary(a: App, args: string[] = ['logs', '--json']) {
  const run = await cli(a, args)
  const read = JSON.parse(run.stdout)
  return read
}

async function bundledApp(root: string) {
  const fixture = await startFixture()
  const box = new Box()
  const repo = makeRepo('shop', BUNDLED_SOURCES)
  const project = { ...createProject(repo), startUrl: `${fixture.a}${bundledPageFor('responsive')}` }
  box.store(project)
  const a = await launch(root, box)
  await cli(a, ['.', '--json'], repo)
  await attachedAll(a, project.panes)
  return { fixture, box, repo, project, a }
}

test('before: main, same fixture, nothing drawn', async () => {
  test.skip(!ROOTS.main, 'no main')
  const { fixture, a } = await bundledApp(ROOTS.main)
  await new Promise((r) => setTimeout(r, 3000))
  await shot(a, '10-before-main-fixture-errors-nowhere-to-read.png')
  const read = await logsSummary(a)
  save(
    '10-before-main.txt',
    `main build, Phase 2a fixture loaded in 3 panes\n` +
      `console rows drawn in the window: ${await rows(a.page).count()}\n` +
      `console entries in the log (breakpoint logs --json): ${read.entries.filter((e: any) => e.type === 'console.message' || e.type === 'console.exception' || String(e.type).startsWith('console')).length}\n`
  )
  await close(a)
  await fixture.close()
})

test('#74 #75 #76 #77 rows, collapsing, filters, clear and preserve log', async () => {
  const { fixture, box, project, a } = await bundledApp(ROOTS.branch)
  const [mobile, tablet, desktop] = project.panes
  const notes: string[] = []
  notes.push(`panes: ${project.panes.map((p) => `${p.name}=${p.id} (${p.width}px)`).join(', ')}`)

  await expect(rows(a.page).filter({ hasText: 'Uncaught RangeError' })).toHaveCount(1)
  for (const p of project.panes)
    await expect(rows(a.page).filter({ hasText: `laid out at ${p.width}px` })).toHaveCount(1)
  await expect(rows(a.page).filter({ hasText: 'Failed to load resource' })).toHaveAttribute(
    'data-panes',
    project.panes.map((p) => p.id).join(' ')
  )
  // A long message, clamped to one line.
  await inPane(a, desktop.id, `console.warn('a very long warning ' + 'that keeps going '.repeat(40) + 'END'); 0`)
  await expect(rows(a.page).filter({ hasText: 'a very long warning' })).toHaveCount(1)

  const read = await logsSummary(a)
  const consoleEntries = read.entries.filter((e: any) => String(e.type).startsWith('console'))
  const drawn = await drawnRows(a.page)
  notes.push(`log console entries: ${consoleEntries.length}; rows drawn: ${drawn.length}`)
  save('20-rows-drawn.json', JSON.stringify({ panes: project.panes.map(({ id, name, width }) => ({ id, name, width })), rows: drawn }, null, 2))
  save('20-log-console-entries.json', JSON.stringify(consoleEntries.map((e: any) => ({ cursor: e.cursor, pane: e.pane, type: e.type, level: e.level, text: e.text, location: e.location ?? e.source })), null, 2))
  await shot(a, '20-console-rows-collapsed.png')

  // Badge colour = header tab colour, per pane.
  const colours = await a.page.evaluate(() => {
    const out: Record<string, { badge: string[]; header: string | null }> = {}
    document.querySelectorAll<HTMLElement>('[data-testid="console-pane-badge"]').forEach((b) => {
      const id = b.dataset.pane!
      const swatch = (b.querySelector('span') as HTMLElement) ?? b
      out[id] ??= { badge: [], header: null }
      const c = getComputedStyle(swatch).backgroundColor
      if (!out[id].badge.includes(c)) out[id].badge.push(c)
    })
    document.querySelectorAll<HTMLElement>('[data-testid="pane-tab"]').forEach((t) => {
      const id = t.closest<HTMLElement>('[data-testid="pane"]')?.dataset.pane
      if (id && out[id]) out[id].header = getComputedStyle(t).backgroundColor
    })
    return out
  })
  save('21-badge-colours.json', JSON.stringify(colours, null, 2))

  // Expand the collapsed network row.
  const network = rows(a.page).filter({ hasText: 'Failed to load resource' })
  await network.click()
  await expect(network).toHaveAttribute('aria-expanded', 'true')
  await expect(a.page.getByTestId('console-entry')).toHaveCount(3)
  const long = rows(a.page).filter({ hasText: 'a very long warning' })
  await long.click()
  await shot(a, '22-console-row-expanded.png')
  await network.click()
  await long.click()

  // Filters.
  const filters: Record<string, unknown> = {}
  await a.page.getByTestId('console-filter-text').fill('nav')
  await expect(rows(a.page)).toHaveCount(1)
  filters['text "nav"'] = await drawnRows(a.page)
  await shot(a, '23-filter-text-nav.png')
  await a.page.getByTestId('console-filter-clear').click()

  // level: error only (click every other level off)
  for (const level of ['warn', 'info', 'log', 'debug'])
    await a.page.locator(`[data-testid="console-filter-level"][data-level="${level}"]`).click()
  await expect(rows(a.page).filter({ hasText: 'laid out at' })).toHaveCount(0)
  filters['levels: error only'] = await drawnRows(a.page)
  // pane: tablet only, on top of it
  for (const p of [mobile, desktop])
    await a.page.locator(`[data-testid="console-filter-pane"][data-pane="${p.id}"]`).click()
  await expect(rows(a.page).filter({ hasText: 'Uncaught RangeError' })).toHaveCount(0)
  filters['levels: error only + pane: Tablet only'] = await drawnRows(a.page)
  await shot(a, '24-filter-error-and-tablet.png')
  await a.page.getByTestId('console-filter-clear').click()
  const logsAfterFilter = (await logsSummary(a)).entries.length
  notes.push(`log entries before filtering: ${read.entries.length}, after filtering in the window: ${logsAfterFilter} (filters touch only the window)`)
  save('23-filters.json', JSON.stringify(filters, null, 2))

  // Clear.
  const before = await state(a)
  const errorsBefore = Object.fromEntries(project.panes.map((p) => [p.name, before.panes[p.id].errors]))
  const sinceZeroBefore = (await logsSummary(a, ['logs', '--since', '0', '--json'])).entries.length
  await a.page.getByTestId('console-clear').click()
  await expect(rows(a.page)).toHaveCount(0)
  await shot(a, '25-cleared.png')
  const after = await state(a)
  const errorsAfter = Object.fromEntries(project.panes.map((p) => [p.name, after.panes[p.id].errors]))
  const sinceZeroAfter = (await logsSummary(a, ['logs', '--since', '0', '--json'])).entries.length
  let clearTxt = ''
  clearTxt += `rows drawn after Clear: ${await rows(a.page).count()}\n`
  clearTxt += `state.console after Clear: ${JSON.stringify(after.console)}\n`
  clearTxt += `pane error counts  before Clear: ${JSON.stringify(errorsBefore)}\n`
  clearTxt += `pane error counts  after  Clear: ${JSON.stringify(errorsAfter)}\n`
  clearTxt += `breakpoint logs --since 0 --json | entries.length  before Clear: ${sinceZeroBefore}\n`
  clearTxt += `breakpoint logs --since 0 --json | entries.length  after  Clear: ${sinceZeroAfter}\n`
  // Reload survives the window
  await a.page.reload()
  await a.page.getByTestId('console').waitFor()
  await new Promise((r) => setTimeout(r, 1000))
  const floorNow = (await state(a)).console.floor
  const allNow = (await logsSummary(a, ['logs', '--since', '0', '--json'])).entries
  const consoleAbove = allNow.filter((e: any) => String(e.type).startsWith('console') && e.cursor > floorNow)
  const consoleBelow = allNow.filter((e: any) => String(e.type).startsWith('console') && e.cursor <= floorNow)
  clearTxt += `\nreloading the window (which also reloads every pane's guest page):\n`
  clearTxt += `  state.console after reload: ${JSON.stringify((await state(a)).console)}\n`
  clearTxt += `  console entries at/below the floor (hidden): ${consoleBelow.length}; above it (the reloaded pages logging again): ${consoleAbove.length}\n`
  clearTxt += `  rows drawn: ${await rows(a.page).count()} -> ${JSON.stringify((await drawnRows(a.page)).map((r) => r.message?.slice(0, 60)))}\n`
  clearTxt += `  entries above the floor: ${JSON.stringify(consoleAbove.map((e: any) => [e.cursor, e.text?.slice(0, 60)]))}\n`

  // Preserve log ON (default): an error survives a navigation.
  await inPane(a, mobile.id, `console.error('said before navigating'); 0`)
  await expect(rows(a.page).filter({ hasText: 'said before navigating' })).toHaveCount(1)
  const nav1 = await a.page.evaluate((url) => window.breakpoint.invoke('project.navigate', { url }), `${fixture.a}${bundledPageFor('responsive')}`)
  await expect(rows(a.page).filter({ hasText: 'Uncaught RangeError' })).toHaveCount(2)
  clearTxt += `\npreserve log ON, project.navigate -> ok=${(nav1 as any).ok}; RangeError rows (old page + new page): ${await rows(a.page).filter({ hasText: 'Uncaught RangeError' }).count()}; "said before navigating" rows still drawn: ${await rows(a.page).filter({ hasText: 'said before navigating' }).count()}\n`
  await shot(a, '26-preserve-on-after-navigate.png')

  // Preserve log OFF: navigation moves the floor.
  await a.page.getByTestId('console-preserve-log').click()
  await expect.poll(async () => (await state(a)).console.preserveLog).toBe(false)
  await inPane(a, mobile.id, `console.error('said before navigating, preserve off'); 0`)
  await expect(rows(a.page).filter({ hasText: 'preserve off' })).toHaveCount(1)
  const floorBefore = (await state(a)).console.floor
  const nav2 = await a.page.evaluate((url) => window.breakpoint.invoke('project.navigate', { url }), `${fixture.a}${bundledPageFor('responsive')}`)
  writeFileSync(join(PROOF, 'raw', 'nav2-debug.json'), JSON.stringify({ nav1, nav2, floorBefore, stateAfter: (await state(a)).console }, null, 2))
  await expect(rows(a.page).filter({ hasText: 'preserve off' })).toHaveCount(0)
  await expect(rows(a.page).filter({ hasText: 'Uncaught RangeError' })).toHaveCount(1)
  const floorAfter = (await state(a)).console.floor
  clearTxt += `preserve log OFF, project.navigate: floor ${floorBefore} -> ${floorAfter}; "preserve off" rows still drawn: ${await rows(a.page).filter({ hasText: 'preserve off' }).count()}; still in the log: ${(await logsSummary(a, ['logs', '--since', '0', '--json'])).entries.some((e: any) => JSON.stringify(e).includes('preserve off'))}\n`
  await shot(a, '27-preserve-off-after-navigate.png')
  await a.page.getByTestId('console-preserve-log').click()
  save('25-clear-and-preserve.txt', clearTxt)
  save('20-rows-notes.txt', notes.join('\n') + '\n')
  await close(a)
  await fixture.close()
})

test('#79 REPL, panes.evaluate', async () => {
  const fixture = await startFixture()
  const box = new Box()
  const repo = makeRepo('shop')
  const project = { ...createProject(repo), startUrl: `${fixture.a}/` }
  box.store(project)
  const a = await launch(ROOTS.branch, box)
  await cli(a, ['.', '--wait', '--json'], repo)
  await attachedAll(a, project.panes)
  const field = a.page.getByTestId('console-repl-input-field')
  const results = a.page.getByTestId('console-repl-result')

  await field.fill('innerWidth')
  await field.press('Enter')
  await expect(results).toHaveCount(3)
  await field.fill('await new Promise((r) => setTimeout(() => r(`${innerWidth}×${innerHeight} @${devicePixelRatio}x`), 100))')
  await field.press('Enter')
  await expect(results).toHaveCount(6)
  await field.fill('document.querySelector(".nope").textContent')
  await field.press('Enter')
  await expect(results).toHaveCount(9)
  await a.page.locator(`[data-testid="console-repl-target"][data-pane="${project.panes[0].id}"]`).click()
  await field.fill('navigator.userAgent.includes("Mobile")')
  await field.press('Enter')
  await expect(results).toHaveCount(10)
  // History
  await field.press('ArrowUp')
  const h1 = await field.inputValue()
  await field.press('ArrowUp')
  const h2 = await field.inputValue()
  await field.press('ArrowDown')
  await field.press('ArrowDown')
  const h0 = await field.inputValue()
  await shot(a, '30-repl.png')
  const drawn = await results.evaluateAll((all) =>
    all.map((r) => ({
      pane: (r as HTMLElement).dataset.pane,
      outcome: (r as HTMLElement).dataset.outcome,
      text: r.querySelector('[data-testid="console-message"]')?.textContent
    }))
  )
  const sock = await sendRaw(box.socketPath, requestLine('panes.evaluate', { expression: 'await Promise.resolve(innerWidth * 2)' }))
  const logBefore = (await cli(a, ['logs', '--json'])).stdout
  const evalCli = await cliTranscript(a, ['eval', 'innerWidth'])
  let txt = `panes: ${project.panes.map((p) => `${p.name}=${p.id}`).join(', ')}\n\n`
  txt += `answers drawn in the window:\n${JSON.stringify(drawn, null, 2)}\n\n`
  txt += `history: ArrowUp -> ${JSON.stringify(h1)}; ArrowUp -> ${JSON.stringify(h2)}; ArrowDown x2 -> ${JSON.stringify(h0)}\n\n`
  txt += `socket panes.evaluate {expression:"await Promise.resolve(innerWidth * 2)"} ->\n${JSON.stringify(sock, null, 2)}\n\n`
  txt += `log entries mentioning "innerWidth" (REPL writes nothing to the log): ${(logBefore.match(/innerWidth/g) ?? []).length}\n\n`
  txt += `breakpoint eval is deliberately NOT shipped (ADR-0025):\n${evalCli}`
  save('30-repl.txt', txt)
  await close(a)
  await fixture.close()
})

test('#80 DevTools on a pane, #81 header flash', async () => {
  const fixture = await startFixture()
  const box = new Box()
  const repo = makeRepo('shop')
  const project = { ...createProject(repo), startUrl: `${fixture.a}/` }
  box.store(project)
  const a = await launch(ROOTS.branch, box)
  await cli(a, ['.', '--wait', '--json'], repo)
  await attachedAll(a, project.panes)
  const [mobile, , desktop] = project.panes

  // #81: frames of the mobile header while an error lands.
  const header = a.page.locator(`[data-testid="pane"][data-pane="${mobile.id}"] [data-testid="pane-header"]`)
  const hb = (await header.boundingBox())!
  const inner = await a.page.evaluate(() => innerWidth)
  const dir = join(PROOF, 'raw', 'flash')
  mkdirSync(dir, { recursive: true })
  const frames: Buffer[] = []
  frames.push(await frame(a))
  frames.push(await frame(a))
  const t0 = Date.now()
  void sendRaw(box.socketPath, requestLine('panes.evaluate', { expression: `console.error('boom on mobile')`, pane: mobile.id }))
  let sawFlash = false
  while (Date.now() - t0 < 2600) {
    frames.push(await frame(a))
    if (!sawFlash) sawFlash = (await a.page.getByTestId('pane-error-flash').count()) > 0
  }
  frames.forEach((f, i) => writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.png`), f))
  save('raw/flash/crop.json', JSON.stringify({ ...hb, inner, elapsedMs: Date.now() - t0, frames: frames.length, sawFlashElement: sawFlash }))

  // #80: DevTools via the header button on the widest pane.
  const ids = await Promise.all(
    project.panes.map((p) =>
      a.page.locator(`webview[data-pane="${p.id}"]`).evaluate((el) => (el as any).getWebContentsId() as number)
    )
  )
  await a.page.locator(`[data-testid="pane-devtools"][data-pane="${desktop.id}"]`).click()
  await expect
    .poll(() => a.app.evaluate(({ webContents }, ids) => ids.map((id) => webContents.fromId(id)!.isDevToolsOpened()), ids))
    .toEqual([false, false, true])
  const before = (await state(a)).panes[desktop.id]
  await sendRaw(box.socketPath, requestLine('panes.evaluate', { expression: `console.error('logged while DevTools is open')`, pane: desktop.id }))
  await expect.poll(async () => (await state(a)).panes[desktop.id].errors).toBe(before.errors + 1)
  await new Promise((r) => setTimeout(r, 2500))
  await shot(a, '41-devtools-open-breakpoint-still-hears.png')
  const devtoolsPng = await a.app.evaluate(async ({ webContents }, id) => {
    const dt = webContents.fromId(id)!.devToolsWebContents!
    // Select the Console panel so the reviewer sees the same error.
    await dt.executeJavaScript(`(async () => { try { const UI = await import('./ui/legacy/legacy.js'); UI.ViewManager.ViewManager.instance().showView('console'); } catch (e) {} })()`).catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
    return (await dt.capturePage()).toPNG().toString('base64')
  }, ids[2])
  writeFileSync(join(PROOF, '40-devtools-window.png'), Buffer.from(devtoolsPng, 'base64'))
  const afterOpen = (await state(a)).panes[desktop.id]
  await a.app.evaluate(({ webContents }, id) => webContents.fromId(id)!.closeDevTools(), ids[2])
  await sendRaw(box.socketPath, requestLine('panes.evaluate', { expression: `console.error('logged after DevTools closed')`, pane: desktop.id }))
  await expect.poll(async () => (await state(a)).panes[desktop.id].errors).toBe(before.errors + 2)
  const afterClose = (await state(a)).panes[desktop.id]
  const viaSocket = await sendRaw(box.socketPath, requestLine('panes.openDevTools', { pane: mobile.id }))
  const missing = await sendRaw(box.socketPath, requestLine('panes.openDevTools', { pane: 'nope' }))
  const logs = (await logsSummary(a)).entries.filter((e: any) => e.pane === desktop.id && JSON.stringify(e).includes('DevTools')).map((e: any) => ({ cursor: e.cursor, level: e.level, text: e.text }))
  const pick = (p: any) => ({ attachment: p.attachment, degraded: p.degraded, errors: p.errors })
  save(
    '40-devtools.txt',
    `clicked the DevTools button on Desktop (${desktop.id})\n` +
      `isDevToolsOpened per pane [Mobile, Tablet, Desktop]: [false, false, true]\n` +
      `Desktop before:           ${JSON.stringify(pick(before))}\n` +
      `Desktop with DevTools open: ${JSON.stringify(pick(afterOpen))}\n` +
      `Desktop after it closed:  ${JSON.stringify(pick(afterClose))}\n` +
      `log entries from Desktop mentioning DevTools: ${JSON.stringify(logs, null, 2)}\n` +
      `socket panes.openDevTools {pane: Mobile} -> ${JSON.stringify(viaSocket)}\n` +
      `socket panes.openDevTools {pane: "nope"} -> ${JSON.stringify(missing)}\n`
  )
  await close(a)
  await fixture.close()
})
