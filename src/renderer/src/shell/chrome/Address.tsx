import { Check, Link2, ShieldBan, SlidersHorizontal, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { connectionOf } from '../../../../shared/nav'
import { displayHost } from '../../../../shared/url'
import { invoke, runAction } from '../../api'
import { activeTabId } from '../../selectors'
import { useOrbit } from '../../store'
import { withShortcut } from './shortcut-label'

/** How long the copy button shows its check mark. */
const COPIED_MS = 1200

/**
 * The address display under the top row (SB-04): the active tab's host only (the focused pane
 * in split view), a site-controls button that turns into a warning on insecure pages (no padlock
 * on secure ones), and a copy-link button. Clicking the host edits the URL in the command bar.
 * When the page tried to open pop-ups without a click, a button says so and offers them (NV-09).
 */
export function Address({ windowId }: { windowId: string }) {
  // Only the URL: the display re-renders on navigations, not on title, favicon or progress changes.
  const url = useOrbit((s) => {
    const id = activeTabId(s, windowId)
    return id ? (s.tabs[id]?.url ?? '') : ''
  })
  const blockedPopups = useOrbit((s) => {
    const id = activeTabId(s, windowId)
    return id ? (s.tabs[id]?.blockedPopups ?? 0) : 0
  })
  const page = url && url !== 'about:blank' ? url : ''
  const connection = connectionOf(page)
  const insecure = connection === 'insecure'
  // The page whose link was just copied: the check mark shows for it only, not for the next page.
  const [copiedFor, setCopiedFor] = useState('')
  const copied = !!page && copiedFor === page
  const copiedTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])

  const copy = () => {
    // Same as ⌘⇧C: the clean URL on the clipboard and a "Copied" toast (NV-17, TB-20).
    runAction('tab.copyUrl')
    setCopiedFor(page)
    window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopiedFor(''), COPIED_MS)
  }

  return (
    <div
      className={`address${page ? '' : ' address--empty'}${insecure ? ' address--insecure' : ''}`}
      data-testid="address"
      data-connection={connection}
    >
      {page && (
        <button
          type="button"
          className="address__button address__site"
          data-testid="site-controls-button"
          aria-label={insecure ? 'Not secure: site controls' : 'Site controls'}
          title={insecure ? 'Not secure. This connection is not encrypted.' : 'Site controls'}
          onClick={() => runAction('site.controls')}
        >
          {insecure ? <TriangleAlert size={13} data-testid="insecure-icon" /> : <SlidersHorizontal size={13} />}
        </button>
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
    </div>
  )
}
