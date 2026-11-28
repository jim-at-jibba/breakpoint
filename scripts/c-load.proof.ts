import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  attachedAll,
  Box,
  cli,
  close,
  createProject,
  FLOOD,
  FLOOD_PATH,
  frame,
  inPane,
  launch,
  makeRepo,
  PROOF,
  requestLine,
  ROOTS,
  save,
  sendRaw,
  startFixture,
  state
} from './kit'

async function floodApp(root: string) {
  const fixture = await startFixture()
  const box = new Box()
  const repo = makeRepo('flood')
  const base = createProject(repo)
  const project = { ...base, panes: base.panes.slice(0, 1), startUrl: `${fixture.a}/` }
  box.store(project)
  const a = await launch(root, box)
  await cli(a, ['.', '--json'], repo)
  await attachedAll(a, project.panes)
  return { fixture, box, project, a }
}

for (const run of ['measured', 'recorded'] as const) {
  test(`#82 load: 2,000 entries/s, ${run}`, async () => {
    const { fixture, box, project, a } = await floodApp(ROOTS.branch)
    const [pane] = project.panes
    await a.page.evaluate(() => {
      const probe = { console: [] as number[], patches: 0 }
      ;(window as any).probe = probe
      window.breakpoint.onConsole((batch: any) => {
        probe.console.push(batch.entries.filter((e: any) => e.text.startsWith('flood ')).length)
      })
      window.breakpoint.onPatches(() => {
        probe.patches += 1
      })
    })
    const socketTrips: number[] = []
    const windowTrips: number[] = []
    let flooding = true
    const probes = (async () => {
      while (flooding) {
        const started = Date.now()
        const [s, w] = await Promise.all([
          sendRaw(box.socketPath, requestLine('panes.list')).then(() => Date.now() - started),
          a.page.evaluate(async () => (await window.breakpoint.invoke('panes.list')).ok).then(() => Date.now() - started)
        ])
        socketTrips.push(s)
        windowTrips.push(w)
        await new Promise((r) => setTimeout(r, 20))
      }
    })()
    const frames: Buffer[] = []
    let recording = run === 'recorded'
    const recorder = (async () => {
      while (recording) frames.push(await frame(a))
    })()
    const t0 = Date.now()
    await a.page.evaluate((url) => window.breakpoint.invoke('project.navigate', { url }), `${fixture.a}${FLOOD_PATH}`)
    await expect.poll(() => inPane(a, pane.id, 'typeof window.flooded'), { timeout: 10_000 }).toBe('object')
    const took = await inPane(a, pane.id, 'window.flooded')
    await expect(a.page.getByTestId('console-row').filter({ hasText: `flood ${FLOOD.entries - 1}` })).toBeVisible({ timeout: 10_000 })
    const lastVisibleMs = Date.now() - t0
    await new Promise((r) => setTimeout(r, 400))
    flooding = false
    recording = false
    await probes
    await recorder
    const probe = await a.page.evaluate(() => (window as any).probe)
    const carrying = probe.console.filter((n: number) => n > 0)
    const stats = (xs: number[]) => {
      const s = [...xs].sort((p, q) => p - q)
      return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] }
    }
    const logRead = JSON.parse((await cli(a, ['logs', '--json'])).stdout)
    const floodInLog = logRead.entries.filter((e: any) => String(e.text ?? '').startsWith('flood ')).length
    const result = {
      run,
      note: run === 'recorded' ? 'window was being screen-captured continuously during this run (extra load on main + GPU)' : 'no capture during this run',
      pageLoggedEntries: FLOOD.entries,
      pageTookMs: Math.round(took),
      lastRowVisibleAfterNavigateMs: lastVisibleMs,
      floodEntriesInLog: floodInLog,
      roundTripDeadlineMs: 250,
      socketRoundTripsMs: stats(socketTrips),
      windowRoundTripsMs: stats(windowTrips),
      consoleChannelDeliveriesCarryingFlood: carrying.length,
      entriesDeliveredOnConsoleChannel: carrying.reduce((x: number, y: number) => x + y, 0),
      largestBatch: Math.max(...carrying),
      patchBatchesDuringFlood: probe.patches,
      snapshotRevision: (await state(a)).revision,
      rawSocketTrips: socketTrips,
      rawWindowTrips: windowTrips
    }
    save(`60-load-${run}.json`, JSON.stringify(result, null, 2))
    if (run === 'recorded') {
      const dir = join(PROOF, 'raw', 'flood')
      mkdirSync(dir, { recursive: true })
      frames.forEach((f, i) => writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.png`), f))
      save('raw/flood/meta.json', JSON.stringify({ frames: frames.length, ms: Date.now() - t0 }))
    }
    expect(Math.max(...socketTrips)).toBeLessThan(250)
    expect(Math.max(...windowTrips)).toBeLessThan(250)
    await close(a)
    await fixture.close()
  })
}
