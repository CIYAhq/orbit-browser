/**
 * Orbit's mark as a small glyph for the Mini Window button (MW-13): a planet, its tilted ring
 * passing in front of it, and a moon at the ring's end, as in the app icon. Drawn rather than
 * shipped: the macOS menu bar wants a black template image the system tints, and the other
 * platforms use it when the build has no icon file. Kept apart from Electron so it is unit-tested.
 */

/** The ring's tilt, as in the app icon. */
const TILT = (28 * Math.PI) / 180
/** Samples per pixel side, for smooth edges. */
const SAMPLES = 4

/** The mark's shapes on a 16-unit grid, centred on (8, 8). */
const RING = { rx: 6.6, ry: 2.5, stroke: 1.25 }
const PLANET = 3
const MOON = { u: 6.6, v: 0, r: 1.35 }
/** Clear space around what passes in front: the ring over the planet, the moon over the ring. */
const GAP = 0.8

/** Distance from (u, v) to the ellipse with radii rx, ry (first-order estimate: fine near the line). */
function ellipseDistance(u: number, v: number, rx: number, ry: number): number {
  const k = Math.hypot(u / rx, v / ry)
  if (k === 0) return Math.min(rx, ry)
  const gradient = Math.hypot(u / (rx * rx * k), v / (ry * ry * k))
  return (k - 1) / gradient
}

/** Whether a point of the 16-unit grid (relative to the centre) is ink. */
function ink(x: number, y: number): boolean {
  // Into the ring's own frame, where it lies flat; its near half is v > 0 (below the planet's centre).
  const u = x * Math.cos(TILT) - y * Math.sin(TILT)
  const v = x * Math.sin(TILT) + y * Math.cos(TILT)
  const moon = Math.hypot(u - MOON.u, v - MOON.v)
  if (moon <= MOON.r) return true
  if (moon <= MOON.r + GAP) return false
  const ring = Math.abs(ellipseDistance(u, v, RING.rx, RING.ry))
  if (ring <= RING.stroke / 2) return true
  const nearSide = v > 0 && ring <= RING.stroke / 2 + GAP
  return !nearSide && Math.hypot(x, y) <= PLANET
}

/**
 * The glyph as `size` x `size` pixels in one colour, for nativeImage.createFromBitmap: BGRA with
 * the colour premultiplied by each pixel's coverage.
 */
export function drawGlyph(size: number, [r, g, b]: readonly [number, number, number]): Buffer {
  const pixels = Buffer.alloc(size * size * 4)
  const unit = 16 / size
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) * unit - 8
          const y = (py + (sy + 0.5) / SAMPLES) * unit - 8
          if (ink(x, y)) hits++
        }
      }
      if (hits === 0) continue
      const alpha = Math.round((255 * hits) / (SAMPLES * SAMPLES))
      const i = (py * size + px) * 4
      pixels[i] = Math.round((b * alpha) / 255)
      pixels[i + 1] = Math.round((g * alpha) / 255)
      pixels[i + 2] = Math.round((r * alpha) / 255)
      pixels[i + 3] = alpha
    }
  }
  return pixels
}
