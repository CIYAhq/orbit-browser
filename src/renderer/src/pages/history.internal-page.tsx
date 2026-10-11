import { useEffect, useState } from 'react'
import type { LibraryShow } from '../../../shared/commands/archive'
import { invoke } from '../api'
import type { InternalPage } from '../internal/registry'
import { type HistoryCalls, HistorySection } from '../library/HistorySection'
import { LibraryToasts } from '../library/LibraryToasts'
import { useWindow } from '../store'
import { paletteVars, usePalette } from '../theme'
import '../library/library.css'
import './history-page.css'

/** Main answers about this tab's own profile only, and opens only the pages it listed here (D53). */
const PAGE_CALLS: HistoryCalls = {
  visits: ({ profileId: _, ...q }) => invoke('pages.history', q),
  open: (url, background) => invoke('pages.historyOpen', { url, background }),
  remove: (url) => invoke('pages.historyDelete', { url }),
  menu: (url, _profileId, x, y) => invoke('pages.historyMenu', { url, x, y }),
}

/**
 * `orbit://history/` (AR-10): the profile's browsing history as a page in a tab, the Library's
 * History section in the Space's colours. The list loads again each time main says the tab is
 * shown again (`history:shown`): pages were visited since.
 */
function HistoryPage() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const [show, setShow] = useState<LibraryShow>({ section: 'history', nonce: 1 })
  useEffect(() => window.orbit.on('history:shown', () => setShow((s) => ({ ...s, nonce: s.nonce + 1 }))), [])
  return (
    <div
      className="library history-page"
      style={paletteVars(palette)}
      data-testid="history-page"
      data-dark={palette?.dark ? 'true' : 'false'}
    >
      <div className="history-page__content">
        <HistorySection show={show} calls={PAGE_CALLS} />
      </div>
      <LibraryToasts />
    </div>
  )
}

export const page: InternalPage = {
  name: 'history',
  title: 'History',
  description: 'Every page visited in this profile, by day, with search.',
  component: HistoryPage,
}
