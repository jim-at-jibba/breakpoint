import { describe, expect, it } from 'vitest'
import { createProject } from '../../shared/project'
import type { PatchBatch } from '../../shared/state'
import { StateFeed } from '../state-feed'
import { createPatchAdapter } from './patches'

const shop = createProject('/repos/shop')
const store = createProject('/repos/store')

function harness(): {
  feed: StateFeed
  sent: PatchBatch[]
  frame(): void
  scheduled(): number
  close(): void
} {
  const feed = new StateFeed()
  const sent: PatchBatch[] = []
  const frames: Array<() => void> = []
  const adapter = createPatchAdapter(feed, {
    send: (batch) => sent.push(batch),
    schedule: (flush) => frames.push(flush)
  })
  return {
    feed,
    sent,
    frame: () => frames.splice(0).forEach((flush) => flush()),
    scheduled: () => frames.length,
    close: adapter.close
  }
}

describe('the patch adapter', () => {
  it('ships every patch published within one frame as one numbered batch, in order', () => {
    const { feed, sent, frame, scheduled } = harness()

    feed.publish({ type: 'project.opened', project: shop })
    feed.publish({ type: 'project.opened', project: store })
    expect(sent).toEqual([])
    expect(scheduled()).toBe(1)

    frame()
    expect(sent).toEqual([
      [
        { revision: 1, patch: { type: 'project.opened', project: shop } },
        { revision: 2, patch: { type: 'project.opened', project: store } }
      ]
    ])
    expect(feed.revision).toBe(2)
  })

  it('schedules nothing while idle and a new frame once something is published again', () => {
    const { feed, sent, frame, scheduled } = harness()
    frame()
    expect(scheduled()).toBe(0)
    expect(sent).toEqual([])

    feed.publish({ type: 'project.opened', project: shop })
    frame()
    feed.publish({ type: 'project.opened', project: store })
    expect(scheduled()).toBe(1)
    frame()
    expect(sent.map((batch) => batch.map((entry) => entry.revision))).toEqual([[1], [2]])
  })

  it('sends nothing after it is closed', () => {
    const { feed, sent, frame, close } = harness()
    feed.publish({ type: 'project.opened', project: shop })
    close()
    frame()
    expect(sent).toEqual([])
  })
})
