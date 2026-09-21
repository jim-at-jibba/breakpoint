import { expectTypeOf, it } from 'vitest'
import type { BreakpointBridge } from './ipc'
import type { RouteResponse, RouteSuccess } from './protocol'

it('preserves route payloads while raw transport responses remain unknown', () => {
  expectTypeOf<ReturnType<BreakpointBridge['invoke']>>().toEqualTypeOf<
    Promise<RouteResponse<{ quitting: true }>>
  >()
  expectTypeOf<RouteSuccess['data']>().toBeUnknown()
})
