import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { helpText, parseArgv, type CliOptions } from '../shared/cli-surface'
import {
  LineBuffer,
  encodeLine,
  exitCodeFor,
  parseResponseLine,
  type ErrorCode,
  type RouteResponse
} from '../shared/protocol'
import { currentPathEnvironment, resolveSocketPath } from '../shared/paths'

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

class CliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message)
  }
}

function main(): void {
  const parsed = parseArgv(process.argv.slice(2))

  if (parsed.kind === 'help') {
    process.stdout.write(helpText())
    process.exit(0)
  }

  if (parsed.kind === 'error') {
    process.stderr.write(`breakpoint: ${parsed.message}\n\n${helpText()}`)
    process.exit(exitCodeFor('invalid_usage'))
  }

  const { command, options } = parsed
  const diagnose = createDiagnose(options)

  run(command.route, command.launch, options, diagnose)
    .then((response) => process.exit(report(response, options)))
    .catch((error: unknown) => {
      const code: ErrorCode = error instanceof CliError ? error.code : 'internal_error'
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`breakpoint: ${message}\n`)
      process.exit(exitCodeFor(code))
    })
}

function createDiagnose(options: CliOptions): (message: string) => void {
  return (message) => {
    if (options.verbose) process.stderr.write(`breakpoint: ${message}\n`)
  }
}

async function run(
  route: string,
  launch: 'if-needed' | 'never',
  options: CliOptions,
  diagnose: (message: string) => void
): Promise<RouteResponse> {
  const socketPath = resolveSocketPath(currentPathEnvironment(homedir()))
  diagnose(`socket ${socketPath}`)

  try {
    return await request(socketPath, route, diagnose)
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== 'app_not_running') throw error

    if (options.noLaunch || launch === 'never') {
      throw new CliError('app_not_running', 'the app is not running')
    }

    diagnose('no socket — starting the app')
    await launchApp()
    await waitForSocket(socketPath, diagnose)
    return await request(socketPath, route, diagnose)
  }
}

/** Writes the payload, and only the payload, to stdout. Returns the exit code. */
function report(response: RouteResponse, options: CliOptions): number {
  if (response.ok) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(response.payload)}\n`)
    } else {
      process.stdout.write(`${describe(response.payload)}\n`)
    }
    return 0
  }

  // A failure has no payload, so stdout stays empty in both modes rather than carrying
  // something a `jq` pipe would choke on.
  const { code, message } = response.error
  const text = options.json ? JSON.stringify({ error: { code, message } }) : `${code}: ${message}`
  process.stderr.write(`breakpoint: ${text}\n`)
  return exitCodeFor(code)
}

function describe(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'quitting' in payload)
    return 'Breakpoint is quitting.'
  return JSON.stringify(payload)
}

function request(
  socketPath: string,
  route: string,
  diagnose: (message: string) => void
): Promise<RouteResponse> {
  return new Promise((resolve, reject) => {
    const lines = new LineBuffer()
    let settled = false

    const socket: Socket = connect(socketPath)
    socket.setEncoding('utf8')

    const timer = setTimeout(() => {
      fail(
        new CliError('transport_error', `no response from the app after ${REQUEST_TIMEOUT_MS}ms`)
      )
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
      socket.write(encodeLine({ id: '1', route }))
    })

    socket.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) {
        const parsed = parseResponseLine(line)
        if (settled) return
        settled = true
        finish()
        if (parsed.ok) resolve(parsed.response)
        else reject(new CliError('transport_error', parsed.error.message))
        return
      }
    })

    socket.on('error', (error: NodeJS.ErrnoException) => {
      const missing = error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
      fail(
        missing
          ? new CliError('app_not_running', 'the app is not running')
          : new CliError('transport_error', error.message)
      )
    })

    socket.on('close', () => {
      fail(new CliError('transport_error', 'the app closed the connection without replying'))
    })
  })
}

/**
 * Starts the app detached, so the command that spawned it can exit without taking it
 * down. `process.execPath` is the app's own runtime — this process is that runtime in
 * Node mode — so the child is launched from the same binary with the Node flag cleared.
 */
function launchApp(): Promise<void> {
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE

  const packaged = __dirname.includes('app.asar')
  const args = packaged ? [] : [join(__dirname, 'index.js')]

  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: environment
    })
    child.once('error', (error) => reject(new CliError('launch_failed', error.message)))
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
    'launch_failed',
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
