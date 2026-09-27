import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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

describe("a pane's console", () => {
  // Emulation claims the Chromium that renders, and under Node there is none.
  beforeAll(() => {
    Reflect.set(process.versions, 'chrome', '140.0.7339.0')
  })
  afterAll(() => {
    Reflect.deleteProperty(process.versions, 'chrome')
  })

  interface AttachedGuest {
    guest: WebContents
    attachment: EventEmitter
    calls: string[]
    markDestroyed(): void
  }

  /** A guest whose attachment records what was asked of it, in order, and can be spoken over. */
  function attachedGuest(
    refuse: (method: string) => boolean = () => false,
    beforeAnswer: (method: string) => Promise<void> = async () => undefined
  ): AttachedGuest {
    const calls: string[] = []
    let destroyed = false
    const attachment = Object.assign(new EventEmitter(), {
      attach: vi.fn(),
      sendCommand: vi.fn(async (method: string) => {
        calls.push(method)
        await beforeAnswer(method)
        if (refuse(method)) throw new Error(`${method} refused`)
        return {}
      })
    })
    const on = attachment.on.bind(attachment)
    vi.spyOn(attachment, 'on').mockImplementation((event, listener) => {
      if (event === 'message') calls.push('on message')
      return on(event, listener)
    })
    const guest = Object.assign(new EventEmitter(), {
      debugger: attachment,
      getURL: () => 'http://localhost:3000/',
      isDestroyed: () => destroyed,
      loadURL: vi.fn().mockResolvedValue(undefined)
    }) as unknown as WebContents
    return { guest, attachment, calls, markDestroyed: () => (destroyed = true) }
  }

  function hostFor(guest: WebContents): {
    pane: string
    panes: Record<'emulated' | 'console' | 'consoleFailed' | 'detached', ReturnType<typeof vi.fn>>
  } {
    const project = createProject('/repos/shop')
    const [pane] = project.panes
    const feed = new StateFeed()
    const panes = {
      has: (id: string) => id === pane.id,
      list: () => ({ panes: [{ id: pane.id }] }),
      paneFor: (id: string) => project.panes.find((candidate) => candidate.id === id),
      guestCreated: vi.fn(),
      attached: vi.fn(),
      attachFailed: vi.fn(),
      emulated: vi.fn(),
      guestDestroyed: vi.fn(),
      console: vi.fn(),
      consoleFailed: vi.fn(),
      detached: vi.fn()
    }
    const host = new PaneHost(panes as unknown as PaneService, feed)
    feed.publish({ type: 'project.opened', project })
    const bind = Reflect.get(host, 'bind') as (binding: {
      pane: string
      guest: WebContents
      src: string
    }) => void
    bind.call(host, { pane: pane.id, guest, src: project.startUrl })
    return { pane: pane.id, panes }
  }

  const call = {
    type: 'log',
    args: [{ type: 'string', value: 'hello' }],
    executionContextId: 1,
    timestamp: 0
  }

  it('listens, then enables Runtime and Log and nothing else, before any override is sent', async () => {
    const { guest, calls } = attachedGuest()
    const { panes } = hostFor(guest)
    await vi.waitFor(() => expect(panes.emulated).toHaveBeenCalled())

    const firstOverride = calls.findIndex((each) => each.startsWith('Emulation.'))
    expect(calls.slice(0, firstOverride)).toEqual(['on message', 'Runtime.enable', 'Log.enable'])
    expect(calls.filter((each) => each.endsWith('.enable'))).toEqual([
      'Runtime.enable',
      'Log.enable'
    ])
  })

  it('reports what it hears against the pane, even when every override is refused', async () => {
    const { guest, attachment } = attachedGuest((method) => method.startsWith('Emulation.'))
    const { pane, panes } = hostFor(guest)
    await vi.waitFor(() => expect(panes.emulated).toHaveBeenCalled())

    attachment.emit('message', {}, 'Runtime.consoleAPICalled', call)
    attachment.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 2 } })

    expect(panes.console).toHaveBeenCalledTimes(1)
    expect(panes.console).toHaveBeenCalledWith(
      pane,
      expect.objectContaining({ type: 'console.message', text: 'hello' }),
      // The page it was heard on, whose origin is the dev server resolution reads.
      'http://localhost:3000/'
    )
  })

  it('says so, rather than going quiet, when capture cannot be enabled', async () => {
    const { guest } = attachedGuest((method) => method === 'Log.enable')
    const { pane, panes } = hostFor(guest)
    await vi.waitFor(() => expect(panes.consoleFailed).toHaveBeenCalled())

    expect(panes.consoleFailed).toHaveBeenCalledTimes(1)
    expect(panes.consoleFailed).toHaveBeenCalledWith(pane, 'Log.enable: Log.enable refused')
  })

  it('stops listening and degrades a live pane when its attachment ends', async () => {
    const { guest, attachment } = attachedGuest()
    const { pane, panes } = hostFor(guest)
    await vi.waitFor(() => expect(panes.emulated).toHaveBeenCalled())

    attachment.emit('detach', {}, 'target closed')
    attachment.emit('message', {}, 'Runtime.consoleAPICalled', call)

    expect(attachment.listenerCount('message')).toBe(0)
    expect(panes.console).not.toHaveBeenCalled()
    expect(panes.detached).toHaveBeenCalledWith(pane, 'target closed')
  })

  it('cleans up without degrading when the target closed', async () => {
    const { guest, attachment, markDestroyed } = attachedGuest()
    const { panes } = hostFor(guest)
    await vi.waitFor(() => expect(panes.emulated).toHaveBeenCalled())

    markDestroyed()
    attachment.emit('detach', {}, 'target closed')

    expect(attachment.listenerCount('message')).toBe(0)
    expect(panes.detached).not.toHaveBeenCalled()
  })

  it('drops an emulation result that completes after detachment', async () => {
    let releaseOverrides = (): void => undefined
    const overridesReleased = new Promise<void>((resolve) => {
      releaseOverrides = resolve
    })
    const { guest, attachment, calls } = attachedGuest(
      () => false,
      (method) => (method.startsWith('Emulation.') ? overridesReleased : Promise.resolve())
    )
    const { panes } = hostFor(guest)
    await vi.waitFor(() =>
      expect(calls.filter((method) => method.startsWith('Emulation.'))).toHaveLength(4)
    )

    attachment.emit('detach', {}, 'target closed')
    releaseOverrides()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(panes.emulated).not.toHaveBeenCalled()
  })

  it('stops reporting for a guest the pane has replaced', async () => {
    const first = attachedGuest()
    const { panes } = hostFor(first.guest)
    await vi.waitFor(() => expect(panes.emulated).toHaveBeenCalled())

    first.guest.emit('destroyed')
    first.attachment.emit('message', {}, 'Runtime.consoleAPICalled', call)

    expect(panes.console).not.toHaveBeenCalled()
  })
})
