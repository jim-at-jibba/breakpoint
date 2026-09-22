import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  helpText,
  parseArgv,
  WAIT_TIMEOUT_MS,
  type CliCommandSpec,
  type CliOptions
} from '../shared/cli-surface'
import {
  LineBuffer,
  FrameTooLargeError,
  encodeLine,
  exitCodeFor,
  parseResponseLine,
  type ErrorCode,
  type RouteError,
  type RouteResponse
} from '../shared/protocol'
import { currentPathEnvironment, resolveSocketPath } from '../shared/paths'
import { snapshotReadiness, type StateSnapshot } from '../shared/state'
import { BACKGROUND_SWITCH } from './launch-arguments'

/**
 * The `breakpoint` command. A second entry point of the main build, run under the app's
 * own runtime in Node mode, so there is no separate Node dependency (PRD 8.1).
 *
 * Output discipline, settled here because every later command inherits it: the route's
 * payload on stdout and nothing else, diagnostics and progress on stderr. `--json` emits
 * exactly the payload object, so a `jq` pipe is safe even in a verbose run.
 */

const LAUNCH_TIMEOUT_MS = 20_000
const LAUNCH_POLL_MS = 100
const REQUEST_TIMEOUT_MS = 10_000
/** How often `--wait` asks the app where the panes got to. */
const WAIT_POLL_MS = 100

class CliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message)
  }
}

function main(): void {
  const parsed = parseArgv(process.argv.slice(2), process.cwd())

  if (parsed.kind === 'help') {
    process.stdout.write(helpText())
    process.exitCode = 0
    return
  }

  if (parsed.kind === 'error') {
    const code = reportError({
      error: { code: 'INVALID_USAGE', message: parsed.message },
      options: parsed.options
    })
    if (!parsed.options.json) process.stderr.write(`\n${helpText()}`)
    process.exitCode = code
    return
  }

  const { command, options, params } = parsed
  const diagnose = createDiagnose(options)

  run(command, params, options, diagnose)
    .then((response) => {
      // Let pending pipe writes drain before Node exits, including full log pages.
      process.exitCode = report(command, response, options)
    })
    .catch((error: unknown) => {
      const code: ErrorCode = error instanceof CliError ? error.code : 'INTERNAL_ERROR'
      const message = error instanceof Error ? error.message : String(error)
      process.exitCode = reportError({ error: { code, message }, options })
    })
}

function createDiagnose(options: CliOptions): (message: string) => void {
  return (message) => {
    if (options.verbose) process.stderr.write(`breakpoint: ${message}\n`)
  }
}

/** One route call, with the app started first if nothing is listening yet. */
type Call = (route: string, params?: unknown) => Promise<RouteResponse>

async function run(
  command: CliCommandSpec,
  params: unknown,
  options: CliOptions,
  diagnose: (message: string) => void
): Promise<RouteResponse> {
  const socketPath = resolveSocketPath(currentPathEnvironment(homedir()))
  diagnose(`socket ${socketPath}`)
  const call: Call = (route, callParams) => request(socketPath, route, callParams, diagnose)

  const response = await (async (): Promise<RouteResponse> => {
    try {
      return await call(command.route, params)
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'APP_NOT_RUNNING') throw error
      if (options.noLaunch) throw error

      diagnose('no socket — starting the app')
      await launchApp(options)
      await waitForSocket(socketPath, diagnose)
      return await call(command.route, params)
    }
  })()

  // Nothing follows a failure: there is no project to look at and no panes to wait for.
  if (!response.ok) return response

  if (command.activates && !options.background) await activate(call, diagnose)
  if (!options.wait || command.waits === undefined) return response

  const ready = await waitForPanes(call, diagnose)
  // Only where the payload is a snapshot: the one taken before the panes loaded is the
  // thing `--wait` exists to stop an agent reading.
  return command.waits === 'snapshot' ? { ...response, data: ready } : response
}

/**
 * Brings the window forward, best effort. The project is open either way, so a window
 * that could not be raised is said on stderr rather than failing the command.
 */
async function activate(call: Call, diagnose: (message: string) => void): Promise<void> {
  try {
    const response = await call('app.focus')
    if (response.ok) return
    process.stderr.write(
      `breakpoint: could not bring the window forward: ${response.error.message}\n`
    )
  } catch (error) {
    diagnose(`could not bring the window forward: ${String(error)}`)
  }
}

/**
 * Polls until every pane has finished loading where it was sent and is drawn at the size
 * it claims, then answers with the snapshot that was true when it became ready.
 *
 * Polling rather than a route that blocks: the wait is the caller's patience, and a
 * socket held open for half a minute is a connection the app has to reason about.
 */
async function waitForPanes(
  call: Call,
  diagnose: (message: string) => void
): Promise<StateSnapshot> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  let reason = 'the app has not said yet'

  while (Date.now() < deadline) {
    const response = await call('project.state')
    if (!response.ok) throw new CliError(response.error.code, response.error.message)

    const snapshot = response.data as StateSnapshot
    const readiness = snapshotReadiness(snapshot)
    if (readiness.ready) return snapshot
    // Only when it changes: a poll every 100ms would otherwise bury the run in stderr.
    if (readiness.reason !== reason) diagnose(`waiting — ${readiness.reason}`)
    reason = readiness.reason
    await delay(WAIT_POLL_MS)
  }

  throw new CliError(
    'TIMEOUT',
    `the panes were not ready after ${WAIT_TIMEOUT_MS / 1000}s: ${reason}`
  )
}

/** Writes the payload, and only the payload, to stdout. Returns the exit code. */
function report(command: CliCommandSpec, response: RouteResponse, options: CliOptions): number {
  if (response.ok) {
    const text = options.json ? JSON.stringify(response.data) : command.render(response.data)
    process.stdout.write(`${text}\n`)
    return 0
  }

  // A failure has no payload, so stdout stays empty in both modes rather than carrying
  // something a `jq` pipe would choke on.
  return reportError({ error: response.error, options })
}

function reportError({ error, options }: { error: RouteError; options: CliOptions }): number {
  const text = options.json
    ? JSON.stringify({ error })
    : `breakpoint: ${error.code}: ${error.message}`
  process.stderr.write(`${text}\n`)
  return exitCodeFor(error.code)
}

function request(
  socketPath: string,
  route: string,
  params: unknown,
  diagnose: (message: string) => void
): Promise<RouteResponse> {
  return new Promise((resolve, reject) => {
    const lines = new LineBuffer()
    let settled = false

    const socket: Socket = connect(socketPath)
    socket.setEncoding('utf8')

    const timer = setTimeout(() => {
      fail(new CliError('TIMEOUT', `no response from the app after ${REQUEST_TIMEOUT_MS}ms`))
    }, REQUEST_TIMEOUT_MS)

    function finish(): void {
      clearTimeout(timer)
      socket.destroy()
    }

    function fail(error: CliError): void {
      if (settled) return
      settled = true
      finish()
      reject(error)
    }

    socket.on('connect', () => {
      diagnose(`connected, calling ${route}`)
      socket.write(
        encodeLine(params === undefined ? { id: '1', route } : { id: '1', route, params })
      )
    })

    socket.on('data', (chunk: string) => {
      let received: string[]
      try {
        received = lines.push(chunk)
      } catch (error) {
        if (!(error instanceof FrameTooLargeError)) throw error
        fail(new CliError('TRANSPORT_ERROR', error.message))
        return
      }
      for (const line of received) {
        const parsed = parseResponseLine(line)
        if (settled) return
        settled = true
        finish()
        if (parsed.ok) resolve(parsed.response)
        else reject(new CliError('TRANSPORT_ERROR', parsed.error.message))
        return
      }
    })

    socket.on('error', (error: NodeJS.ErrnoException) => {
      const missing = error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
      fail(
        missing
          ? new CliError('APP_NOT_RUNNING', 'the app is not running')
          : new CliError('TRANSPORT_ERROR', error.message)
      )
    })

    socket.on('close', () => {
      fail(new CliError('TRANSPORT_ERROR', 'the app closed the connection without replying'))
    })
  })
}

/**
 * Starts the app detached, so the command that spawned it can exit without taking it
 * down. `process.execPath` is the app's own runtime — this process is that runtime in
 * Node mode — so the child is launched from the same binary with the Node flag cleared.
 */
function launchApp(options: CliOptions): Promise<void> {
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE

  const packaged = __dirname.includes('app.asar')
  const args = packaged ? [] : [join(__dirname, 'index.js')]
  // The app reads its own argv for this: the process that has to avoid taking focus is
  // the one being started, and it is not the one holding the flag.
  if (options.background) args.push(BACKGROUND_SWITCH)

  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: environment
    })
    child.once('error', (error) => reject(new CliError('LAUNCH_FAILED', error.message)))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

async function waitForSocket(
  socketPath: string,
  diagnose: (message: string) => void
): Promise<void> {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS
  let attempts = 0

  while (Date.now() < deadline) {
    attempts += 1
    if (await canConnect(socketPath)) {
      diagnose(`socket answered after ${attempts} attempts`)
      return
    }
    await delay(LAUNCH_POLL_MS)
  }

  throw new CliError(
    'LAUNCH_FAILED',
    `the app did not open its socket within ${LAUNCH_TIMEOUT_MS}ms`
  )
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main()
