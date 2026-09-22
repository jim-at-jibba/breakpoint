import { describe, expect, it } from 'vitest'
import { expandUrl, isOriginAllowed, isWebUrl, normaliseOrigins, originOf } from './urls'

describe('pane URLs', () => {
  it.each(['http://localhost:3000', 'https://example.com/path?q=1#section', 'HTTPS://EXAMPLE.COM'])(
    'accepts %s',
    (url: string): void => {
      expect(isWebUrl(url)).toBe(true)
    }
  )

  it.each([
    undefined,
    null,
    {},
    '',
    '/relative',
    'http://',
    'file:///tmp/page.html',
    'data:text/html,test',
    'javascript:alert(1)',
    'about:blank',
    'blob:https://example.com/id',
    'breakpoint://open'
  ])('rejects %s', (url: unknown): void => {
    expect(isWebUrl(url)).toBe(false)
  })
})

describe('expandUrl', () => {
  it.each([
    ['3000', 'http://localhost:3000/'],
    [':3000', 'http://localhost:3000/'],
    ['  5173  ', 'http://localhost:5173/'],
    ['80', 'http://localhost/'],
    ['65535', 'http://localhost:65535/']
  ])('expands the bare port %s to %s', (typed: string, url: string) => {
    expect(expandUrl(typed)).toBe(url)
  })

  it.each(['0', '65536', '123456'])('refuses %s, which is not a port', (typed: string) => {
    expect(expandUrl(typed)).toBeUndefined()
  })

  it.each([
    ['http://localhost:3000', 'http://localhost:3000/'],
    ['https://example.com/docs?q=1#top', 'https://example.com/docs?q=1#top'],
    ['HTTP://LOCALHOST:3000/Path', 'http://localhost:3000/Path']
  ])('keeps the scheme in %s', (typed: string, url: string) => {
    expect(expandUrl(typed)).toBe(url)
  })

  it.each([
    'file:///tmp/page.html',
    'file:/tmp/page.html',
    'file:page.html',
    'file:123',
    'ftp://example.com/',
    'ftp:21',
    'mailto:user@example.com',
    'mailto:80',
    'data:text/html,test',
    'data:1',
    'javascript:alert(1)',
    'javascript:123',
    'about:blank',
    'blob:https://example.com/id'
  ])('refuses %s, which is not a page a pane renders', (typed: string) => {
    expect(expandUrl(typed)).toBeUndefined()
  })

  it.each([
    ['localhost:3000', 'http://localhost:3000/'],
    ['localhost:3000/checkout', 'http://localhost:3000/checkout'],
    ['127.0.0.1:5173', 'http://127.0.0.1:5173/'],
    ['[::1]:8080', 'http://[::1]:8080/'],
    ['shop.localhost:3000', 'http://shop.localhost:3000/']
  ])('sends the scheme-less local host %s over http', (typed: string, url: string) => {
    expect(expandUrl(typed)).toBe(url)
  })

  it.each([
    ['example.com', 'https://example.com/'],
    ['example.com:8443', 'https://example.com:8443/'],
    ['dev:3000', 'https://dev:3000/'],
    ['example.com/docs', 'https://example.com/docs'],
    ['staging.example.com/a?b=c', 'https://staging.example.com/a?b=c']
  ])('sends the scheme-less remote host %s over https', (typed: string, url: string) => {
    expect(expandUrl(typed)).toBe(url)
  })

  it.each(['', '   ', '/relative', 'no spaces here', 'http://'])(
    'refuses %j, which is not a URL at all',
    (typed: string) => {
      expect(expandUrl(typed)).toBeUndefined()
    }
  )

  it('is idempotent: expanding what it returned returns the same URL', () => {
    for (const typed of ['3000', 'localhost:3000/cart', 'example.com', 'https://example.com/a']) {
      const once = expandUrl(typed)!
      expect(expandUrl(once)).toBe(once)
    }
  })
})

describe('originOf', () => {
  it('reduces a URL to its origin', () => {
    expect(originOf('http://localhost:3000/checkout?q=1')).toBe('http://localhost:3000')
    expect(originOf('HTTPS://Example.COM/a')).toBe('https://example.com')
  })

  it('has no origin for anything that is not a web URL', () => {
    expect(originOf('file:///tmp/page.html')).toBeUndefined()
    expect(originOf('localhost:3000')).toBeUndefined()
    expect(originOf('')).toBeUndefined()
  })
})

describe('isOriginAllowed', () => {
  const allowed = ['http://localhost:3000', 'https://staging.example.com/ignored/path']

  it.each([
    'http://localhost:3000',
    'http://localhost:3000/checkout?q=1#top',
    'https://staging.example.com/anything'
  ])('allows %s', (url: string) => {
    expect(isOriginAllowed(url, allowed)).toBe(true)
  })

  it.each([
    ['http://localhost:3001/', 'a different port is a different origin'],
    ['https://localhost:3000/', 'a different scheme is a different origin'],
    ['http://evil.com/', 'an origin that is not in the list'],
    ['file:///tmp/page.html', 'not a web URL at all']
  ])('refuses %s: %s', (url: string) => {
    expect(isOriginAllowed(url, allowed)).toBe(false)
  })

  it('matches nothing when the list is empty, and ignores entries that are not URLs', () => {
    expect(isOriginAllowed('http://localhost:3000/', [])).toBe(false)
    expect(isOriginAllowed('http://localhost:3000/', ['localhost:3000', '*'])).toBe(false)
  })
})

describe('normaliseOrigins', () => {
  it('reduces each entry to its origin, keeps the order and drops repeats', () => {
    expect(
      normaliseOrigins([
        ' https://example.com/docs ',
        'http://localhost:3000',
        'https://example.com'
      ])
    ).toEqual(['https://example.com', 'http://localhost:3000'])
  })

  it('accepts an empty list, which allows nothing', () => {
    expect(normaliseOrigins([])).toEqual([])
  })

  it.each([['localhost:3000'], ['file:///tmp'], [''], ['  ']])(
    'refuses the whole list when %j is not a web URL',
    (entry: string) => {
      expect(normaliseOrigins(['http://localhost:3000', entry])).toBeUndefined()
    }
  )
})
