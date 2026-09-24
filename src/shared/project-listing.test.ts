import { describe, expect, it } from 'vitest'
import {
  compareProjectListings,
  projectListingLabel,
  salvageProjectIdentity,
  repoPathParent,
  shortenRepoPath,
  type ProjectListing
} from './project-listing'

describe('salvageProjectIdentity', () => {
  it('reads the name and repo path off a file that will not load as a project', () => {
    const raw = {
      version: 99,
      project: { name: 'shop', repoPath: '/code/shop', panes: 'nonsense' }
    }

    expect(salvageProjectIdentity(raw)).toEqual({ name: 'shop', repoPath: '/code/shop' })
  })

  it('reports nothing legible rather than guessing', () => {
    expect(salvageProjectIdentity({ project: { name: 7, repoPath: null } })).toEqual({
      name: null,
      repoPath: null
    })
    expect(salvageProjectIdentity({ project: 'not a project' })).toEqual({
      name: null,
      repoPath: null
    })
    expect(salvageProjectIdentity(undefined)).toEqual({ name: null, repoPath: null })
    expect(salvageProjectIdentity([])).toEqual({ name: null, repoPath: null })
  })
})

describe('repoPathParent', () => {
  it('is the segment above the directory, with its separator: what tells worktrees apart', () => {
    expect(repoPathParent('/Users/dev/code/breakpoint/feature-19-switcher')).toBe('breakpoint/')
    expect(repoPathParent('C:\\code\\breakpoint\\main')).toBe('breakpoint\\')
  })

  it('is null for a path with nothing above the directory', () => {
    expect(repoPathParent('/shop')).toBeNull()
    expect(repoPathParent('/')).toBeNull()
  })
})

describe('shortenRepoPath', () => {
  it('keeps the directory and the one above it, so two worktrees of a repo read apart', () => {
    expect(shortenRepoPath('/Users/dev/code/breakpoint/feature-19-switcher')).toBe(
      'breakpoint/feature-19-switcher'
    )
    expect(shortenRepoPath('/Users/dev/code/breakpoint/main')).toBe('breakpoint/main')
  })

  it('keeps a Windows path spelled the way it arrived', () => {
    expect(shortenRepoPath('C:\\code\\breakpoint\\main')).toBe('breakpoint\\main')
  })

  it('leaves a path with nothing above it, and one with no segments at all, as it is', () => {
    expect(shortenRepoPath('/shop')).toBe('shop')
    expect(shortenRepoPath('/')).toBe('/')
  })
})

describe('what the switcher lists an entry as', () => {
  const openable = (repoPath: string, file: string): ProjectListing => ({
    file,
    openable: true,
    name: repoPath.split('/').pop() ?? repoPath,
    repoPath
  })

  it('is the repo path shortened, not the stored name on its own', () => {
    expect(projectListingLabel(openable('/code/breakpoint/main', 'a.json'))).toBe('breakpoint/main')
  })

  it('falls back to the name, and then to the file, as a refused file loses each', () => {
    const refused = {
      file: 'b.json',
      openable: false,
      reason: 'corrupt',
      message: 'the file is not JSON'
    } as const

    expect(projectListingLabel({ ...refused, name: 'shop', repoPath: '/code/shop' })).toBe(
      'code/shop'
    )
    expect(projectListingLabel({ ...refused, name: 'shop', repoPath: null })).toBe('shop')
    expect(projectListingLabel({ ...refused, name: null, repoPath: null })).toBe('b.json')
  })
})

describe('the order the switcher lists projects in', () => {
  const openable = (repoPath: string, file: string): ProjectListing => ({
    file,
    openable: true,
    name: repoPath.split('/').pop() ?? repoPath,
    repoPath
  })

  it('orders by what is drawn, whatever case it was typed in', () => {
    const listings = [openable('/code/shop', 'c.json'), openable('/code/Admin', 'a.json')]

    expect([...listings].sort(compareProjectListings).map(projectListingLabel)).toEqual([
      'code/Admin',
      'code/shop'
    ])
  })

  it('lists an entry with nothing legible under its file name', () => {
    const unopenable: ProjectListing = {
      file: 'b.json',
      openable: false,
      name: null,
      repoPath: null,
      reason: 'corrupt',
      message: 'the file is not JSON'
    }

    expect(
      [openable('/a/c', 'c.json'), unopenable, openable('/a/a', 'a.json')]
        .sort(compareProjectListings)
        .map(projectListingLabel)
    ).toEqual(['a/a', 'a/c', 'b.json'])
  })

  it('breaks a tie on the file, so two projects of one label hold their order', () => {
    const listings = [openable('/code/shop', 'ff.json'), openable('/code/shop', '11.json')]

    expect([...listings].sort(compareProjectListings).map((listing) => listing.file)).toEqual([
      '11.json',
      'ff.json'
    ])
  })
})
