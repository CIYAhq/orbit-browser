/** Size SVG icons are drawn at for native menus: crisp at 16 px on 2× screens. */
const RASTER_PX = 32

const cache = new Map<string, Promise<string | undefined>>()

/**
 * A PNG data URL of an SVG image (a site's favicon). Native menus can't draw SVG, so the history
 * menu (NV-01) gets these instead. Cached per image; undefined when it can't be drawn.
 */
export function svgToPng(svg: string): Promise<string | undefined> {
  let drawn = cache.get(svg)
  if (drawn) return drawn
  drawn = new Promise<string | undefined>((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = RASTER_PX
        canvas.height = RASTER_PX
        canvas.getContext('2d')?.drawImage(img, 0, 0, RASTER_PX, RASTER_PX)
        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(undefined)
      }
    }
    img.onerror = () => resolve(undefined)
    img.src = svg
  })
  if (cache.size >= 64) cache.clear()
  cache.set(svg, drawn)
  return drawn
}

/** PNG renderings of the SVG favicons among `favicons`, keyed by the SVG data URL. */
export async function rasterizeSvgIcons(favicons: (string | undefined)[]): Promise<Record<string, string>> {
  const svgs = [...new Set(favicons.filter((f): f is string => !!f?.startsWith('data:image/svg+xml')))]
  const out: Record<string, string> = {}
  await Promise.all(
    svgs.map(async (svg) => {
      const png = await svgToPng(svg)
      if (png) out[svg] = png
    }),
  )
  return out
}
