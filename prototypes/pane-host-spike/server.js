'use strict'
// Two loopback origins with DIFFERENT hostnames, so a navigation from A to B is
// cross-origin and has a chance of being cross-site (renderer process swap).
// Whether it actually swaps is measured, not assumed — see osPid in main.js.
const http = require('http')
const fs = require('fs')
const path = require('path')

const HOST_A = '127.0.0.1'
const PORT_A = 4100
const HOST_B = 'localhost'
const PORT_B = 4101

const ORIGIN_A = `http://${HOST_A}:${PORT_A}`
const ORIGIN_B = `http://${HOST_B}:${PORT_B}`

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' }

function serve (host, port) {
  const server = http.createServer((req, res) => {
    const name = (req.url === '/' ? '/index.html' : req.url).split('?')[0]
    const file = path.join(__dirname, 'fixture', path.normalize(name).replace(/^(\.\.[/\\])+/, ''))
    fs.readFile(file, 'utf8', (err, body) => {
      if (err) { res.writeHead(404); res.end('not found'); return }
      const out = body
        .replace(/\{\{ORIGIN_A\}\}/g, ORIGIN_A)
        .replace(/\{\{ORIGIN_B\}\}/g, ORIGIN_B)
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' })
      res.end(out)
    })
  })
  return new Promise(resolve => server.listen(port, host, () => resolve(server)))
}

async function startServers () {
  await Promise.all([serve(HOST_A, PORT_A), serve(HOST_B, PORT_B)])
}

module.exports = { startServers, ORIGIN_A, ORIGIN_B }
