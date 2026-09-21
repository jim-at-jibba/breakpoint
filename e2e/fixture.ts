import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * The page the panes load in tests. Written for Phase 1 and deliberately not lifted
 * from the Phase 0 spike, which stays throwaway.
 *
 * Two loopback origins, `127.0.0.1` and `localhost` on different ports: different
 * hosts are different sites, so a navigation between them is genuinely cross-site and
 * swaps renderer process. Each serves the same page, which carries:
 *
 * - a hit target of a known size, `HIT_TARGET` CSS px, pinned to the bottom-left corner
 *   of the viewport, which is where a pane that is shorter than it claims stops being
 *   clickable. It counts its clicks in `data-hits`.
 * - hairline rules, 1 CSS px every `RULE_SPACING`, horizontal and vertical, so a pane
 *   drawn at the wrong scale shows doubled, missing or smeared lines.
 * - a `target=_blank` link and a button that calls `window.open`, both pointed at the
 *   other origin, for asserting that neither spawns a window.
 * - a second hit target, `#corner`, pinned to the bottom-right corner, which is only where
 *   the pane's edge is if the page laid out at the pane's declared width.
 * - an image offered at 1x, 2x and 3x through `srcset`, so the variant a pane asks the
 *   server for says which device pixel ratio it is rendering at.
 * - a swatch, `#scheme`, pinned top-right: `SCHEME_SWATCH.light` unless the page is told
 *   it prefers dark, then `SCHEME_SWATCH.dark`, for reading the scheme off the raster.
 *
 * Every request either origin answers is recorded with its headers, which is what a
 * server doing device detection would see.
 */

export const HIT_TARGET = 44
export const RULE_SPACING = 8
export const SWATCH = 40
export const SCHEME_SWATCH = { light: [255, 255, 255], dark: [0, 0, 0] } as const

export interface RecordedRequest {
  origin: string
  /** Path and query, as the request line carried it. */
  url: string
  headers: Record<string, string | string[] | undefined>
}

export interface Fixture {
  /** `http://127.0.0.1:<port>` */
  a: string
  /** `http://localhost:<port>`: a different site from `a`. */
  b: string
  requests(): RecordedRequest[]
  close(): Promise<void>
}

function page(origin: string, other: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fixture ${origin}</title>
<style>
  html, body { margin: 0; height: 100%; }
  body {
    font: 12px/1.4 system-ui, sans-serif;
    background-color: #fff;
    background-image:
      repeating-linear-gradient(to bottom, #000 0 1px, transparent 1px ${RULE_SPACING}px),
      repeating-linear-gradient(to right, #000 0 1px, transparent 1px ${RULE_SPACING}px);
  }
  main { background: #fff; padding: 8px; display: inline-block; }
  #scheme {
    position: fixed; right: 0; top: 0; width: ${SWATCH}px; height: ${SWATCH}px;
    background: rgb(${SCHEME_SWATCH.light.join(' ')});
  }
  @media (prefers-color-scheme: dark) {
    #scheme { background: rgb(${SCHEME_SWATCH.dark.join(' ')}); }
  }
  #corner {
    position: fixed; right: 0; bottom: 0;
    width: ${HIT_TARGET}px; height: ${HIT_TARGET}px;
    margin: 0; padding: 0; border: 0; box-sizing: border-box;
    background: #33d;
  }
  #target {
    position: fixed; left: 0; bottom: 0;
    width: ${HIT_TARGET}px; height: ${HIT_TARGET}px;
    margin: 0; padding: 0; border: 0; box-sizing: border-box;
    background: #d33;
  }
</style>
</head>
<body>
<main>
  <p id="origin">${origin}</p>
  <a id="blank" href="${other}/" target="_blank">other origin, new window</a>
  <button id="open" type="button" onclick="window.open('${other}/')">window.open</button>
  <input id="draft" aria-label="Draft">
  <img id="asset" alt="" width="16" height="16"
    src="/asset?x=1" srcset="/asset?x=1 1x, /asset?x=2 2x, /asset?x=3 3x">
</main>
<div id="scheme"></div>
<button id="corner" type="button" data-hits="0"
  onclick="this.dataset.hits = String(Number(this.dataset.hits) + 1)"></button>
<button id="target" type="button" data-hits="0"
  onclick="this.dataset.hits = String(Number(this.dataset.hits) + 1)"></button>
</body>
</html>
`
}

function asset(scale: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><text y="12">${scale}</text></svg>`
}

function serve(
  host: string,
  other: () => string,
  recorded: RecordedRequest[]
): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve, reject) => {
    let origin = ''
    const server = createServer((request, response) => {
      recorded.push({ origin, url: request.url ?? '/', headers: { ...request.headers } })
      if (request.url === '/favicon.ico') {
        response.writeHead(204).end()
        return
      }
      const target = new URL(request.url ?? '/', 'http://fixture')
      if (target.pathname === '/asset') {
        response.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' })
        response.end(asset(target.searchParams.get('x') ?? '?'))
        return
      }
      if (target.pathname === '/redirect') {
        response.writeHead(302, { location: target.searchParams.get('to') ?? '/' }).end()
        return
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      })
      response.end(page(origin, other()))
    })
    server.once('error', reject)
    // Dual-stack, so `localhost` answers whichever loopback address it resolves to.
    server.listen({ port: 0, host: '::', ipv6Only: false }, () => {
      origin = `http://${host}:${(server.address() as AddressInfo).port}`
      resolve({ server, origin })
    })
  })
}

export async function startFixture(): Promise<Fixture> {
  const origins = { a: '', b: '' }
  const recorded: RecordedRequest[] = []
  const a = await serve('127.0.0.1', () => origins.b, recorded)
  const b = await serve('localhost', () => origins.a, recorded)
  origins.a = a.origin
  origins.b = b.origin

  return {
    a: a.origin,
    b: b.origin,
    requests: () => [...recorded],
    close: async () => {
      for (const { server } of [a, b]) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  }
}
