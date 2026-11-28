import { expect, test, type Page } from '@playwright/test'
import { attachedAll, Box, cli, close, createProject, inPane, launch, makeRepo, ROOTS, save, shot, startFixture } from './kit'

const ROW = 22

function metrics(page: Page) {
  return page.getByTestId('console-scroller').evaluate((el, rowHeight) => {
    const rows = [...el.querySelectorAll<HTMLElement>('[data-testid="console-row"]')]
    const visible = rows.filter((r) => r.offsetTop + rowHeight > el.scrollTop)
    const top = visible.sort((p, q) => p.offsetTop - q.offsetTop)[0]
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      firstCursorByTestFormula: Math.min(...visible.map((r) => Number(r.dataset.cursor))),
      topRowText: top?.querySelector('[data-testid="console-message"]')?.textContent ?? null,
      renderedRows: rows.length
    }
  }, rowHeight())
  function rowHeight() {
    return ROW
  }
}

const settle = (page: Page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

test('story 8: pinned at the bottom, holds its place once scrolled up (and why the e2e test flakes)', async () => {
  const fixture = await startFixture()
  const box = new Box()
  const repo = makeRepo('shop')
  const base = createProject(repo)
  const project = { ...base, startUrl: `${fixture.a}/` }
  box.store(project)
  const a = await launch(ROOTS.branch, box)
  await cli(a, ['.', '--json'], repo)
  await attachedAll(a, project.panes)
  const [mobile] = project.panes
  const rowH = await a.page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bp-row-sm')) || 0)
  const out: string[] = [`--bp-row-sm = ${rowH}px`]

  await inPane(a, mobile.id, `for (let n = 0; n < 300; n += 1) console.log('first ' + n); 0`)
  await expect(a.page.getByTestId('console-row').filter({ hasText: 'first 299' })).toHaveCount(1)
  await settle(a.page)
  out.push(`after 300 entries, pinned to bottom: ${JSON.stringify(await metrics(a.page))}`)
  await shot(a, '80-anchor-pinned-bottom.png')

  for (let trial = 0; trial < 1; trial++) {
    await a.page.getByTestId('console-scroller').evaluate((el, h) => (el.scrollTop = h * 40), rowH)
    const immediate = await metrics(a.page)
    await settle(a.page)
    const settled = await metrics(a.page)
    out.push(`scrollTop set to 40 rows, read IMMEDIATELY (what the e2e test does): ${JSON.stringify(immediate)}`)
    out.push(`same, read after two animation frames:                         ${JSON.stringify(settled)}`)
  }
  await shot(a, '81-anchor-scrolled-up.png')
  const held = await metrics(a.page)

  await inPane(a, mobile.id, `for (let n = 0; n < 300; n += 1) console.log('second ' + n); 0`)
  await expect.poll(async () => (await metrics(a.page)).scrollHeight).toBeGreaterThanOrEqual(held.scrollHeight + 300 * rowH)
  await settle(a.page)
  const after = await metrics(a.page)
  out.push(`after 300 more entries arrived below:                           ${JSON.stringify(after)}`)
  out.push(`held position: scrollTop ${held.scrollTop} -> ${after.scrollTop}; top row "${held.topRowText}" -> "${after.topRowText}"`)
  await shot(a, '82-anchor-held-after-300-more.png')
  save('80-anchor.txt', out.join('\n') + '\n')
  expect(after.scrollTop).toBe(held.scrollTop)
  expect(after.topRowText).toBe(held.topRowText)
  await close(a)
  await fixture.close()
})
