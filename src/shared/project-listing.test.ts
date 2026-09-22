import { describe, expect, it } from 'vitest'
import {
  compareProjectListings,
  projectListingLabel,
  salvageProjectIdentity,
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

describe('the order the switcher lists projects in', () => {
  const openable = (name: string, file: string): ProjectListing => ({
    file,
    openable: true,
    name,
    repoPath: `/code/${name}`
  })

  it('orders by name, whatever case it was typed in', () => {
    const listings = [openable('shop', 'c.json'), openable('Admin', 'a.json')]

    expect([...listings].sort(compareProjectListings).map((listing) => listing.name)).toEqual([
      'Admin',
      'shop'
    ])
  })

  it('lists an entry with no legible name under its file name', () => {
    const unopenable: ProjectListing = {
      file: 'b.json',
      openable: false,
      name: null,
      repoPath: null,
      reason: 'corrupt',
      message: 'the file is not JSON'
    }

    expect(projectListingLabel(unopenable)).toBe('b.json')
    expect(
      [openable('c', 'c.json'), unopenable, openable('a', 'a.json')]
        .sort(compareProjectListings)
        .map(projectListingLabel)
    ).toEqual(['a', 'b.json', 'c'])
  })

  it('breaks a tie on the file, so two projects of one name hold their order', () => {
    const listings = [openable('shop', 'ff.json'), openable('shop', '11.json')]

    expect([...listings].sort(compareProjectListings).map((listing) => listing.file)).toEqual([
      '11.json',
      'ff.json'
    ])
  })
})
