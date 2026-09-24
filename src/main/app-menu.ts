import { Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * The application menu, and the only place an app-wide keyboard shortcut is bound.
 *
 * A pane is an out-of-process `<webview>`, so once one has focus — which is nearly
 * always, because looking at pages is what the app is for — key events go to the guest's
 * `webContents` and never reach the host document. A shortcut bound with
 * `window.addEventListener('keydown')` is therefore dead in normal use (#38). A menu
 * accelerator is not: the native menu answers before any `webContents` sees the key, so
 * it fires wherever focus is.
 *
 * That makes this the seam for every shortcut the app grows, rather than a fix to one
 * call site. It is also the menu a shipped app needs anyway — the app ran on Electron's
 * default until now.
 *
 * What the menu deliberately does not have:
 *
 * - **Print.** ⌘P is the switcher, and a Print item would want the same key. Nothing in
 *   a dev browser prints.
 * - **View.** The default menu's ⌘R reloads the *host window*, which throws the whole
 *   app's renderer away rather than reloading a page. A pane reloads as a pane.
 * - **Anything with a bare or single-modifier letter beyond the standard clipboard set.**
 *   Every accelerator here is one a page could not reasonably want, because a key this
 *   menu claims is a key the panes never see.
 *
 * Edit is kept, and kept as roles: `role` sends the action to whichever `webContents`
 * has focus, so ⌘C and ⌘V work inside a pane exactly as they work in the address bar.
 */

export interface AppMenuActions {
  /** Show the project switcher. The route the toolbar button causes ([ADR-0005]). */
  showSwitcher(): void
}

/** The switcher's item, found by id so a test can assert what the chord is bound to. */
export const SWITCH_PROJECT_ITEM = 'switch-project'

/**
 * One modifier per platform and never both: `CommandOrControl` is ⌘ on macOS and Ctrl
 * everywhere else. Control-P is emacs' "previous line" in every text field on macOS, and
 * taking it there would cost the address bar a binding the developer already has.
 */
export const SWITCH_PROJECT_ACCELERATOR = 'CommandOrControl+P'

export function buildAppMenu(actions: AppMenuActions, platform: string = process.platform): Menu {
  const mac = platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    // The macOS application menu: About, Services, Hide and Quit, where a macOS
    // developer reaches for them. Elsewhere Quit lives under File, below.
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: mac ? 'File' : '&File',
      submenu: [
        {
          id: SWITCH_PROJECT_ITEM,
          label: 'Switch Project…',
          accelerator: SWITCH_PROJECT_ACCELERATOR,
          click: () => actions.showSwitcher()
        },
        { type: 'separator' as const },
        // Closing the window is not quitting on macOS, where the app stays alive with no
        // window and `app.focus` opens one again.
        mac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    // Roles, so each one acts on whichever webContents has focus — a pane included.
    { role: 'editMenu' as const },
    ...(mac ? [{ role: 'windowMenu' as const }] : [])
  ]
  return Menu.buildFromTemplate(template)
}

/** Sets the menu for the whole application, which is what makes its accelerators global. */
export function installAppMenu(actions: AppMenuActions): Menu {
  const menu = buildAppMenu(actions)
  Menu.setApplicationMenu(menu)
  return menu
}
