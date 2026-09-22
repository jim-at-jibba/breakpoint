import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createProject } from '../shared/project'
import { StateFeed } from './state-feed'
import { PaneHost } from './pane-host'
import type { PaneService } from './services/pane-service'

describe('pane navigation', () => {
  it('catches up a guest that attaches after the project was navigated', async () => {
    const project = createProject('/repos/shop')
    const [pane] = project.panes
    const feed = new StateFeed()
    const panes = {
      has: (id: string) => id === pane.id,
      list: () => ({ panes: [{ id: pane.id }] }),
      guestCreated: vi.fn(),
      attachFailed: vi.fn()
    } as unknown as PaneService
    const host = new PaneHost(panes, feed)
    const target = 'http://localhost:3000/checkout'

    feed.publish({ type: 'project.opened', project })
    feed.publish({ type: 'project.url', url: target })

    const loadURL = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined)
    const guest = Object.assign(new EventEmitter(), {
      debugger: {
        attach: vi.fn(() => {
          throw new Error('attachment unavailable in this test')
        })
      },
      getURL: () => project.startUrl,
      isDestroyed: () => false,
      loadURL
    }) as unknown as WebContents
    const bind = Reflect.get(host, 'bind') as (binding: {
      pane: string
      guest: WebContents
      src: string
    }) => void

    bind.call(host, { pane: pane.id, guest, src: project.startUrl })

    await vi.waitFor(() => expect(loadURL).toHaveBeenCalledWith(target))
  })

  it('leaves a missed navigation for the current guest when an older guest finishes attaching', async () => {
    const project = createProject('/repos/shop')
    const [pane] = project.panes
    const feed = new StateFeed()
    const panes = {
      has: (id: string) => id === pane.id,
      list: () => ({ panes: [{ id: pane.id }] }),
      guestCreated: vi.fn(),
      attachFailed: vi.fn()
    } as unknown as PaneService
    const host = new PaneHost(panes, feed)
    const target = 'http://localhost:3000/checkout'
    const bind = Reflect.get(host, 'bind') as (binding: {
      pane: string
      guest: WebContents
      src: string
    }) => void
    const guest = (): { contents: WebContents; loadURL: ReturnType<typeof vi.fn> } => {
      const loadURL = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined)
      const contents = Object.assign(new EventEmitter(), {
        debugger: {
          attach: vi.fn(() => {
            throw new Error('attachment unavailable in this test')
          })
        },
        getURL: () => project.startUrl,
        isDestroyed: () => false,
        loadURL
      }) as unknown as WebContents
      return { contents, loadURL }
    }

    feed.publish({ type: 'project.opened', project })
    feed.publish({ type: 'project.url', url: target })
    const older = guest()
    const current = guest()
    bind.call(host, { pane: pane.id, guest: older.contents, src: project.startUrl })
    bind.call(host, { pane: pane.id, guest: current.contents, src: project.startUrl })

    await vi.waitFor(() => expect(current.loadURL).toHaveBeenCalledWith(target))
    expect(older.loadURL).not.toHaveBeenCalled()
  })
})
