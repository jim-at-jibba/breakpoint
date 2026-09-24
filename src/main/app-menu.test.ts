import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

// The menu is a template handed to Electron, so the template is what there is to assert
// on: `Menu.buildFromTemplate` here answers with the template it was given.
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => template,
    setApplicationMenu: vi.fn()
  }
}))

import { buildAppMenu, SWITCH_PROJECT_ACCELERATOR, SWITCH_PROJECT_ITEM } from './app-menu'

type Template = MenuItemConstructorOptions[]

function menu(platform: string): Template {
  return buildAppMenu({ showSwitcher: () => undefined }, platform) as unknown as Template
}

/** Every item the menu has, at any depth, so an accelerator cannot hide in a submenu. */
function items(template: Template): MenuItemConstructorOptions[] {
  return template.flatMap((item) => {
    const submenu = Array.isArray(item.submenu) ? items(item.submenu as Template) : []
    return [item, ...submenu]
  })
}

function accelerators(template: Template): string[] {
  return items(template)
    .map((item) => item.accelerator)
    .filter((accelerator): accelerator is string => accelerator !== undefined)
}

function switchProject(template: Template): MenuItemConstructorOptions {
  const item = items(template).find((candidate) => candidate.id === SWITCH_PROJECT_ITEM)
  if (!item) throw new Error('the menu has no Switch Project item')
  return item
}

describe.each(['darwin', 'win32', 'linux'])('the application menu on %s', (platform) => {
  const template = menu(platform)

  /**
   * The shortcut is bound here and nowhere else (#38). A pane is an out-of-process
   * `<webview>`, so a `keydown` listener in the renderer is deaf whenever one has focus;
   * a menu accelerator answers wherever focus is.
   */
  it('binds the switcher to one chord per platform, never both', () => {
    expect(switchProject(template).accelerator).toBe(SWITCH_PROJECT_ACCELERATOR)
    // `CommandOrControl` is ⌘ on macOS and Ctrl everywhere else, which is the rule:
    // Control-P is emacs' "previous line" in every text field on macOS.
    expect(SWITCH_PROJECT_ACCELERATOR).toBe('CommandOrControl+P')
    expect(accelerators(template).filter((chord) => chord.endsWith('+P'))).toHaveLength(1)
  })

  it('causes the switcher and nothing else when the item is chosen', () => {
    const showSwitcher = vi.fn()
    const built = buildAppMenu({ showSwitcher }, platform) as unknown as Template

    switchProject(built).click?.(undefined as never, undefined as never, undefined as never)

    expect(showSwitcher).toHaveBeenCalledOnce()
  })

  // ⌘P is the switcher's. A Print item would want the same key, and nothing in a dev
  // browser prints.
  it('does not resurrect ⌘P as Print', () => {
    expect(items(template).map((item) => item.role)).not.toContain('print')
    expect(items(template).map((item) => item.label)).not.toContain('Print…')
  })

  /**
   * A key this menu claims is a key the panes never see, so the menu claims only keys a
   * page could not reasonably want. The clipboard and history chords are here as
   * `role`s, which act on whichever `webContents` has focus — a pane included — so a
   * pane is not deprived of them by their being listed.
   */
  it('takes no chord a page would want', () => {
    const reserved = new Set([
      SWITCH_PROJECT_ACCELERATOR,
      'CommandOrControl+Q',
      'CommandOrControl+W',
      'CommandOrControl+M',
      'CommandOrControl+H',
      'Alt+F4'
    ])
    const claimed = accelerators(template).filter((chord) => !reserved.has(chord))

    for (const chord of claimed) {
      // Everything else in the menu is a role, whose accelerator Electron fills in, and
      // roles are delivered to the focused webContents rather than intercepted.
      expect(chord).toMatch(/^(CommandOrControl|Command|Control)\+(Shift\+)?[A-Z]$/)
    }
    // Nothing reloads the host window: the default menu's ⌘R throws away the app's own
    // renderer rather than reloading a page. A pane reloads as a pane.
    expect(items(template).map((item) => item.role)).not.toContain('reload')
    expect(items(template).map((item) => item.role)).not.toContain('forceReload')
  })

  it('keeps Edit as roles, so ⌘C and ⌘V reach whichever pane has focus', () => {
    expect(template.map((item) => item.role)).toContain('editMenu')
  })
})

describe('the application menu across platforms', () => {
  it('puts Quit under the app menu on macOS and under File elsewhere', () => {
    expect(menu('darwin').map((item) => item.role)).toContain('appMenu')
    expect(items(menu('darwin')).map((item) => item.role)).toContain('close')

    expect(menu('linux').map((item) => item.role)).not.toContain('appMenu')
    expect(items(menu('linux')).map((item) => item.role)).toContain('quit')
  })
})
