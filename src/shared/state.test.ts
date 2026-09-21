import { describe, expect, it } from 'vitest'
import { foldPaneStatus, initialPaneStatus } from './panes'
import { createProject } from './project'
import { applyPatch, type StateSnapshot } from './state'

const shop = createProject('/repos/shop')
const store = createProject('/repos/store')
const [mobile, tablet, desktop] = shop.panes.map((pane) => pane.id)
const failed = foldPaneStatus(initialPaneStatus(), { type: 'attachFailed', message: 'refused' })

const nothingOpen: StateSnapshot = { revision: 0, cursor: 4, project: null, panes: {} }

describe('applying a patch', () => {
  it('gives every pane of a newly opened project a fresh status', () => {
    const next = applyPatch(nothingOpen, {
      revision: 1,
      patch: { type: 'project.opened', project: shop }
    })
    expect(next).toEqual({
      revision: 1,
      cursor: 4,
      project: shop,
      panes: {
        [mobile]: initialPaneStatus(),
        [tablet]: initialPaneStatus(),
        [desktop]: initialPaneStatus()
      }
    })
  })

  it('records what was observed of one pane and leaves the others alone', () => {
    const open = applyPatch(nothingOpen, {
      revision: 1,
      patch: { type: 'project.opened', project: shop }
    })
    const next = applyPatch(open, {
      revision: 2,
      patch: { type: 'pane.status', pane: tablet, status: failed }
    })
    expect(next.panes).toEqual({ ...open.panes, [tablet]: failed })
    expect(next.revision).toBe(2)
  })

  it('keeps what is known about panes that survive reopening the same project', () => {
    const open = applyPatch(nothingOpen, {
      revision: 1,
      patch: { type: 'project.opened', project: shop }
    })
    const degraded = applyPatch(open, {
      revision: 2,
      patch: { type: 'pane.status', pane: tablet, status: failed }
    })
    const reopened = applyPatch(degraded, {
      revision: 3,
      patch: { type: 'project.opened', project: shop }
    })
    expect(reopened.panes[tablet]).toEqual(failed)

    const switched = applyPatch(reopened, {
      revision: 4,
      patch: { type: 'project.opened', project: store }
    })
    expect(Object.keys(switched.panes)).toEqual(store.panes.map((pane) => pane.id))
  })

  it('ignores a status for a pane the open project does not have', () => {
    const open = applyPatch(nothingOpen, {
      revision: 1,
      patch: { type: 'project.opened', project: shop }
    })
    const next = applyPatch(open, {
      revision: 2,
      patch: { type: 'pane.status', pane: 'ghost', status: failed }
    })
    expect(next).toEqual({ ...open, revision: 2 })
  })

  it('replaces a changed pane in place and keeps what is observed of every pane', () => {
    const open = applyPatch(nothingOpen, {
      revision: 1,
      patch: { type: 'project.opened', project: shop }
    })
    const degraded = applyPatch(open, {
      revision: 2,
      patch: { type: 'pane.status', pane: tablet, status: failed }
    })
    const dark = { ...shop.panes[1], colorScheme: 'dark' as const }
    const next = applyPatch(degraded, { revision: 3, patch: { type: 'pane.changed', pane: dark } })

    expect(next.project?.panes).toEqual([shop.panes[0], dark, shop.panes[2]])
    expect(next.panes).toEqual(degraded.panes)
    expect(next.revision).toBe(3)
  })

  describe('a pane joining or leaving the set', () => {
    const open = applyPatch(nothingOpen, {
      revision: 1,
      patch: { type: 'project.opened', project: shop }
    })
    const degraded = applyPatch(open, {
      revision: 2,
      patch: { type: 'pane.status', pane: tablet, status: failed }
    })
    const added = { ...shop.panes[0], id: 'added', name: 'Laptop', width: 1280, height: 800 }

    it('inserts an added pane where it belongs, with a fresh status', () => {
      const next = applyPatch(degraded, {
        revision: 3,
        patch: { type: 'pane.added', pane: added, index: 1 }
      })

      expect(next.project?.panes.map((pane) => pane.id)).toEqual([mobile, 'added', tablet, desktop])
      expect(next.panes).toEqual({ ...degraded.panes, added: initialPaneStatus() })
      expect(next.revision).toBe(3)
    })

    it('appends an added pane whose index is past the end', () => {
      const next = applyPatch(degraded, {
        revision: 3,
        patch: { type: 'pane.added', pane: added, index: 99 }
      })
      expect(next.project?.panes.map((pane) => pane.id)).toEqual([mobile, tablet, desktop, 'added'])
    })

    it('drops a removed pane and forgets what was observed of it, leaving the rest untouched', () => {
      const next = applyPatch(degraded, {
        revision: 3,
        patch: { type: 'pane.removed', pane: mobile }
      })

      expect(next.project?.panes).toEqual([shop.panes[1], shop.panes[2]])
      expect(next.panes).toEqual({ [tablet]: failed, [desktop]: initialPaneStatus() })
      expect(next.revision).toBe(3)
    })

    it('ignores an add or a remove with nothing open, and a remove of a pane that is not there', () => {
      expect(
        applyPatch(nothingOpen, {
          revision: 1,
          patch: { type: 'pane.added', pane: added, index: 0 }
        })
      ).toEqual({ ...nothingOpen, revision: 1 })
      expect(
        applyPatch(nothingOpen, { revision: 1, patch: { type: 'pane.removed', pane: mobile } })
      ).toEqual({ ...nothingOpen, revision: 1 })
      expect(
        applyPatch(degraded, { revision: 3, patch: { type: 'pane.removed', pane: 'ghost' } })
      ).toEqual({ ...degraded, revision: 3 })
    })

    it('ignores an add of a pane the project already has, so a replayed patch cannot double it', () => {
      const next = applyPatch(degraded, {
        revision: 3,
        patch: { type: 'pane.added', pane: shop.panes[0], index: 0 }
      })
      expect(next).toEqual({ ...degraded, revision: 3 })
    })
  })

  it('ignores a change to a pane the open project does not have', () => {
    const open = applyPatch(nothingOpen, {
      revision: 1,
      patch: { type: 'project.opened', project: shop }
    })
    const ghost = { ...shop.panes[0], id: 'ghost' }
    expect(applyPatch(open, { revision: 2, patch: { type: 'pane.changed', pane: ghost } })).toEqual(
      {
        ...open,
        revision: 2
      }
    )
    expect(
      applyPatch(nothingOpen, { revision: 1, patch: { type: 'pane.changed', pane: ghost } })
    ).toEqual({ ...nothingOpen, revision: 1 })
  })
})
