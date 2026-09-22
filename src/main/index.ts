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
import { EventLog } from '../shared/event-log'
import { repoPathFromArguments } from './launch-arguments'
import { HOST_WINDOW_PREFERENCES, PaneHost } from './pane-host'
import { createDispatch, createRouteTable, type Dispatch } from './routes'
import { AppService } from './services/app-service'
import { CertificateService } from './services/certificate-service'
import { CertificateStore } from './services/certificate-store'
import { CertificateHost } from './certificate-host'
import { PaneService } from './services/pane-service'
import { PresetService } from './services/preset-service'
import { PresetStore } from './services/preset-store'
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
 * A second executable hands its argv over and exits. Native macOS opens arrive through
 * `open-file` instead. The CLI talks to the socket and only spawns the app if needed.
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock()

let socketAdapter: SocketAdapter | undefined
let patchAdapter: PatchAdapter | undefined
let dispatch: Dispatch | undefined
let paneHost: PaneHost | undefined
let launchReady = false
const pendingRepoPaths: string[] = []

function openFromArguments(argv: readonly string[], workingDirectory: string): void {
  const mode = { packaged: app.isPackaged, defaultApp: process.defaultApp === true }
  const path = repoPathFromArguments(argv, mode, workingDirectory)
  if (path) openProject(path)
}

function openProject(path: string): void {
  if (!launchReady || !dispatch) {
    pendingRepoPaths.push(path)
    return
  }
  // A launch is the command line, whichever way the argv reached us.
  void dispatch({ id: 'launch', route: 'project.open', params: { path } }, { surface: 'cli' })
    .then(({ response }) => {
      if (!response.ok) {
        console.error(`[breakpoint] could not open ${path}: ${response.error.message}`)
      }
    })
    .catch((error: unknown) => console.error(`[breakpoint] could not open ${path}:`, error))
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
      sandbox: false,
      ...HOST_WINDOW_PREFERENCES
    }
  })
  paneHost?.adopt(mainWindow.webContents)

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
  app.on('open-file', (event, path) => {
    event.preventDefault()
    openProject(path)
    if (launchReady) focusExistingWindow()
  })

  app.on('second-instance', (_event, argv, workingDirectory) => {
    // Announced so the hand-off is observable from outside the process.
    console.log(`[breakpoint] second-instance ${JSON.stringify({ argv, workingDirectory })}`)
    openFromArguments(argv, workingDirectory)
    if (launchReady) focusExistingWindow()
  })

  openFromArguments(process.argv, process.cwd())

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
    const log = new EventLog()
    const projectStore = new ProjectStore(join(userDataDir, 'projects'))
    // Global, and beside the projects directory rather than inside it: one developer's
    // idea of "Mobile" does not change per repo.
    const presets = new PresetService(new PresetStore(join(userDataDir, 'presets.json')))
    // Global for the same reason presets are: a certificate belongs to a host and this
    // machine, so two projects on one staging server are one decision ([ADR-0012]).
    const certificateHost = new CertificateHost()
    const certificates = new CertificateService(
      new CertificateStore(join(userDataDir, 'certificates.json')),
      feed,
      log,
      (key) => certificateHost.revokeConnections(key)
    )
    await certificates.load()
    // The two services reach each other: opening a project resets its panes, and changing
    // a pane changes the project. Neither calls the other while being constructed.
    const panes = new PaneService(feed, log, {
      updatePane: (pane, changes) => projects.updatePane(pane, changes),
      addPane: (creation) => projects.addPane(creation),
      removePane: (pane) => projects.removePane(pane),
      rotatePane: (pane) => projects.rotatePane(pane)
    })
    const projects = new ProjectService(projectStore, feed, log, panes, presets, certificates)
    paneHost = new PaneHost(panes, feed)
    paneHost.install(app)
    dispatch = createDispatch(
      createRouteTable({
        app: new AppService(),
        certificates,
        log,
        panes,
        presets,
        project: projects
      })
    )

    certificateHost.install(app, certificates)
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
    launchReady = true
    for (const path of pendingRepoPaths.splice(0)) openProject(path)

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
