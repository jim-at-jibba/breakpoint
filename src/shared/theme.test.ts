import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { APP_THEME_BACKGROUND, isThemePreference, resolveAppTheme, type AppTheme } from './theme'

describe('resolving the app theme', () => {
  test('an override is the answer, whatever the desktop is set to', () => {
    expect(resolveAppTheme('dark', 'light')).toBe('dark')
    expect(resolveAppTheme('light', 'dark')).toBe('light')
  })

  test('system is the desktop', () => {
    expect(resolveAppTheme('system', 'light')).toBe('light')
    expect(resolveAppTheme('system', 'dark')).toBe('dark')
  })

  test('is three preferences and no more', () => {
    expect(['system', 'light', 'dark'].every(isThemePreference)).toBe(true)
    // A pane's colour scheme spells two of them the same way; nothing else does.
    expect(['auto', 'Dark', '', 'no-preference'].some(isThemePreference)).toBe(false)
  })
})

/**
 * The window's background colour is a hex string because a `BrowserWindow` takes one,
 * but it is `--bp-chrome` all the same. Both stylesheets are read: the design prototype's
 * `globals.css` is the source of truth (AGENTS.md) and the renderer's `index.css` is
 * mirrored from it, so the window drifting from either is a failure here rather than a
 * launch nobody notices is the wrong colour.
 */
describe('the window background and the design tokens', () => {
  const stylesheets = {
    'the design prototype': '../../docs/design/breakpoint-prototype/globals.css',
    'the renderer': '../renderer/src/index.css'
  } as const

  /** Where each theme's block starts, as either stylesheet opens it. */
  const OPENERS: Readonly<Record<AppTheme, readonly string[]>> = {
    dark: [':root,\n.dark {', '.dark {', ':root {'],
    light: ['.light {']
  }

  test.each(
    Object.entries(stylesheets).flatMap(([where, path]) =>
      (['dark', 'light'] as const).map((theme) => [where, path, theme] as const)
    )
  )('agree with %s for the %s theme', (_where, path, theme) => {
    const css = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    const opener = OPENERS[theme].find((candidate) => css.includes(candidate))
    expect(opener, `a ${theme} block`).toBeDefined()
    const block = css.slice(css.indexOf(opener!))

    const declared = /--bp-chrome:\s*([^;]+);/.exec(block)
    expect(declared, `--bp-chrome is declared in the ${theme} block`).not.toBeNull()
    expect(declared![1].trim()).toBe(APP_THEME_BACKGROUND[theme])
  })
})
