/**
 * What a pane may be pointed at, and what the address bar makes of what was typed.
 *
 * Pure: every surface — the address bar, the CLI's `open`, the route's own parser —
 * reaches the same answer from the same function, so `3000` means one thing wherever it
 * is typed.
 */

export function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const url = URL.parse(value)
  return url?.protocol === 'http:' || url?.protocol === 'https:'
}

/**
 * A bare port, or a leading-colon port: `3000` and `:3000` both mean localhost. Any
 * run of digits is read this way, so an out-of-range one is refused as the port it
 * obviously is rather than reinterpreted as a host — `123456` is not an address.
 */
const BARE_PORT = /^:?(\d+)$/

/** A URI scheme, distinguished from a host followed by a numeric port. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
// These must never be reinterpreted as a single-label host with a numeric port.
const NON_WEB_SCHEME = /^(?:about|blob|breakpoint|data|file|ftp|javascript|mailto):/i
const HOST_WITH_PORT = /^[^/?#]+:\d+(?:[/?#]|$)/

/** Every IPv4 address in `127.0.0.0/8`, which is the whole of it, not just `127.0.0.1`. */
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const LOOPBACK_IPV6: ReadonlySet<string> = new Set(['::1', '0:0:0:0:0:0:0:1'])

/**
 * Whether a host is this machine. Asked by two features that are asking the same thing:
 * which scheme an address typed without one gets, and whether a certificate is a dev
 * server's and so never worth asking about ([ADR-0012]). Written once so the two can
 * never drift into disagreeing about what `127.0.0.2` is.
 *
 * `host` is a URL's `hostname`, so an IPv6 address may arrive inside its brackets.
 */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  return LOOPBACK_IPV4.test(name) || LOOPBACK_IPV6.has(name)
}

/**
 * What the developer typed, as a URL a pane can be sent to, or nothing if it is not one.
 *
 * Three rules, in this order:
 *
 * - A bare port is the dev server on this machine: `3000` and `:3000` are both
 *   `http://localhost:3000/`, which is what makes starting work two keystrokes (PRD N1).
 * - Anything carrying a scheme keeps it, and is refused unless it is http or https —
 *   `file:`, `data:` and `javascript:` are not pages a pane renders.
 * - Anything else is a host, and gets `http://` when that host is this machine and
 *   `https://` when it is not. A LAN address on a plain port is the one case that has
 *   to be typed with its scheme, which is a smaller cost than guessing http for
 *   everything and sending a logged-in session over the wire in clear.
 */
export function expandUrl(typed: string): string | undefined {
  const value = typed.trim()
  if (value === '') return undefined

  const port = BARE_PORT.exec(value)
  if (port) {
    const number = Number(port[1])
    if (number < 1 || number > 65_535) return undefined
    return new URL(`http://localhost:${number}`).href
  }

  if (NON_WEB_SCHEME.test(value)) return undefined
  if (SCHEME.test(value) && !HOST_WITH_PORT.test(value)) {
    return isWebUrl(value) ? new URL(value).href : undefined
  }

  // A leading slash is a path with no host. `URL` tolerates the extra slashes and reads
  // the first segment as the host, which would turn `/checkout` into a site.
  if (value.startsWith('/')) return undefined

  const local = URL.parse(`http://${value}`)
  if (local === null || local.hostname === '') return undefined
  if (isLoopbackHost(local.hostname)) return local.href
  const secure = URL.parse(`https://${value}`)
  return secure?.hostname === local.hostname ? secure.href : undefined
}

/** The origin a URL belongs to, or nothing if it is not a page a pane can render. */
export function originOf(value: string): string | undefined {
  const url = URL.parse(value)
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined
  return url.origin
}

/**
 * Whether a URL is inside a project's allowed origins. Both sides are reduced to an
 * origin first, so a list written with paths still matches and an entry that is not a
 * web URL at all matches nothing ([ADR-0013]).
 */
export function isOriginAllowed(url: string, allowedOrigins: readonly string[]): boolean {
  const origin = originOf(url)
  if (origin === undefined) return false
  return allowedOrigins.some((allowed) => originOf(allowed) === origin)
}

/**
 * The stored form of an edited allow-list: each entry reduced to its origin, in the
 * order given, without repeats. Nothing if any entry is not a web URL — a list with a
 * typo in it would otherwise be saved as a rule that quietly matches nothing.
 */
export function normaliseOrigins(values: readonly string[]): string[] | undefined {
  const origins: string[] = []
  for (const value of values) {
    const origin = originOf(value.trim())
    if (origin === undefined) return undefined
    if (!origins.includes(origin)) origins.push(origin)
  }
  return origins
}

/** Whether two allow-lists say the same thing. Order counts: it is the order shown. */
export function sameOrigins(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && before.every((origin, index) => origin === after[index])
}
