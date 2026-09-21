import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { helpText, parseArgv, type CliCommandSpec, type CliOptions } from '../shared/cli-surface'
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
  const parsed = parseArgv(process.argv.slice(2), process.cwd())

  if (parsed.kind === 'help') {
    process.stdout.write(helpText())
    process.exit(0)
  }

  if (parsed.kind === 'error') {
    const code = reportError({
      error: { code: 'INVALID_USAGE', message: parsed.message },
      options: parsed.options
    })
    if (!parsed.options.json) process.stderr.write(`\n${helpText()}`)
    process.exit(code)
  }

  const { command, options, params } = parsed
  const diagnose = createDiagnose(options)

  run(command.route, params, options, diagnose)
    .then((response) => process.exit(report(command, response, options)))
    .catch((error: unknown) => {
      const code: ErrorCode = error instanceof CliError ? error.code : 'INTERNAL_ERROR'
      const message = error instanceof Error ? error.message : String(error)
      process.exit(reportError({ error: { code, message }, options }))
    })
}

function createDiagnose(options: CliOptions): (message: string) => void {
  return (message) => {
    if (options.verbose) process.stderr.write(`breakpoint: ${message}\n`)
  }
}

async function run(
  route: string,
  params: unknown,
  options: CliOptions,
  diagnose: (message: string) => void
): Promise<RouteResponse> {
  const socketPath = resolveSocketPath(currentPathEnvironment(homedir()))
  diagnose(`socket ${socketPath}`)

  try {
    return await request(socketPath, route, params, diagnose)
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== 'APP_NOT_RUNNING') throw error
    if (options.noLaunch) throw error

    diagnose('no socket — starting the app')
    await launchApp()
    await waitForSocket(socketPath, diagnose)
    return await request(socketPath, route, params, diagnose)
  }
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
