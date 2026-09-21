import { app, shell, BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  APP_NAME,
  currentPathEnvironment,
  resolveSocketPath,
  resolveUserDataDir
} from '../shared/paths'
import { registerIpcAdapter } from './adapters/ipc'
import { createPatchAdapter, type PatchAdapter } from './adapters/patches'
import { startSocketAdapter, type SocketAdapter } from './adapters/socket'
import { repoPathFromArguments } from './launch-arguments'
import { createDispatch, createRouteTable, type Dispatch } from './routes'
import { AppService } from './services/app-service'
import { ProjectService } from './services/project-service'
import { ProjectStore } from './services/project-store'
import { StateFeed } from './state-feed'

// Named before anything reads a path, so `userData` is the same directory in dev as in a
// packaged build and the CLI — which computes the path without asking us — agrees.
app.setName(APP_NAME)
const pathEnvironment = currentPathEnvironment(homedir())
const userDataDir = resolveUserDataDir(pathEnvironment)
app.setPath('userData', userDataDir)

/**
 * Two launch problems, two mechanisms. This lock is Finder and Dock double-launch: a
 * second copy of the app hands its argv over and exits. The CLI never comes through
 * here — it talks to the socket, and only spawns the app when there is no socket to talk
 * to.
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock()

let socketAdapter: SocketAdapter | undefined
let patchAdapter: PatchAdapter | undefined
let dispatch: Dispatch | undefined

/**
 * A launch pointed at a repo — Finder, Dock, `open -a Breakpoint .` — opens that project.
 * Through the route table, so it is the same `project.open` the CLI and the window use.
 */
function openFromArguments(argv: readonly string[], workingDirectory: string): void {
  const mode = { packaged: app.isPackaged, defaultApp: process.defaultApp === true }
  const path = repoPathFromArguments(argv, mode, workingDirectory)
  if (!path || !dispatch) return
  void dispatch({ id: 'argv', route: 'project.open', params: { path } }).then(({ response }) => {
    if (!response.ok) {
      console.error(`[breakpoint] could not open ${path}: ${response.error.message}`)
    }
  })
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    // Matches --bp-chrome, so the window does not flash white before the
    // renderer paints. Follows the theme once nativeTheme drives it (PRD 8.2).
    backgroundColor: '#191b28',
    // PRD 8.2: no title bar of our own. The toolbar is the drag region and the
    // traffic lights sit inside it, centred in its 44px (--bp-toolbar-h).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function focusExistingWindow(): void {
  const [existing] = BrowserWindow.getAllWindows()
  if (!existing) {
    createWindow()
    return
  }
  if (existing.isMinimized()) existing.restore()
  existing.show()
  existing.focus()
}

if (!hasSingleInstanceLock) {
  // A second copy of the app. Its argv has already been sent to the instance holding the
  // lock, so there is nothing left to do but get out of the way.
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    // Announced so the hand-off is observable from outside the process.
    console.log(`[breakpoint] second-instance ${JSON.stringify({ argv, workingDirectory })}`)
    openFromArguments(argv, workingDirectory)
    focusExistingWindow()
  })

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  async function startUp(): Promise<void> {
    // Set app user model id for windows
    electronApp.setAppUserModelId('com.breakpoint.app')

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    const feed = new StateFeed()
    const projectStore = new ProjectStore(join(userDataDir, 'projects'))
    dispatch = createDispatch(
      createRouteTable({
        app: new AppService(),
        project: new ProjectService(projectStore, feed)
      })
    )
    registerIpcAdapter(dispatch)
    patchAdapter = createPatchAdapter(feed)

    const socketPath = resolveSocketPath(pathEnvironment)
    try {
      socketAdapter = await startSocketAdapter(socketPath, dispatch)
      console.log(`[breakpoint] listening on ${socketPath}`)
    } catch (error) {
      // The window is still worth having without a CLI, so this degrades rather than
      // stopping the launch.
      console.error(`[breakpoint] could not listen on ${socketPath}:`, error)
    }

    createWindow()
    openFromArguments(process.argv, process.cwd())

    app.on('activate', function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }

  // A rejection here would otherwise leave a running process with no window and no
  // explanation, which is the hardest kind of failure to report from a terminal.
  app
    .whenReady()
    .then(startUp)
    .catch((error: unknown) => {
      console.error('[breakpoint] startup failed:', error)
      try {
        socketAdapter?.close()
      } catch (cleanupError) {
        console.error('[breakpoint] socket cleanup failed:', cleanupError)
      }
      socketAdapter = undefined
      app.exit(1)
    })
}

app.on('will-quit', () => {
  socketAdapter?.close()
  socketAdapter = undefined
  patchAdapter?.close()
  patchAdapter = undefined
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
