import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react'
import { type CSSProperties, useEffect, useState } from 'react'
import { DOWNLOADS_FLYOUT_PANEL } from '../../../shared/commands/downloads'
import { SHORTCUT_SHEET } from '../../../shared/commands/keys'
import { ROW_MENU_PANEL } from '../../../shared/row-menu'
import { TAB_SWITCHER_PANEL } from '../../../shared/tab-switcher'
import { invoke } from '../api'
import { DownloadsFlyout } from '../downloads/DownloadsFlyout'
import { ShortcutSheet } from '../keys/ShortcutSheet'
import { OrbitMotionConfig } from '../motion'
import { isSpacePanel, SpacePanels } from '../shell/spaces/SpacePanels'
import { useWindow } from '../store'
import { paletteVars, usePalette } from '../theme'
import { CommandBar } from './CommandBar'
import { installTypeahead } from './commandbar/typeahead'
import { PeekLayer } from './PeekLayer'
import { RowMenu } from './RowMenu'
import { SiteControls } from './site/SiteControls'
import { TabSwitcher } from './TabSwitcher'

// Keys typed before the bar mounts (CB-22). Only here: a Mini Window's bar takes its keys itself.
installTypeahead()

/**
 * Transparent full-window layer above the tab views. It is only visible while
 * something is open (command bar, Peek chrome, menus); clicking the backdrop closes it.
 * Children animate out (AnimatePresence) while main keeps the view up briefly.
 */
export function OverlayApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const overlay = win?.overlay
  const kind = overlay?.kind ?? 'none'
  // Pre-warm (CB-22): one hidden, inert command bar right after start-up.
  const [warm, setWarm] = useState(true)
  useEffect(() => {
    const id = setTimeout(() => setWarm(false), 600)
    return () => clearTimeout(id)
  }, [])
  return (
    <LazyMotion features={domAnimation} strict>
      <OrbitMotionConfig>
        <div
          className={`overlay overlay--${kind}`}
          style={paletteVars(palette) as CSSProperties}
          data-testid="overlay"
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget || kind === 'none') return
            void invoke('overlay.close', {})
            // CB-20: the sidebar stays usable: a click over it closes the bar and is passed on.
            const sidebar = win?.sidebar
            // Left clicks only: a right or middle click just closes the bar (review M5).
            const overSidebar = sidebar && (sidebar.visible || sidebar.peeking) && e.clientX < sidebar.width
            if (kind === 'commandbar' && e.button === 0 && overSidebar) {
              void invoke('search.forwardClick', { x: e.clientX, y: e.clientY })
            }
          }}
        >
          {warm && kind === 'none' && (
            <div className="cmdbar-warm" aria-hidden>
              <CommandBar warm mode="new-tab" initialQuery="" />
            </div>
          )}
          <AnimatePresence>
            {overlay?.kind === 'commandbar' && (
              <CommandBar key={overlay.nonce} mode={overlay.mode} initialQuery={overlay.query} dark={palette?.dark} />
            )}
          </AnimatePresence>
          {overlay?.kind === 'panel' && isSpacePanel(overlay.panel) && (
            <SpacePanels key={overlay.nonce} overlay={overlay} />
          )}
          {overlay?.kind === 'panel' && overlay.panel === 'site-controls' && (
            <SiteControls key={overlay.nonce} overlay={overlay} dark={palette?.dark} />
          )}
          {/* A sidebar row's right-click menu (tabs lane, TB-14). */}
          {overlay?.kind === 'panel' && overlay.panel === ROW_MENU_PANEL && (
            <RowMenu key={overlay.nonce} overlay={overlay} />
          )}
          {/* The recent-tab switcher, ⌃Tab (tabs lane, TB-05). */}
          {overlay?.kind === 'panel' && overlay.panel === TAB_SWITCHER_PANEL && (
            <TabSwitcher key={overlay.nonce} overlay={overlay} />
          )}
          {overlay?.kind === 'panel' && overlay.panel === SHORTCUT_SHEET && (
            <ShortcutSheet key={overlay.nonce} dark={palette?.dark} />
          )}
          {overlay?.kind === 'peek' && <PeekLayer key={overlay.nonce} overlay={overlay} />}
          {/* The downloads flyout (downloads lane, DL-14). */}
          <AnimatePresence>
            {overlay?.kind === 'panel' && overlay.panel === DOWNLOADS_FLYOUT_PANEL && (
              <DownloadsFlyout key={overlay.nonce} />
            )}
          </AnimatePresence>
        </div>
      </OrbitMotionConfig>
    </LazyMotion>
  )
}
