import { describe, expect, it } from 'vitest'
import { backgroundFromArguments, repoPathFromArguments } from './launch-arguments'

const electron = '/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
const entry = '/app/out/main/index.js'

describe('repoPathFromArguments', () => {
  it('finds the repo after the entry script, past the flags Electron inserts before it', () => {
    // A second launch's argv exactly as the running instance received it.
    const argv = [
      electron,
      '--allow-file-access-from-files',
      '--enable-avfoundation',
      entry,
      '/repos/shop'
    ]
    expect(repoPathFromArguments(argv, { packaged: false, defaultApp: true }, '/cwd')).toBe(
      '/repos/shop'
    )
  })

  it('resolves a relative repo against the launch working directory', () => {
    expect(
      repoPathFromArguments(
        [electron, entry, '.'],
        { packaged: false, defaultApp: true },
        '/repos/shop'
      )
    ).toBe('/repos/shop')
  })

  it('reads a packaged launch from argv[1] onward', () => {
    expect(
      repoPathFromArguments(
        ['/Applications/Breakpoint.app/Contents/MacOS/Breakpoint', '/repos/shop'],
        { packaged: true, defaultApp: false },
        '/cwd'
      )
    ).toBe('/repos/shop')
  })

  it('ignores flags and bare words, and a launch with nothing for us', () => {
    const options = { packaged: false, defaultApp: true }
    expect(repoPathFromArguments([electron, entry], options, '/cwd')).toBeUndefined()
    expect(
      repoPathFromArguments([electron, entry, '--handed-over'], options, '/cwd')
    ).toBeUndefined()
    expect(repoPathFromArguments([electron, entry, 'state'], options, '/cwd')).toBeUndefined()
  })

  it.each(['--log-file', '--log-net-log', '--user-data-dir', '--disk-cache-dir'])(
    'ignores %s with inline and separate paths in either launch mode',
    (flag: string) => {
      const switches: string[][] = [[`${flag}=/tmp/breakpoint`], [flag, '/tmp/breakpoint']]
      for (const args of switches) {
        const packaged = { packaged: true, defaultApp: false }
        const development = { packaged: false, defaultApp: true }
        expect(repoPathFromArguments([electron, ...args, '/repos/shop'], packaged, '/cwd')).toBe(
          '/repos/shop'
        )
        expect(repoPathFromArguments([electron, ...args], packaged, '/cwd')).toBeUndefined()
        expect(
          repoPathFromArguments([electron, ...args, entry, '/repos/shop'], development, '/cwd')
        ).toBe('/repos/shop')
        expect(
          repoPathFromArguments([electron, entry, ...args, '/repos/shop'], development, '/cwd')
        ).toBe('/repos/shop')
        expect(
          repoPathFromArguments([electron, entry, ...args], development, '/cwd')
        ).toBeUndefined()
      }
    }
  )

  it('ignores unknown switches containing either path separator', () => {
    expect(
      repoPathFromArguments(
        [electron, '--custom=/tmp/log', '--other=C:\\logs', '/repos/shop'],
        { packaged: true, defaultApp: false },
        '/cwd'
      )
    ).toBe('/repos/shop')
  })

  it('never reads argv when neither packaged nor the default app, such as under a test runner', () => {
    expect(
      repoPathFromArguments(
        ['/usr/bin/node', 'vitest', './src'],
        { packaged: false, defaultApp: false },
        '/cwd'
      )
    ).toBeUndefined()
  })
})

describe('backgroundFromArguments', () => {
  const development = { packaged: false, defaultApp: true }
  const packaged = { packaged: true, defaultApp: false }

  it('is off for an ordinary launch', () => {
    expect(backgroundFromArguments([electron, entry, '/repos/shop'], development)).toBe(false)
    expect(backgroundFromArguments([electron, '/repos/shop'], packaged)).toBe(false)
  })

  it('is on when the CLI launched the app in the background, in either launch mode', () => {
    expect(backgroundFromArguments([electron, entry, '--background'], development)).toBe(true)
    expect(backgroundFromArguments([electron, '--background'], packaged)).toBe(true)
  })

  it('reads it beside a repo path, whichever order they arrive in', () => {
    const argv = [electron, entry, '--background', '/repos/shop']
    expect(backgroundFromArguments(argv, development)).toBe(true)
    expect(repoPathFromArguments(argv, development, '/cwd')).toBe('/repos/shop')
    expect(
      backgroundFromArguments([electron, entry, '/repos/shop', '--background'], development)
    ).toBe(true)
  })

  it('never reads a switch Electron put in ahead of our entry script as ours', () => {
    expect(backgroundFromArguments([electron, '--background', entry], development)).toBe(false)
  })

  it('never reads argv when neither packaged nor the default app', () => {
    expect(
      backgroundFromArguments(['/usr/bin/node', 'vitest', '--background'], {
        packaged: false,
        defaultApp: false
      })
    ).toBe(false)
  })
})
