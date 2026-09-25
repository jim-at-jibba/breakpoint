/**
 * Draws the application icon and writes every form the packagers ask for.
 *
 * The icon is the site wordmark's three bars ([MarketingLayout.astro]) on the
 * site's dark ground, so the app in the Dock and the logo on the page are the
 * same mark. The geometry below is the wordmark's own — 3px bars, 2px gaps,
 * 15px tall — scaled up; changing it here is changing the brand.
 *
 * Source of truth rather than a rasteriser: the shape is four rounded
 * rectangles, which a signed distance field draws exactly at any size with
 * real antialiasing, so this needs nothing installed. Run `npm run icons`.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ---- the mark ----------------------------------------------------------- */

/** The site's dark ground, `--color-bg` in [nocturne.css]. */
const GROUND = '#161826'

/** Bars 1, 3 and 6 of the pane palette — the wordmark's own three, in its order. */
const BARS = [oklch(0.76, 0.105, 218), oklch(0.76, 0.105, 128), oklch(0.76, 0.105, 332)]

/** The wordmark's proportions, in its own units: three 3-wide bars, 2 apart, 15 tall. */
const BAR_W = 3
const BAR_GAP = 2
const BAR_H = 15
const BAR_R = 1 // the wordmark's 1px radius on a 3px bar

/** How much of the icon's content box the bars stand in, by height. */
const BAR_SCALE = 0.62

/**
 * Two shapes, because the platforms disagree about the margin. macOS reserves
 * it — a full-bleed icon sits visibly larger than its neighbours in the Dock —
 * and Windows and Linux do not.
 */
const SHAPES = {
  mac: { inset: 0.1, radius: 0.225 },
  square: { inset: 0, radius: 0.22 }
}

/* ---- colour ------------------------------------------------------------- */

/** OKLCH as the site tokens write it, to the sRGB bytes a PNG stores. */
function oklch(lightness, chroma, hueDegrees) {
  const hue = (hueDegrees * Math.PI) / 180
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ].map(encode)
}

/** Linear light to an sRGB byte. */
function encode(channel) {
  const clamped = Math.min(1, Math.max(0, channel))
  const gamma = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
  return Math.round(gamma * 255)
}

function hex(value) {
  const n = parseInt(value.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/* ---- drawing ------------------------------------------------------------ */

/**
 * Signed distance from a point to a rounded rectangle: negative inside,
 * positive outside, and in pixels either way, which is what makes the one-pixel
 * coverage ramp below a real antialiased edge rather than a blur.
 */
function roundedBox(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - halfW + radius
  const qy = Math.abs(py - cy) - halfH + radius
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - radius
}

/** Coverage of a pixel centre by a shape, ramped across the edge. */
function coverage(distance) {
  return Math.min(1, Math.max(0, 0.5 - distance))
}

/** RGBA pixels for one icon, `size` square. */
function draw(size, shape) {
  const ground = hex(GROUND)
  const margin = size * shape.inset
  const box = size - margin * 2
  const centre = size / 2
  const groundHalf = box / 2
  const groundRadius = box * shape.radius

  const unit = (box * BAR_SCALE) / BAR_H
  const barHalfW = (BAR_W * unit) / 2
  const barHalfH = (BAR_H * unit) / 2
  const pitch = (BAR_W + BAR_GAP) * unit
  const barRadius = BAR_R * unit
  const barCentres = [centre - pitch, centre, centre + pitch]

  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      let alpha = coverage(roundedBox(px, py, centre, centre, groundHalf, groundHalf, groundRadius))
      let [r, g, b] = ground
      barCentres.forEach((barX, index) => {
        const on = coverage(roundedBox(px, py, barX, centre, barHalfW, barHalfH, barRadius))
        if (on === 0) return
        const [br, bg, bb] = BARS[index]
        r = r * (1 - on) + br * on
        g = g * (1 - on) + bg * on
        b = b * (1 - on) + bb * on
        alpha = alpha + on * (1 - alpha)
      })
      const at = (y * size + x) * 4
      pixels[at] = Math.round(r)
      pixels[at + 1] = Math.round(g)
      pixels[at + 2] = Math.round(b)
      pixels[at + 3] = Math.round(alpha * 255)
    }
  }
  return pixels
}

/* ---- PNG ---------------------------------------------------------------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A PNG of `pixels`, every scanline unfiltered — the shapes are flat, so filters buy little. */
function png(size, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // truecolour with alpha
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ---- ICO ---------------------------------------------------------------- */

/** Windows' container. Every image inside is a PNG, which it has taken since Vista. */
function ico(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // an icon, not a cursor
  header.writeUInt16LE(entries.length, 4)
  let offset = 6 + entries.length * 16
  const directory = entries.map(({ size, data }) => {
    const entry = Buffer.alloc(16)
    entry[0] = size === 256 ? 0 : size // 256 is written as 0; the field is one byte
    entry[1] = size === 256 ? 0 : size
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    return entry
  })
  return Buffer.concat([header, ...directory, ...entries.map((e) => e.data)])
}

/* ---- writing ------------------------------------------------------------ */

const cache = new Map()

function render(size, shape) {
  const key = `${shape}:${size}`
  const hit = cache.get(key)
  if (hit) return hit
  const data = png(size, draw(size, SHAPES[shape]))
  cache.set(key, data)
  return data
}

function write(path, data) {
  writeFileSync(join(ROOT, path), data)
  console.log(`${path} — ${(data.length / 1024).toFixed(1)}K`)
}

// The PNG electron-builder gives Linux, and the one the running app loads.
write('build/icon.png', render(1024, 'square'))
write('resources/icon.png', render(512, 'square'))

// Windows wants every size in one file, down to the 16px it draws in a title bar.
write(
  'build/icon.ico',
  ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: render(size, 'square') })))
)

// macOS wants an iconset, which only `iconutil` can seal into an .icns.
const iconset = join(ROOT, 'build/icon.iconset')
rmSync(iconset, { force: true, recursive: true })
mkdirSync(iconset, { recursive: true })
for (const size of [16, 32, 128, 256, 512]) {
  writeFileSync(join(iconset, `icon_${size}x${size}.png`), render(size, 'mac'))
  writeFileSync(join(iconset, `icon_${size}x${size}@2x.png`), render(size * 2, 'mac'))
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(ROOT, 'build/icon.icns')])
rmSync(iconset, { force: true, recursive: true })
console.log('build/icon.icns')
