import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LinkPillContent } from '../../../../shared/nav'
import { invoke } from '../../api'
import { useWindow } from '../../store'
import { paletteVars, usePalette } from '../../theme'
import './link-pill.css'

/**
 * The link status pill (SB-27): a small view main keeps in a bottom corner of the page card while a
 * link is hovered. It shows where the link goes, in the Space's theme, and tells main how wide the
 * pill came out, so the view fits it.
 */
export function LinkPillApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const [content, setContent] = useState<LinkPillContent | null>(null)
  const [leaving, setLeaving] = useState(false)
  const pill = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    // Newer content only: a reply and a push can cross.
    const take = (next: LinkPillContent | null) => {
      if (!live || !next) return
      setContent((current) => (current && current.key > next.key ? current : next))
      setLeaving(false)
    }
    const offShow = window.orbit.on('link:show', (payload) => take(payload as LinkPillContent))
    const offHide = window.orbit.on('link:hide', () => setLeaving(true))
    void invoke('nav.linkPill', {})
      .then(take)
      .catch(() => {})
    return () => {
      live = false
      offShow()
      offHide()
    }
  }, [])

  // Measure each new content and say how wide the pill is.
  useLayoutEffect(() => {
    if (!content || !pill.current) return
    const width = Math.ceil(pill.current.getBoundingClientRect().width)
    void invoke('nav.linkPillSize', { key: content.key, width }).catch(() => {})
  }, [content])

  return (
    <div
      className={`link-pill-view${leaving ? ' is-leaving' : ''}`}
      style={paletteVars(palette) as CSSProperties}
      data-testid="link-pill-view"
    >
      {content && (
        <div
          ref={pill}
          className="link-pill"
          style={{ maxWidth: content.maxWidth }}
          data-testid="link-pill"
          data-expanded={content.expanded ? 'true' : 'false'}
        >
          {content.text}
        </div>
      )}
    </div>
  )
}
