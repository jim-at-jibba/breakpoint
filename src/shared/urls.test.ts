import { describe, expect, it } from 'vitest'
import { isWebUrl } from './urls'

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
