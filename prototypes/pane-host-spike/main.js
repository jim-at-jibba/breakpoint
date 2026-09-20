'use strict'
// THROWAWAY Phase 0 spike — see README.md. Answers PRD §12 items 1, 2 and 3.
// Deliberately one file, no service layer, no abstraction. The deliverable is
// an answer, not a PaneHost.

const { app, BrowserWindow, ipcMain, webContents } = require('electron')
const path = require('path')
const fs = require('fs')
const { startServers, ORIGIN_A, ORIGIN_B } = require('./server')

// Six of the §6.2 default presets: DPR 1/2/3 and both mobile-flag states.
const PRESETS = [
  { id: 'p1', name: 'Mobile S',  width: 360,  height: 800,  dpr: 3, mobile: true },
  { id: 'p2', name: 'Mobile',    width: 390,  height: 844,  dpr: 3, mobile: true },
  { id: 'p3', name: 'Mobile L',  width: 430,  height: 932,  dpr: 3, mobile: true },
  { id: 'p4', name: 'Tablet',    width: 820,  height: 1180, dpr: 2, mobile: true },
  { id: 'p5', name: 'Laptop',    width: 1280, height: 800,  dpr: 2, mobile: false },
  { id: 'p6', name: 'Desktop',   width: 1440, height: 900,  dpr: 1, mobile: false }
]

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const OUT_DIR = path.join(__dirname, 'out')

/** @type {Map<string, any>} */
const panes = new Map()
const log = []
let win = null
let currentZoom = 1
let pendingSynthetic = null // { paneId, at }

function note (paneId, kind, detail) {
  log.push({ at: Date.now(), paneId, kind, detail })
  if (log.length > 400) log.shift()
}

function pane (id) {
  const p = panes.get(id)
  if (!p) throw new Error('unknown pane ' + id)
  return p
}

function guest (p) {
  const wc = webContents.fromId(p.wcId)
  if (!wc || wc.isDestroyed()) throw new Error('no webContents for ' + p.id)
  return wc
}

// Every CDP command goes through here. A command that never answers is exactly
// what condition 2 is looking for, so it must be recorded, not awaited forever.
const CDP_TIMEOUT_MS = 4000

function send (p, method, params) {
  const d = guest(p).debugger
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      p.cdpTimeouts = (p.cdpTimeouts || 0) + 1
      p.lastCdpTimeout = { at: Date.now(), method }
      note(p.id, 'cdp-timeout', `${method} did not answer in ${CDP_TIMEOUT_MS}ms (devtoolsOpen=${p.devtoolsOpen})`)
      reject(new Error('cdp timeout: ' + method))
    }, CDP_TIMEOUT_MS)
    d.sendCommand(method, params).then(
      res => { if (!settled) { settled = true; clearTimeout(timer); resolve(res) } },
      err => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        p.lastCdpError = { at: Date.now(), method, error: String(err.message || err) }
        note(p.id, 'cdp-error', `${method}: ${err.message || err}`)
        reject(err)
      }
    )
  })
}

// ---------------------------------------------------------------- emulation

async function applyEmulation (p) {
  await send(p, 'Emulation.setDeviceMetricsOverride', {
    width: p.preset.width,
    height: p.preset.height,
    deviceScaleFactor: p.preset.dpr,
    mobile: p.preset.mobile
  })
  await send(p, 'Emulation.setUserAgentOverride', {
    userAgent: p.preset.mobile ? UA_MOBILE : UA_DESKTOP,
    platform: p.preset.mobile ? 'iPhone' : 'macOS',
    userAgentMetadata: {
      platform: p.preset.mobile ? 'iOS' : 'macOS',
      platformVersion: '17.0',
      architecture: 'arm',
      model: '',
      mobile: p.preset.mobile,
      brands: [{ brand: 'Chromium', version: '140' }],
      fullVersion: '140.0.0.0'
    }
  })
  await send(p, 'Emulation.setTouchEmulationEnabled', {
    enabled: p.preset.mobile,
    maxTouchPoints: p.preset.mobile ? 5 : 1  // CDP rejects 0, even when disabling
  })
  await send(p, 'Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }]
  })
  p.emulationAppliedAt = Date.now()
}

// Reads the pane's own view of itself. Never reapplies overrides — condition 3
// turns entirely on whether they survive on their own.
async function measure (p) {
  try {
    const { result } = await send(p, 'Runtime.evaluate', {
      expression: `JSON.stringify({
        innerWidth: innerWidth, innerHeight: innerHeight,
        dpr: devicePixelRatio, ua: navigator.userAgent,
        touch: navigator.maxTouchPoints,
        coarse: matchMedia('(pointer: coarse)').matches,
        href: location.href,
        scrollHeight: document.documentElement.scrollHeight
      })`,
      returnByValue: true
    })
    p.measured = JSON.parse(result.value)
    const m = p.measured
    m.widthMatch = m.innerWidth === p.preset.width
    // DPR and UA cannot be explained by the element's on-screen size, so they
    // are what actually shows the CDP override is still in force.
    m.dprMatch = m.dpr === p.preset.dpr
    m.uaOverridden = p.preset.mobile ? /iPhone/.test(m.ua) : /Macintosh/.test(m.ua)
    m.touchMatch = p.preset.mobile ? m.touch === 5 && m.coarse : m.touch === 0
    m.declaredMatch = m.widthMatch && m.dprMatch && m.uaOverridden && m.touchMatch
    p.measureError = null
  } catch (err) {
    p.measureError = String(err.message || err)
  }
  p.osPid = safePid(p)
}

function safePid (p) {
  try { return guest(p).getOSProcessId() } catch { return null }
}

// ------------------------------------------------------------------ attach

async function attach (paneId, wcId) {
  const preset = PRESETS.find(x => x.id === paneId)
  const p = {
    id: paneId,
    preset,
    wcId,
    attached: false,
    attachError: null,
    osPid: null,
    measured: null,
    measureError: null,
    emulationAppliedAt: null,
    devtoolsOpen: false,
    detached: null,
    reattachedAt: null,
    counts: { consoleAPICalled: 0, exceptionThrown: 0, logEntryAdded: 0, network: 0 },
    heartbeat: { count: 0, lastAt: null },
    lastClick: null,
    clicks: [],
    navs: []
  }
  panes.set(paneId, p)

  const wc = webContents.fromId(wcId)
  const d = wc.debugger

  try {
    d.attach('1.3')
    p.attached = true
  } catch (err) {
    p.attachError = String(err.message || err)
    note(paneId, 'attach-failed', p.attachError)
    return p
  }

  d.on('detach', (_e, reason) => {
    p.attached = false
    p.detached = { at: Date.now(), reason: String(reason) }
    note(paneId, 'cdp-detach', 'reason=' + reason)
  })

  d.on('message', (_e, method, params) => onCdpEvent(p, method, params))

  // §8.6 step 1
  for (const domain of ['Runtime', 'Log', 'Network', 'Page']) {
    await send(p, domain + '.enable')
  }
  await send(p, 'Runtime.addBinding', { name: '__spike' })

  wc.on('devtools-opened', () => { p.devtoolsOpen = true; note(paneId, 'devtools-opened', '') })
  wc.on('devtools-closed', () => { p.devtoolsOpen = false; note(paneId, 'devtools-closed', '') })

  wc.on('did-finish-load', async () => {
    const before = p.osPid
    const after = safePid(p)
    await measure(p)
    const entry = {
      at: Date.now(),
      url: p.measured && p.measured.href,
      pidBefore: before,
      pidAfter: after,
      processSwapped: before != null && after != null && before !== after,
      cdpStillAttached: d.isAttached(),
      innerWidth: p.measured && p.measured.innerWidth,
      declaredWidth: p.preset.width,
      dpr: p.measured && p.measured.dpr,
      declaredDpr: p.preset.dpr,
      uaOverridden: p.measured && p.measured.uaOverridden,
      touchMatch: p.measured && p.measured.touchMatch,
      overridesSurvived: !!(p.measured && p.measured.declaredMatch)
    }
    p.navs.push(entry)
    note(paneId, 'did-finish-load',
      `pid ${before}->${after} swap=${entry.processSwapped} innerWidth=${entry.innerWidth}/${entry.declaredWidth} survived=${entry.overridesSurvived}`)
  })

  try { await applyEmulation(p) } catch (err) { note(paneId, 'emulation-failed', String(err.message || err)) }
  await measure(p)

  note(paneId, 'attached', `wcId=${wcId} pid=${p.osPid}`)
  return p
}

function onCdpEvent (p, method, params) {
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      p.counts.consoleAPICalled++
      const text = (params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' ')
      if (text.startsWith('heartbeat')) {
        p.heartbeat.count++
        p.heartbeat.lastAt = Date.now()
      } else {
        note(p.id, 'console.' + params.type, text.slice(0, 120))
      }
      break
    }
    case 'Runtime.exceptionThrown':
      p.counts.exceptionThrown++
      note(p.id, 'exception', (params.exceptionDetails && params.exceptionDetails.text) || '')
      break
    case 'Log.entryAdded':
      p.counts.logEntryAdded++
      note(p.id, 'log.' + params.entry.level, String(params.entry.text).slice(0, 120))
      break
    case 'Network.requestWillBeSent':
      p.counts.network++
      break
    case 'Runtime.bindingCalled': {
      if (params.name !== '__spike') break
      const payload = JSON.parse(params.payload)
      if (payload.type !== 'click') break
      const synthetic = !!(pendingSynthetic && pendingSynthetic.paneId === p.id &&
        Date.now() - pendingSynthetic.at < 2000)
      const method = synthetic ? pendingSynthetic.method : 'human'
      if (synthetic) pendingSynthetic = null
      const rec = {
        at: Date.now(),
        zoom: currentZoom,
        source: method,
        onTarget: payload.onTarget,
        hitId: payload.hitId,
        dx: payload.dx,
        dy: payload.dy,
        innerWidth: payload.innerWidth
      }
      p.lastClick = rec
      p.clicks.push(rec)
      note(p.id, 'click', `${rec.source} zoom=${Math.round(rec.zoom * 100)}% ${rec.onTarget ? 'HIT' : 'MISS ' + rec.hitId} offset=${rec.dx},${rec.dy}`)
      break
    }
    case 'Page.frameNavigated':
      if (params.frame && !params.frame.parentId) note(p.id, 'frameNavigated', params.frame.url)
      break
  }
}

// -------------------------------------------------------------------- state

function snapshot () {
  const now = Date.now()
  return {
    now,
    zoom: currentZoom,
    origins: { a: ORIGIN_A, b: ORIGIN_B },
    panes: PRESETS.map(preset => {
      const p = panes.get(preset.id)
      if (!p) return { id: preset.id, name: preset.name, preset, attached: false, pending: true }
      return {
        id: p.id,
        name: preset.name,
        preset,
        attached: p.attached,
        attachError: p.attachError,
        detached: p.detached,
        reattachedAt: p.reattachedAt,
        devtoolsOpen: p.devtoolsOpen,
        osPid: p.osPid,
        measured: p.measured,
        measureError: p.measureError,
        counts: p.counts,
        heartbeatAgeMs: p.heartbeat.lastAt ? now - p.heartbeat.lastAt : null,
        heartbeatCount: p.heartbeat.count,
        lastClick: p.lastClick,
        clickSummary: summariseClicks(p),
        cdpTimeouts: p.cdpTimeouts || 0,
        lastCdpTimeout: p.lastCdpTimeout || null,
        lastCdpError: p.lastCdpError || null,
        lastNav: p.navs[p.navs.length - 1] || null,
        navCount: p.navs.length
      }
    }),
    log: log.slice(-60).reverse()
  }
}

function summariseClicks (p) {
  const byZoom = {}
  for (const c of p.clicks) {
    const key = Math.round(c.zoom * 100) + '%'
    if (!byZoom[key]) byZoom[key] = { hits: 0, misses: 0, maxOffset: 0 }
    c.onTarget ? byZoom[key].hits++ : byZoom[key].misses++
    byZoom[key].maxOffset = Math.max(byZoom[key].maxOffset, Math.abs(c.dx), Math.abs(c.dy))
  }
  return byZoom
}

// ---------------------------------------------------------------------- ipc

ipcMain.handle('app:boot', () => ({ presets: PRESETS, origins: { a: ORIGIN_A, b: ORIGIN_B } }))

ipcMain.handle('pane:attach', async (_e, { paneId, wcId }) => {
  if (panes.has(paneId) && panes.get(paneId).attached) return { ok: true, already: true }
  const p = await attach(paneId, wcId)
  return { ok: p.attached, error: p.attachError }
})

ipcMain.handle('probe:setZoom', (_e, z) => { currentZoom = z; note(null, 'zoom', Math.round(z * 100) + '%') })

ipcMain.handle('probe:targetRect', async (_e, paneId) => {
  // eslint-disable-next-line
  const { result } = await send(pane(paneId), 'Runtime.evaluate', {
    expression: `(function(){var r=document.getElementById('target').getBoundingClientRect();
      return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height});})()`,
    returnByValue: true
  })
  return JSON.parse(result.value)
})

// Sends a real OS-level input event to the HOST window at host-window CSS
// coordinates. If Chromium routes it into the scaled guest, condition 1 is
// answered without a human. If nothing arrives, that is a harness limit, not a
// failure — the manual click path is the arbiter.
ipcMain.handle('probe:synthClick', (_e, { paneId, x, y }) => {
  pendingSynthetic = { paneId, at: Date.now(), method: 'sendInputEvent' }
  const base = { x: Math.round(x), y: Math.round(y) }
  win.webContents.sendInputEvent({ type: 'mouseMove', ...base })
  win.webContents.sendInputEvent({ type: 'mouseDown', ...base, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', ...base, button: 'left', clickCount: 1 })
  note(paneId, 'synth-dispatch', `window(${base.x},${base.y}) zoom=${Math.round(currentZoom * 100)}%`)
  return base
})

let hostDebuggerReady = false
function ensureHostDebugger () {
  if (hostDebuggerReady) return true
  try { win.webContents.debugger.attach('1.3'); hostDebuggerReady = true } catch (err) {
    note(null, 'host-debugger-failed', String(err.message || err))
  }
  return hostDebuggerReady
}

ipcMain.handle('probe:synthClickCdp', async (_e, { paneId, x, y }) => {
  pendingSynthetic = { paneId, at: Date.now(), method: 'cdpInput' }
  if (!ensureHostDebugger()) return { ok: false }
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }
  const d = win.webContents.debugger
  await d.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 })
  await d.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
  await d.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
  note(paneId, 'synth-dispatch-cdp', `window(${base.x},${base.y}) zoom=${Math.round(currentZoom * 100)}%`)
  return { ok: true, ...base }
})

// A CDP screenshot of the guest renders the page independently of how the
// canvas composites it, which separates "the pane did not render" from "the
// scaled canvas did not present it".
ipcMain.handle('probe:paneShot', async (_e, paneId) => {
  const p = pane(paneId)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const { data } = await send(p, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = path.join(OUT_DIR, `pane-${paneId}-${Date.now()}.png`)
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  note(paneId, 'pane-shot', file)
  return file
})

// One-shot diagnostic: ask each pane what it thinks its own layout and bindings
// are, instead of inferring either from a screenshot.
ipcMain.handle('probe:diag', async () => {
  const out = {}
  for (const p of panes.values()) {
    try {
      const { result } = await send(p, 'Runtime.evaluate', {
        expression: `(function(){
          var ids = ['target','field','crosslink','last'];
          var o = {
            binding: typeof window.__spike,
            bodyHtmlLen: document.body.innerHTML.length,
            bodyChildren: document.body.children.length,
            scrollHeight: document.documentElement.scrollHeight,
            clientHeight: document.documentElement.clientHeight,
            innerWidth: innerWidth, innerHeight: innerHeight, dpr: devicePixelRatio,
            visibility: document.visibilityState,
            els: {}
          };
          ids.forEach(function(id){
            var e = document.getElementById(id);
            if (!e) { o.els[id] = null; return; }
            var r = e.getBoundingClientRect();
            o.els[id] = { x: Math.round(r.left), y: Math.round(r.top),
                          w: Math.round(r.width), h: Math.round(r.height),
                          vis: getComputedStyle(e).visibility,
                          disp: getComputedStyle(e).display };
          });
          var t = document.getElementById('target');
          if (t) {
            var r = t.getBoundingClientRect();
            var hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
            o.elementFromPointAtTarget = hit ? (hit.id || hit.tagName) : null;
          }
          return JSON.stringify(o);
        })()`,
        returnByValue: true
      })
      out[p.id] = JSON.parse(result.value)
      // The compositor's own view, to separate "the page laid out wrong" from
      // "the capture disagrees with a correct layout".
      try {
        const lm = await send(p, 'Page.getLayoutMetrics')
        out[p.id].layoutMetrics = {
          cssLayoutViewport: lm.cssLayoutViewport,
          cssVisualViewport: lm.cssVisualViewport && {
            clientWidth: lm.cssVisualViewport.clientWidth,
            clientHeight: lm.cssVisualViewport.clientHeight,
            scale: lm.cssVisualViewport.scale
          },
          cssContentSize: lm.cssContentSize
        }
      } catch (err) { out[p.id].layoutMetricsError = String(err.message || err) }
    } catch (err) {
      out[p.id] = { error: String(err.message || err) }
    }
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'diag.json'), JSON.stringify(out, null, 2))
  console.log('DIAG', JSON.stringify(out, null, 2))
  return out
})

ipcMain.handle('probe:devtools', (_e, { paneId, open }) => {
  const wc = guest(pane(paneId))
  if (open) wc.openDevTools({ mode: 'detach' })
  else wc.closeDevTools()
  return true
})

ipcMain.handle('probe:reattach', async (_e, paneId) => {
  const p = pane(paneId)
  const d = guest(p).debugger
  try {
    d.attach('1.3')
    for (const domain of ['Runtime', 'Log', 'Network', 'Page']) await send(p, domain + '.enable')
    await send(p, 'Runtime.addBinding', { name: '__spike' })
    p.attached = true
    p.reattachedAt = Date.now()
    note(paneId, 'reattached', 'ok')
    return { ok: true }
  } catch (err) {
    note(paneId, 'reattach-failed', String(err.message || err))
    return { ok: false, error: String(err.message || err) }
  }
})

ipcMain.handle('probe:navigate', async (_e, { paneId, url }) => {
  const targets = paneId === 'all' ? [...panes.keys()] : [paneId]
  for (const id of targets) {
    note(id, 'navigate', url)
    guest(pane(id)).loadURL(url)
  }
  return true
})

ipcMain.handle('probe:reapply', async (_e, paneId) => {
  const targets = paneId === 'all' ? [...panes.keys()] : [paneId]
  for (const id of targets) {
    try { await applyEmulation(pane(id)) } catch (err) { note(id, 'reapply-failed', String(err.message || err)) }
    await measure(pane(id))
  }
  note(paneId, 'reapply', 'overrides reapplied')
  return true
})

ipcMain.handle('probe:measure', async () => {
  for (const p of panes.values()) await measure(p)   // measure() swallows its own errors
  return true
})

ipcMain.handle('probe:capture', async (_e, label) => {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const img = await win.webContents.capturePage()
  const file = path.join(OUT_DIR, `${label}-zoom${Math.round(currentZoom * 100)}-${Date.now()}.png`)
  fs.writeFileSync(file, img.toPNG())
  note(null, 'capture', file)
  return file
})

ipcMain.handle('probe:mark', (_e, text) => {
  const beats = [...panes.values()].map(p => `${p.id}=${p.heartbeat.count}`).join(' ')
  note(null, 'MARK', `${text} | beats ${beats}`)
})

ipcMain.handle('probe:quit', () => { app.quit() })

ipcMain.handle('probe:dump', () => {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const file = path.join(OUT_DIR, `state-${Date.now()}.json`)
  fs.writeFileSync(file, JSON.stringify({ snapshot: snapshot(), fullLog: log }, null, 2))
  note(null, 'dump', file)
  return file
})

// --------------------------------------------------------------------- boot

app.whenReady().then(async () => {
  await startServers()
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: '#14171b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.loadFile('host.html')
  if (process.argv.includes('--auto') || process.argv.includes('--diag')) {
    const mode = process.argv.includes('--diag') ? 'diag' : 'auto'
    win.webContents.once('did-finish-load', () => win.webContents.send('auto:start', mode))
  }
  setInterval(() => {
    if (win && !win.isDestroyed()) win.webContents.send('state', snapshot())
  }, 300)
  if (process.argv.includes('--auto') || process.argv.includes('--diag')) {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    setInterval(() => {
      fs.writeFileSync(path.join(OUT_DIR, 'live-state.json'),
        JSON.stringify({ snapshot: snapshot(), fullLog: log }, null, 2))
    }, 1000)
  }
})

app.on('window-all-closed', () => app.quit())
