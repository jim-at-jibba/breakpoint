import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  attachedAll,
  Box,
  cli,
  cliTranscript,
  close,
  createProject,
  launch,
  makeRepo,
  requestLine,
  ROOTS,
  save,
  sendRaw,
  shot,
  startFixture,
  state
} from './kit'

test('before: main has no panel', async () => {
  test.skip(!ROOTS.main, 'BP_MAIN_ROOT not set')
  const fixture = await startFixture()
  const box = new Box()
  const repo = makeRepo('shop')
  const project = { ...createProject(repo), startUrl: `${fixture.a}/` }
  box.store(project)
  const a = await launch(ROOTS.main, box)
  await cli(a, ['.', '--json'], repo)
  await attachedAll(a, project.panes)
  await inPaneLog(a, project.panes[0].id)
  await shot(a, '00-before-main-no-panel.png')
  const has = await a.page.getByTestId('panel').count()
  const routes = await sendRaw(box.socketPath, requestLine('app.setPanel', { visible: true }))
  save(
    '00-before-main.txt',
    `main build: panel elements in the DOM = ${has}\n` +
      `socket app.setPanel on main -> ${JSON.stringify(routes)}\n`
  )
  await close(a)
  await fixture.close()
})

async function inPaneLog(a: any, pane: string): Promise<void> {
  const { inPane } = await import('./kit')
  await inPane(a, pane, `console.error('an error main has nowhere to show'); 0`)
}

test('#73 the panel: docks bottom/right, hides, persists as an app setting', async () => {
  const fixture = await startFixture()
  const box = new Box()
  const shop = makeRepo('shop')
  const blog = makeRepo('blog')
  const p1 = { ...createProject(shop), startUrl: `${fixture.a}/` }
  const p2 = { ...createProject(blog), startUrl: `${fixture.a}/` }
  box.store(p1)
  box.store(p2)
  let a = await launch(ROOTS.branch, box)
  await cli(a, ['.', '--json'], shop)
  await attachedAll(a, p1.panes)
  const log: string[] = []

  await expect(a.page.getByTestId('panel')).toBeVisible()
  log.push(`default panel state: ${JSON.stringify((await state(a)).panel)}`)
  await shot(a, '01-panel-docked-bottom.png')

  await a.page.getByTestId('panel-side-toggle').click()
  await expect.poll(async () => (await state(a)).panel.side).toBe('right')
  log.push(`after clicking dock-side toggle: ${JSON.stringify((await state(a)).panel)}`)
  await shot(a, '02-panel-docked-right.png')

  await a.page.getByTestId('panel-hide').click()
  await expect.poll(async () => (await state(a)).panel.visible).toBe(false)
  await expect(a.page.getByTestId('panel')).toHaveCount(0)
  log.push(`after clicking hide: ${JSON.stringify((await state(a)).panel)}`)
  await shot(a, '03-panel-hidden.png')

  // Over the socket, the same route the window uses.
  const resp = await sendRaw(box.socketPath, requestLine('app.setPanel', { visible: true, size: 520 }))
  log.push(`socket app.setPanel {visible:true,size:520} -> ${JSON.stringify(resp)}`)
  await expect(a.page.getByTestId('panel')).toBeVisible()
  const settings = readFileSync(join(box.userDataDir, 'settings.json'), 'utf8')
  log.push(`settings.json on disk:\n${settings}`)

  // Switching repo does not move it.
  await cli(a, ['.', '--json'], blog)
  await expect.poll(async () => (await state(a)).project?.name).toBe('blog')
  log.push(`after opening a different repo (blog): ${JSON.stringify((await state(a)).panel)}`)

  // Restart: it comes back where it was.
  await close(a)
  a = await launch(ROOTS.branch, box)
  await cli(a, ['.', '--json'], shop)
  await attachedAll(a, p1.panes)
  log.push(`after quitting and relaunching the app: ${JSON.stringify((await state(a)).panel)}`)
  await shot(a, '04-panel-after-restart-right-520.png')
  save('panel.txt', log.join('\n') + '\n')
  await close(a)
  await fixture.close()
  void cliTranscript
})
