import { expectTypeOf, it } from 'vitest'
import type { BreakpointBridge } from './ipc'
import type { RouteResponse, RouteSuccess } from './protocol'
import type { RouteName } from './routes'
import type { StateSnapshot } from './state'

// Declared and never called: the only way to pin the bridge's generic to one route.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const invoke: BreakpointBridge['invoke']
type Invoked<N extends RouteName> = ReturnType<typeof invoke<N>>

it('preserves route payloads while raw transport responses remain unknown', () => {
  expectTypeOf<Invoked<'app.quit'>>().toEqualTypeOf<Promise<RouteResponse<{ quitting: true }>>>()
  expectTypeOf<Invoked<'project.state'>>().toEqualTypeOf<Promise<RouteResponse<StateSnapshot>>>()
  expectTypeOf<Invoked<'project.open'>>().toEqualTypeOf<Promise<RouteResponse<StateSnapshot>>>()
  expectTypeOf<RouteSuccess['data']>().toBeUnknown()
})
