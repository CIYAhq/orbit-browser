import { describe, expect, it } from 'vitest'
import { isIco, readIco } from '../../src/main/tabs/ico'

/** Builds an ICO from frames: { w, h, bits, pixel(x, y) → [b, g, r, a], mask?(x, y) } or raw PNG bytes. */
function ico(
  frames: (
    | {
        w: number
        h: number
        bits: 32 | 24
        pixel: (x: number, y: number) => number[]
        mask?: (x: number, y: number) => boolean
      }
    | { png: Uint8Array; w: number }
  )[],
): Uint8Array {
  const images = frames.map((f) => {
    if ('png' in f) return f.png
    const xorStride = Math.ceil((f.w * f.bits) / 32) * 4
    const andStride = Math.ceil(f.w / 32) * 4
    const out = new Uint8Array(40 + xorStride * f.h + andStride * f.h)
    const v = new DataView(out.buffer)
    v.setUint32(0, 40, true)
    v.setInt32(4, f.w, true)
    v.setInt32(8, f.h * 2, true)
    v.setUint16(12, 1, true)
    v.setUint16(14, f.bits, true)
    for (let y = 0; y < f.h; y++) {
      const row = 40 + (f.h - 1 - y) * xorStride
      for (let x = 0; x < f.w; x++) {
        const px = f.pixel(x, y)
        const o = row + x * (f.bits / 8)
        out[o] = px[0] as number
        out[o + 1] = px[1] as number
        out[o + 2] = px[2] as number
        if (f.bits === 32) out[o + 3] = px[3] as number
      }
      const andRow = 40 + xorStride * f.h + (f.h - 1 - y) * andStride
      for (let x = 0; x < f.w; x++)
        if (f.mask?.(x, y)) out[andRow + (x >> 3)] = (out[andRow + (x >> 3)] as number) | (0x80 >> (x & 7))
    }
    return out
  })
  const header = new Uint8Array(6 + 16 * frames.length)
  const hv = new DataView(header.buffer)
  hv.setUint16(2, 1, true)
  hv.setUint16(4, frames.length, true)
  let offset = header.length
  frames.forEach((f, i) => {
    const at = 6 + i * 16
    header[at] = f.w >= 256 ? 0 : f.w
    header[at + 1] = f.w >= 256 ? 0 : f.w
    hv.setUint32(at + 8, (images[i] as Uint8Array).length, true)
    hv.setUint32(at + 12, offset, true)
    offset += (images[i] as Uint8Array).length
  })
  const out = new Uint8Array(offset)
  out.set(header, 0)
  let at = header.length
  for (const img of images) {
    out.set(img, at)
    at += img.length
  }
  return out
}

describe('[TB-01] favicon ICO reader (lane review MF-2)', () => {
  it('picks the smallest frame at least 32 px and returns top-down BGRA pixels', () => {
    const buf = ico([
      { w: 16, h: 16, bits: 32, pixel: () => [1, 2, 3, 255] },
      { w: 64, h: 64, bits: 32, pixel: (x, y) => [x, y, 7, 255] },
      { w: 128, h: 128, bits: 32, pixel: () => [9, 9, 9, 255] },
    ])
    expect(buf.length).toBeGreaterThan(40 * 1024)
    expect(isIco(buf)).toBe(true)
    const frame = readIco(buf, 32)
    expect(frame).toMatchObject({ kind: 'bgra', width: 64, height: 64 })
    const data = (frame as { data: Uint8Array }).data
    // Pixel (x=5, y=3), top-down.
    const o = (3 * 64 + 5) * 4
    expect([...data.slice(o, o + 4)]).toEqual([5, 3, 7, 255])
  })

  it('uses the AND mask for alpha in 24-bit frames and returns embedded PNG frames as they are', () => {
    const masked = readIco(ico([{ w: 32, h: 32, bits: 24, pixel: () => [10, 20, 30], mask: (x) => x < 4 }]))
    const px = (frame: typeof masked, x: number, y: number) => {
      const o = (y * 32 + x) * 4
      return [...(frame as { data: Uint8Array }).data.slice(o, o + 4)]
    }
    expect(px(masked, 0, 0)).toEqual([10, 20, 30, 0])
    expect(px(masked, 10, 0)).toEqual([10, 20, 30, 255])
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    expect(readIco(ico([{ png, w: 32 }]))).toMatchObject({ kind: 'png', width: 32 })
    expect(readIco(new Uint8Array([1, 2, 3, 4, 5, 6, 7]))).toBeUndefined()
  })
})
