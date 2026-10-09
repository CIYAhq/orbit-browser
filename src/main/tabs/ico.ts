/**
 * Minimal ICO reader (no Electron imports, unit-tested). Picks the frame closest to the size the
 * sidebar draws and returns it either as embedded PNG bytes or as top-down BGRA pixels, which the
 * runtime turns into a small PNG data URL (lane review MF-2: every favicon gets one size cap).
 */

export type IcoFrame =
  | { kind: 'png'; width: number; height: number; data: Uint8Array }
  | { kind: 'bgra'; width: number; height: number; data: Uint8Array }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function isIco(buf: Uint8Array): boolean {
  return buf.length >= 6 && buf[0] === 0 && buf[1] === 0 && (buf[2] === 1 || buf[2] === 2) && buf[3] === 0
}

/** The best frame for a `target`-pixel icon: the smallest at least that big, else the biggest. */
export function readIco(buf: Uint8Array, target = 32): IcoFrame | undefined {
  if (!isIco(buf)) return undefined
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const count = view.getUint16(4, true)
  const entries: { width: number; height: number; size: number; offset: number }[] = []
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    if (at + 16 > buf.length) break
    const width = view.getUint8(at) || 256
    const height = view.getUint8(at + 1) || 256
    const size = view.getUint32(at + 8, true)
    const offset = view.getUint32(at + 12, true)
    if (offset + size <= buf.length && size > 0) entries.push({ width, height, size, offset })
  }
  if (entries.length === 0) return undefined
  const big = entries.filter((e) => e.width >= target).sort((a, b) => a.width - b.width)
  const ordered = [...big, ...entries.filter((e) => e.width < target).sort((a, b) => b.width - a.width)]
  for (const entry of ordered) {
    const frame = readFrame(buf.subarray(entry.offset, entry.offset + entry.size), entry.width, entry.height)
    if (frame) return frame
  }
  return undefined
}

function readFrame(data: Uint8Array, width: number, height: number): IcoFrame | undefined {
  if (PNG_SIGNATURE.every((b, i) => data[i] === b)) return { kind: 'png', width, height, data }
  return readBmp(data)
}

/** A DIB (BITMAPINFOHEADER, then XOR pixels and the 1-bit AND mask), bottom-up. */
function readBmp(data: Uint8Array): IcoFrame | undefined {
  if (data.length < 40) return undefined
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const headerSize = v.getUint32(0, true)
  const width = v.getInt32(4, true)
  const height = Math.abs(v.getInt32(8, true)) / 2
  const bits = v.getUint16(14, true)
  const compression = v.getUint32(16, true)
  if (headerSize < 40 || width <= 0 || width > 256 || height <= 0 || height > 256 || compression !== 0) return undefined
  if (![1, 4, 8, 24, 32].includes(bits)) return undefined
  const colors = bits <= 8 ? v.getUint32(32, true) || 1 << bits : 0
  const paletteAt = headerSize
  const pixelsAt = paletteAt + colors * 4
  const xorStride = Math.ceil((width * bits) / 32) * 4
  const andStride = Math.ceil(width / 32) * 4
  const andAt = pixelsAt + xorStride * height
  if (andAt > data.length) return undefined
  const hasMask = andAt + andStride * height <= data.length
  const out = new Uint8Array(width * height * 4)
  let anyAlpha = false
  for (let y = 0; y < height; y++) {
    const row = pixelsAt + (height - 1 - y) * xorStride
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (bits === 32) {
        out[o] = data[row + x * 4] as number
        out[o + 1] = data[row + x * 4 + 1] as number
        out[o + 2] = data[row + x * 4 + 2] as number
        out[o + 3] = data[row + x * 4 + 3] as number
        if (out[o + 3]) anyAlpha = true
      } else if (bits === 24) {
        out[o] = data[row + x * 3] as number
        out[o + 1] = data[row + x * 3 + 1] as number
        out[o + 2] = data[row + x * 3 + 2] as number
        out[o + 3] = 255
      } else {
        const bitPos = x * bits
        const byte = data[row + (bitPos >> 3)] as number
        const index = (byte >> (8 - bits - (bitPos & 7))) & ((1 << bits) - 1)
        const p = paletteAt + index * 4
        out[o] = data[p] as number
        out[o + 1] = data[p + 1] as number
        out[o + 2] = data[p + 2] as number
        out[o + 3] = 255
      }
    }
  }
  // 32-bit frames carry alpha; older ones (or 32-bit with no alpha) use the AND mask.
  if (hasMask && (bits !== 32 || !anyAlpha)) {
    for (let y = 0; y < height; y++) {
      const row = andAt + (height - 1 - y) * andStride
      for (let x = 0; x < width; x++) {
        const transparent = ((data[row + (x >> 3)] as number) >> (7 - (x & 7))) & 1
        out[(y * width + x) * 4 + 3] = transparent ? 0 : 255
      }
    }
  }
  return { kind: 'bgra', width, height, data: out }
}
