import { Volume2, VolumeX } from 'lucide-react'
import { useLayoutEffect } from 'react'
import type { OverlayState, Tab } from '../../../shared/state'
import { switcherOf } from '../../../shared/tab-switcher'
import { rowTitle } from '../../../shared/tabs'
import { invoke } from '../api'
import { CaptureIndicator } from '../shell/media/CaptureIndicator'
import { takeAllKeys } from '../shortcuts'
import { useOrbitShallow } from '../store'
import { Favicon } from '../ui/Favicon'
import './tab-switcher.css'

type PanelOverlay = Extract<OverlayState, { kind: 'panel' }>

/**
 * The recent-tab switcher (TB-05, FL-26): the five most recently used tabs of the window's sidebar,
 * the one shown first, in the middle of the window over a page that is not dimmed, in the Space's
 * colours (SP-16). Each tab shows its favicon, its title and, as its row does, whether it is using
 * the camera or microphone and whether it plays sound (MD-11).
 *
 * Main keeps the switch (`src/main/tabs/switcher.ts`): the keys step the highlight and letting go
 * of Control switches. The panel opens at the first Tab and has the keyboard from then on; its list
 * is drawn after a hold or at the second Tab. Main runs the switcher's keys without taking them from
 * the overlay, so they arrive here too and are taken here, to act once. Here, Esc ends the switch
 * with no switch, and any key without Control (a release main missed) on the highlighted tab. A
 * click on a tab switches to it; a click beside the list closes it (the overlay's backdrop).
 */
export function TabSwitcher({ overlay }: { overlay: PanelOverlay }) {
  const list = switcherOf(overlay)
  const ids = list?.tabs ?? []
  const index = list?.index ?? 0
  const tabs = useOrbitShallow((s) => ids.map((id) => s.tabs[id]))

  // Its keys are taken from the time it is up (main ran them already).
  useLayoutEffect(() => {
    const giveBack = takeAllKeys()
    const onKey = (e: KeyboardEvent) => {
      // Nothing here types or moves focus: a key that reaches the list does nothing else.
      if (e.type === 'keydown') e.preventDefault()
      if (e.key === 'Escape') {
        if (e.type === 'keydown') void invoke('tabs.endRecentSwitch', { cancel: true })
      } else if (!e.ctrlKey) {
        void invoke('tabs.endRecentSwitch', {})
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      giveBack()
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
    }
  }, [])

  const shown = tabs.filter((t): t is Tab => !!t)
  if (!list?.shown || shown.length === 0) return null
  return (
    <div className="tab-switcher__place">
      <div className="tab-switcher" role="listbox" aria-label="Recent tabs" data-testid="tab-switcher">
        {shown.map((tab) => {
          const { prefix, title } = rowTitle(tab)
          const selected = tab.id === ids[index]
          return (
            <div
              key={tab.id}
              className="tab-switcher__item"
              role="option"
              aria-selected={selected}
              data-testid="tab-switcher-item"
              data-tab-id={tab.id}
              onMouseDown={(e) => {
                if (e.button !== 0) return
                e.preventDefault()
                void invoke('tabs.endRecentSwitch', { tabId: tab.id })
              }}
            >
              <span className="tab-switcher__icon">
                {tab.icon ? <span className="tab-switcher__emoji">{tab.icon}</span> : <Favicon src={tab.favicon} />}
              </span>
              <span className="tab-switcher__title">
                {prefix && <span className="tab-switcher__crumb">{prefix} / </span>}
                {title}
              </span>
              <CaptureIndicator media={tab.media} />
              {(tab.audible || tab.muted) && (
                <span
                  className="tab-switcher__audio"
                  data-testid="tab-switcher-audio"
                  role="img"
                  aria-label={tab.muted ? 'Muted' : 'Playing sound'}
                >
                  {tab.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
