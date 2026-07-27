// Draws the AiCut mark and writes build/icon.png and build/icon.ico.
// No image libraries: the shapes are simple enough to rasterise by hand, and a
// checked-in binary nobody can regenerate is worse than thirty lines of maths.
// Run with: npm run icon
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(root, 'build')

/** Sub-samples per axis, which is what keeps the curves from looking chewed. */
const SAMPLES = 4

const BACKDROP_TOP = [27, 33, 48]
const BACKDROP_BOTTOM = [14, 17, 25]
const ACCENT = [74, 227, 168]

const mix = (a, b, t) => a.map((channel, index) => Math.round(channel + (b[index] - channel) * t))

/** Signed-distance test for a rounded square, in 0..1 space. */
function insidePlate(x, y) {
  const inset = 0.055
  const radius = 0.235
  const left = inset
  const right = 1 - inset
  const dx = Math.max(left + radius - x, 0, x - (right - radius))
  const dy = Math.max(left + radius - y, 0, y - (right - radius))
  if (x < left || x > right || y < left || y > right) return false
  return Math.hypot(dx, dy) <= radius
}

/**
 * A play triangle with a slice taken out of it: the play head says video, the
 * gap says cut, and both survive being shrunk to a 16px taskbar tile.
 */
function insideMark(x, y) {
  const tip = 0.755
  const back = 0.315
  const top = 0.235
  const bottom = 1 - top

  if (x < back || x > tip) return false
  // How far across the triangle we are, so the wedge narrows toward the tip.
  const across = (x - back) / (tip - back)
  const half = (bottom - top) / 2
  const centre = 0.5
  const edge = half * (1 - across)
  if (y < centre - edge || y > centre + edge) return false

  // The cut: a diagonal slot through the body, left open at the tip.
  const slot = Math.abs(y - centre + (x - back) * 0.28) 
  return !(slot < 0.052 && x > back + 0.075)
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4)

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let plate = 0
      let mark = 0

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + (sx + 0.5) / SAMPLES) / size
          const y = (py + (sy + 0.5) / SAMPLES) / size
          if (insidePlate(x, y)) plate += 1
          if (insideMark(x, y)) mark += 1
        }
      }

      const total = SAMPLES * SAMPLES
      const plateAlpha = plate / total
      const markAlpha = (mark / total) * plateAlpha
      const backdrop = mix(BACKDROP_TOP, BACKDROP_BOTTOM, py / size)
      const colour = mix(backdrop, ACCENT, markAlpha)
      const offset = (py * size + px) * 4

      pixels[offset] = colour[0]
      pixels[offset + 1] = colour[1]
      pixels[offset + 2] = colour[2]
      pixels[offset + 3] = Math.round(plateAlpha * 255)
    }
  }

  return pixels
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function chunk(type, body) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  const tagged = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(tagged))
  return Buffer.concat([length, tagged, crc])
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  header[10] = 0
  header[11] = 0
  header[12] = 0

  // One filter byte per scanline; none of the filters earn their keep here.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let row = 0; row < size; row += 1) {
    raw[row * (size * 4 + 1)] = 0
    pixels.copy(raw, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Vista and later accept PNG-compressed entries, which keeps this short. */
function encodeIco(entries) {
  const directory = Buffer.alloc(6 + entries.length * 16)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(entries.length, 4)

  let offset = directory.length
  entries.forEach(({ size, png }, index) => {
    const at = 6 + index * 16
    directory[at] = size >= 256 ? 0 : size
    directory[at + 1] = size >= 256 ? 0 : size
    directory[at + 2] = 0
    directory[at + 3] = 0
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += png.length
  })

  return Buffer.concat([directory, ...entries.map((entry) => entry.png)])
}

mkdirSync(out, { recursive: true })

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const entries = icoSizes.map((size) => ({ size, png: encodePng(size, render(size)) }))

writeFileSync(path.join(out, 'icon.ico'), encodeIco(entries))
writeFileSync(path.join(out, 'icon.png'), encodePng(512, render(512)))

console.log(`icon.ico  ${icoSizes.join(', ')}px`)
console.log('icon.png  512px')
console.log(`written to ${out}`)
