import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  PANE_HUES,
  PANE_PALETTE_SIZE,
  paneColor,
  paneColorIndex,
  paneColorToken,
  paneColorVar,
  type AppTheme
} from './pane-palette'

describe('the pane palette', () => {
  test('is ten colours separated by hue alone', () => {
    expect(PANE_PALETTE_SIZE).toBe(10)
    expect(new Set(PANE_HUES).size).toBe(10)

    for (const theme of ['light', 'dark'] as const) {
      const tones = new Set(
        Array.from({ length: PANE_PALETTE_SIZE }, (_, index) =>
          paneColor(index, theme).replace(/ \d+\)$/, ')')
        )
      )
      expect(tones.size).toBe(1)
    }
  })

  test('gives every pane in the set its own colour', () => {
    const colours = Array.from({ length: PANE_PALETTE_SIZE }, (_, index) =>
      paneColor(index, 'dark')
    )
    expect(new Set(colours).size).toBe(PANE_PALETTE_SIZE)
  })

  test('wraps rather than running out, so an eleventh pane has a colour', () => {
    expect(paneColorIndex(10)).toBe(0)
    expect(paneColorIndex(23)).toBe(3)
    expect(paneColorToken(10)).toBe('--bp-pane-1')
    expect(paneColor(10, 'dark')).toBe(paneColor(0, 'dark'))
  })

  test('treats a position before the first as a position, not a gap', () => {
    expect(paneColorIndex(-1)).toBe(9)
    expect(paneColorToken(-1)).toBe('--bp-pane-10')
  })

  test('names the token the window reads the colour off', () => {
    expect(paneColorToken(0)).toBe('--bp-pane-1')
    expect(paneColorToken(9)).toBe('--bp-pane-10')
    expect(paneColorVar(2)).toBe('var(--bp-pane-3)')
  })
})

/**
 * The formula and the tokens are two statements of one palette, and a screenshot whose
 * borders disagreed with the headers beside them would be worse than no border at all.
 * This is the only thing holding them together, so it reads the stylesheet rather than
 * trusting that someone updated both.
 */
describe('the generated palette and the design tokens', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../renderer/src/index.css', import.meta.url)),
    'utf8'
  )

  test.each([
    ['dark', ':root,\n.dark {'],
    ['light', '.light {']
  ] as const)('agree for the %s theme', (theme: AppTheme, opener) => {
    const block = css.slice(css.indexOf(opener))
    for (let index = 0; index < PANE_PALETTE_SIZE; index += 1) {
      const declared = new RegExp(`${paneColorToken(index)}:\\s*([^;]+);`).exec(block)
      expect(declared, `${paneColorToken(index)} is declared in the ${theme} block`).not.toBeNull()
      expect(declared![1].trim()).toBe(paneColor(index, theme))
    }
  })
})
