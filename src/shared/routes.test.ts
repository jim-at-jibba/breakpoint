import { describe, expect, expectTypeOf, it } from 'vitest'
import { isRouteName, ROUTE_NAME_PATTERN, ROUTE_NAMES, type RouteParams } from './routes'

describe('the route table', () => {
  it('expresses pane creation and resize invariants in the route types', () => {
    expectTypeOf<{ preset: string }>().toMatchTypeOf<RouteParams<'panes.add'>>()
    expectTypeOf<{ width: number; height: number }>().toMatchTypeOf<RouteParams<'panes.add'>>()
    expectTypeOf<{
      preset: string
      width: number
      height: number
    }>().not.toMatchTypeOf<RouteParams<'panes.add'>>()
    expectTypeOf<{ pane: string }>().not.toMatchTypeOf<RouteParams<'panes.resize'>>()
    expectTypeOf<{ pane: string; width: number }>().toMatchTypeOf<RouteParams<'panes.resize'>>()
    expectTypeOf<{ pane: string; height: number }>().toMatchTypeOf<RouteParams<'panes.resize'>>()
  })

  it('names every route as a dotted noun.verb', () => {
    for (const name of ROUTE_NAMES) {
      expect(name, `${name} is not noun.verb`).toMatch(ROUTE_NAME_PATTERN)
    }
  })

  it('declares each name once', () => {
    expect(new Set(ROUTE_NAMES).size).toBe(ROUTE_NAMES.length)
  })

  it('holds app.quit, the one route Phase 1 starts with', () => {
    expect(ROUTE_NAMES).toContain('app.quit')
  })
})

describe('isRouteName', () => {
  it('accepts a declared name', () => {
    expect(isRouteName('app.quit')).toBe(true)
  })

  it('rejects an undeclared name, however well formed', () => {
    expect(isRouteName('app.explode')).toBe(false)
  })

  it('rejects a non-string', () => {
    expect(isRouteName(undefined)).toBe(false)
    expect(isRouteName(7)).toBe(false)
  })
})
