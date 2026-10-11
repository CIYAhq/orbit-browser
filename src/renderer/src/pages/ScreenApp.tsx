import { CircleAlert, Frown, ShieldAlert, WifiOff } from 'lucide-react'
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PageScreenAction, PageScreenContent } from '../../../shared/pages'
import { invoke } from '../api'
import { useWindow } from '../store'
import { paletteVars, usePalette } from '../theme'
import './screen.css'

/**
 * What a page's area shows when its page couldn't load (NV-13) or crashed (NV-14), in a view main
 * keeps over that page only: a title, one plain sentence, the site, and the way on (Try again,
 * Reload, or Back to safety with Advanced → Proceed for a certificate). The keyboard lands on the
 * main button. When the network comes back while it shows, it tells main (which loads the page
 * again, once).
 */
export function ScreenApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const [content, setContent] = useState<PageScreenContent | null>(null)

  useEffect(() => {
    let heard = false
    const off = window.orbit.on('screen:content', (payload) => {
      heard = true
      setContent(payload as PageScreenContent)
    })
    // What main sent before this page listened is lost: ask for the screen now.
    void invoke('pages.screenContent', {}).then((first) => {
      if (!heard) setContent(first)
    })
    return off
  }, [])

  const act = useCallback((screen: PageScreenContent, action: PageScreenAction) => {
    void invoke('pages.screenAction', { id: screen.id, action })
  }, [])

  // The network is back: an error page loads again (main does it once).
  useEffect(() => {
    if (!content) return
    const onOnline = () => act(content, 'online')
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [content, act])

  return (
    <div className="page-screen-view" style={paletteVars(palette) as CSSProperties} data-testid="page-screen-view">
      {content && <ScreenCard key={content.id} content={content} act={act} />}
    </div>
  )
}

const ICONS = { error: CircleAlert, offline: WifiOff, cert: ShieldAlert, crash: Frown } as const

function ScreenCard({
  content,
  act,
}: {
  content: PageScreenContent
  act: (screen: PageScreenContent, action: PageScreenAction) => void
}) {
  const main = useRef<HTMLButtonElement>(null)
  const [advanced, setAdvanced] = useState(false)
  const Icon = ICONS[content.kind]
  const titleId = `page-screen-title-${content.id}`

  // The keyboard lands on the main button, now and whenever the view gets it back.
  useLayoutEffect(() => {
    if (document.hasFocus()) main.current?.focus()
  }, [])
  useEffect(() => {
    const onFocus = () => {
      if (!document.activeElement || document.activeElement === document.body) main.current?.focus()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  return (
    <main
      className={`page-screen is-${content.kind}`}
      aria-labelledby={titleId}
      data-testid="page-screen"
      data-screen-id={content.id}
      data-kind={content.kind}
    >
      <Icon className="page-screen__icon" aria-hidden="true" size={40} strokeWidth={1.5} />
      <h1 id={titleId} className="page-screen__title" data-testid="page-screen-title">
        {content.title}
      </h1>
      <p className="page-screen__message" data-testid="page-screen-message">
        {content.message}
      </p>
      {content.site && (
        <p className="page-screen__site" data-testid="page-screen-site">
          {content.site}
        </p>
      )}
      {content.code && (
        <p className="page-screen__code" data-testid="page-screen-code">
          {content.code}
        </p>
      )}
      <div className="page-screen__actions">
        {content.advanced && (
          <button
            type="button"
            className="page-screen__button"
            data-testid="page-screen-advanced"
            aria-expanded={advanced}
            onClick={() => setAdvanced((open) => !open)}
          >
            {advanced ? 'Hide advanced' : 'Advanced'}
          </button>
        )}
        <button
          ref={main}
          type="button"
          className="page-screen__button is-primary"
          data-testid="page-screen-action"
          onClick={() => act(content, content.action)}
        >
          {content.actionLabel}
        </button>
      </div>
      {content.advanced && advanced && (
        <div className="page-screen__advanced" data-testid="page-screen-details">
          <p>{content.advanced.text}</p>
          {content.advanced.proceedLabel && (
            <button
              type="button"
              className="page-screen__link"
              data-testid="page-screen-proceed"
              onClick={() => act(content, 'proceed')}
            >
              {content.advanced.proceedLabel}
            </button>
          )}
        </div>
      )}
    </main>
  )
}
