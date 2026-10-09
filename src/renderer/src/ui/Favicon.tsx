import { Globe } from 'lucide-react'
import { useState } from 'react'

/** Site icon with a neutral fallback glyph (never blocks on network). */
export function Favicon({ src, size = 16 }: { src?: string; size?: number }) {
  const [failed, setFailed] = useState<string | undefined>()
  if (!src || failed === src) {
    return <Globe className="favicon favicon--fallback" width={size} height={size} strokeWidth={1.6} aria-hidden />
  }
  return (
    <img
      className="favicon"
      src={src}
      width={size}
      height={size}
      alt=""
      draggable={false}
      onError={() => setFailed(src)}
    />
  )
}
