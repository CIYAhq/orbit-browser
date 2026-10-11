import { nativeImage, type Session } from 'electron'

/** The sidebar controller shows artwork at 24 px; 48 px is sharp on 2× screens too. */
const ART_PX = 48
/** Every artwork kept is a data URL of at most this many characters. */
const MAX_DATA_URL = 32 * 1024
const MAX_FETCH_BYTES = 4 * 1024 * 1024
const FETCH_MS = 15_000

/**
 * The page's Media Session artwork (MD-09) as a small data: image, which is all the shell may show
 * (its content policy allows only data: images). Web images are fetched with the tab's session,
 * as its favicon is. Undefined when it can't be read.
 */
export async function loadArtwork(session: Session, url: string): Promise<string | undefined> {
  const raw = url.startsWith('data:') ? decodeDataUrl(url) : await fetchImage(session, url)
  return raw && smallImage(raw.buf, raw.type)
}

/** At most 48 px on its shorter side, as PNG; images nativeImage can't decode are kept if small. */
export function smallImage(buf: Buffer, type: string): string | undefined {
  if (buf.length === 0 || !type.startsWith('image/')) return undefined
  const fits = (url: string) => (url.length <= MAX_DATA_URL ? url : undefined)
  if (type !== 'image/svg+xml') {
    const image = nativeImage.createFromBuffer(buf)
    if (!image.isEmpty()) {
      const { width, height } = image.getSize()
      const scale = ART_PX / Math.min(width, height)
      const small =
        scale < 1
          ? image.resize({
              width: Math.max(1, Math.round(width * scale)),
              height: Math.max(1, Math.round(height * scale)),
              quality: 'best',
            })
          : image
      return fits(small.toDataURL())
    }
  }
  return fits(`data:${type};base64,${buf.toString('base64')}`)
}

function decodeDataUrl(url: string): { buf: Buffer; type: string } | undefined {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url)
  if (!m) return undefined
  try {
    const buf = /;base64/i.test(m[2] ?? '')
      ? Buffer.from(m[3] ?? '', 'base64')
      : Buffer.from(decodeURIComponent(m[3] ?? ''))
    return { buf, type: (m[1] || '').toLowerCase() }
  } catch {
    return undefined
  }
}

async function fetchImage(session: Session, url: string): Promise<{ buf: Buffer; type: string } | undefined> {
  try {
    const res = await session.fetch(url, { cache: 'force-cache', signal: AbortSignal.timeout(FETCH_MS) })
    const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!res.ok || !type.startsWith('image/') || !res.body) return undefined
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_FETCH_BYTES) {
        void reader.cancel()
        return undefined
      }
      chunks.push(value)
    }
    return { buf: Buffer.concat(chunks), type }
  } catch {
    return undefined
  }
}
