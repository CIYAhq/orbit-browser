import { Check, Link2, ShieldBan, SlidersHorizontal, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { connectionOf, peekShown, shownTabId } from '../../../../shared/nav'
import { SITE_PANEL } from '../../../../shared/site'
import { displayHost } from '../../../../shared/url'
import { invoke, runAction } from '../../api'
import { useOrbit } from '../../store'
import { withShortcut } from './shortcut-label'

/** How long the copy button shows its check mark. */
const COPIED_MS = 1200

/**
 * The address display under the top row (SB-04): the active tab's host only (the focused pane
 * in split view), a warning before it on insecure pages (no padlock on secure ones), a copy-link
 * button and, at the right end, the site controls button (NV-16), which opens the site controls
 * panel under the field. Clicking the host edits the URL in the command bar. When the page tried
 * to open pop-ups without a click, a button says so and offers them (NV-09).
 */
export function Address({ windowId }: { windowId: string }) {
  // Only the URL: the display re-renders on navigations, not on title, favicon or progress changes.
  // While a Peek shows, it is the Peek's page (PK-11).
  const url = useOrbit((s) => {
    const id = shownTabId(s, windowId)
    return id ? (s.tabs[id]?.url ?? '') : ''
  })
  const blockedPopups = useOrbit((s) => {
    const id = shownTabId(s, windowId)
    return id ? (s.tabs[id]?.blockedPopups ?? 0) : 0
  })
  // The site controls panel would take a Peek's place: no button for it while one shows.
  const peek = useOrbit((s) => peekShown(s, windowId))
  const page = url && url !== 'about:blank' ? url : ''
  const connection = connectionOf(page)
  const insecure = connection === 'insecure'
  // The page whose link was just copied: the check mark shows for it only, not for the next page.
  const [copiedFor, setCopiedFor] = useState('')
  const copied = !!page && copiedFor === page
  const copiedTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])
  const field = useRef<HTMLDivElement>(null)
  const panelOpen = useOrbit((s) => {
    const overlay = s.windows[windowId]?.overlay
    return overlay?.kind === 'panel' && overlay.panel === 'site-controls'
  })

  // The site controls panel hangs under the field (window coordinates: the sidebar's view starts
  // at the window's corner, docked or floating).
  const openControls = () => {
    const r = field.current?.getBoundingClientRect()
    void invoke('site.openControls', r ? { x: r.left, y: r.bottom + SITE_PANEL.gap } : {})
  }
  const openRef = useRef(openControls)
  openRef.current = openControls
  // The Site Controls action (command bar, a shortcut) while this sidebar shows.
  useEffect(() => window.orbit.on('sidebar:siteControls', () => openRef.current()), [])

  const copy = () => {
    // Same as ⌘⇧C: the clean URL on the clipboard and a "Copied" toast (NV-17, TB-20).
    runAction('tab.copyUrl')
    setCopiedFor(page)
    window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopiedFor(''), COPIED_MS)
  }

  return (
    <div
      ref={field}
      className={`address${page ? '' : ' address--empty'}${insecure ? ' address--insecure' : ''}`}
      data-testid="address"
      data-connection={connection}
    >
      {page && insecure && !peek && (
        <button
          type="button"
          className="address__button address__warning"
          data-testid="insecure-button"
          aria-label="Not secure: site controls"
          title="Not secure. This connection is not encrypted."
          onClick={openControls}
        >
          <TriangleAlert size={13} data-testid="insecure-icon" />
        </button>
      )}
      {page && insecure && peek && (
        <span className="address__button address__warning" title="Not secure. This connection is not encrypted.">
          <TriangleAlert size={13} data-testid="insecure-icon" />
        </span>
      )}
      <button
        type="button"
        className="address__host"
        data-testid="address-pill"
        title={page || withShortcut('Search or enter address', 'url.edit')}
        onClick={() => runAction('url.edit')}
      >
        <span className="address__text">{page ? displayHost(page) : 'Search or enter address'}</span>
      </button>
      {page && blockedPopups > 0 && (
        <button
          type="button"
          className="address__button address__blocked"
          data-testid="popups-blocked"
          aria-label={blockedPopups === 1 ? 'Pop-up blocked' : `${blockedPopups} pop-ups blocked`}
          title="Pop-ups blocked on this page"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            void invoke('nav.blockedPopupsMenu', { x: r.left, y: r.bottom + 4 })
          }}
        >
          <ShieldBan size={13} />
        </button>
      )}
      {page && (
        <button
          type="button"
          className={`address__button address__copy${copied ? ' is-copied' : ''}`}
          data-testid="copy-url-button"
          aria-label="Copy link"
          title={withShortcut('Copy link', 'tab.copyUrl')}
          onClick={copy}
        >
          {copied ? <Check size={13} /> : <Link2 size={14} />}
        </button>
      )}
      {page && !peek && (
        <button
          type="button"
          className={`address__button address__site${panelOpen ? ' is-open' : ''}`}
          data-testid="site-controls-button"
          aria-label="Site controls"
          aria-expanded={panelOpen}
          title={withShortcut('Site controls', 'site.controls')}
          onClick={openControls}
        >
          <SlidersHorizontal size={13} />
        </button>
      )}
    </div>
  )
}
