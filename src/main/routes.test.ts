import { describe, expect, it, vi } from 'vitest'
import type { Navigation, Surface } from '../shared/routes'
import { createDispatch, createRouteTable, type Dispatch, type Services } from './routes'

/**
 * The route table's own end of navigation: what it makes of the params, and that the
 * surface a call arrived from reaches the service. The service decides what to do with
 * that surface; this only proves it is told ([ADR-0013]).
 */

type Navigate = (url: string, surface: Surface) => Promise<Navigation>

interface Dispatcher {
  dispatch: Dispatch
  navigate: ReturnType<typeof vi.fn<Navigate>>
  setAllowedOrigins: ReturnType<typeof vi.fn>
}

/** The table over a project service that records what reached it and nothing more. */
function dispatcher(): Dispatcher {
  const navigate = vi.fn<Navigate>().mockResolvedValue({ url: 'http://localhost:3000/', panes: [] })
  const setAllowedOrigins = vi.fn().mockResolvedValue({ origins: [] })
  const project = { navigate, setAllowedOrigins }
  return {
    dispatch: createDispatch(createRouteTable({ project } as unknown as Services)),
    navigate,
    setAllowedOrigins
  }
}

describe('project.navigate', () => {
  it('expands what was typed before the service sees it', async () => {
    const { dispatch, navigate } = dispatcher()

    await dispatch(
      { id: '1', route: 'project.navigate', params: { url: '3000' } },
      { surface: 'cli' }
    )

    expect(navigate).toHaveBeenCalledWith('http://localhost:3000/', 'cli')
  })

  it('names the surface the call arrived from', async () => {
    const { dispatch, navigate } = dispatcher()

    await dispatch(
      { id: '1', route: 'project.navigate', params: { url: 'http://localhost:3000/' } },
      { surface: 'window' }
    )

    expect(navigate).toHaveBeenCalledWith('http://localhost:3000/', 'window')
  })

  it.each(['file:///tmp/page.html', 'javascript:alert(1)', '', '   ', '0', '/checkout'])(
    'refuses %j without reaching the service',
    async (url: string) => {
      const { dispatch, navigate } = dispatcher()

      const { response } = await dispatch(
        { id: '1', route: 'project.navigate', params: { url } },
        { surface: 'cli' }
      )

      expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
      expect(navigate).not.toHaveBeenCalled()
    }
  )

  it.each([
    [undefined, 'no params at all'],
    [{}, 'no url'],
    [{ url: 7 }, 'a url that is not a string'],
    [{ url: 'http://localhost:3000/', pane: 'a' }, 'a field the route does not take']
  ])('refuses %j: %s', async (params: unknown, why: string) => {
    const { dispatch } = dispatcher()

    const { response } = await dispatch(
      { id: '1', route: 'project.navigate', params },
      { surface: 'cli' }
    )

    expect(response, why).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
  })
})

describe('project.setAllowedOrigins', () => {
  it('hands the list to the service as given, for it to normalise', async () => {
    const { dispatch, setAllowedOrigins } = dispatcher()

    await dispatch(
      {
        id: '1',
        route: 'project.setAllowedOrigins',
        params: { origins: ['http://localhost:3000'] }
      },
      { surface: 'window' }
    )

    expect(setAllowedOrigins).toHaveBeenCalledWith(['http://localhost:3000'])
  })

  it.each([
    [{ origins: 'http://localhost:3000' }, 'a string rather than a list'],
    [{ origins: [7] }, 'a list of something other than strings'],
    [{ origins: [], url: 'a' }, 'a field the route does not take'],
    [undefined, 'no params at all']
  ])('refuses %j: %s', async (params: unknown, why: string) => {
    const { dispatch, setAllowedOrigins } = dispatcher()

    const { response } = await dispatch(
      { id: '1', route: 'project.setAllowedOrigins', params },
      { surface: 'window' }
    )

    expect(response, why).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    expect(setAllowedOrigins).not.toHaveBeenCalled()
  })
})
