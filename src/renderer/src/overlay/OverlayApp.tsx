import { applyPatches } from 'immer'
import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { DOWNLOADS_FLYOUT_PANEL } from '../../../shared/commands/downloads'
import { SHORTCUT_SHEET } from '../../../shared/commands/keys'
import type { CommandBarMode } from '../../../shared/state'
import { invoke } from '../api'
import { DownloadsFlyout } from '../downloads/DownloadsFlyout'
import { ShortcutSheet } from '../keys/ShortcutSheet'
import { OrbitMotionConfig } from '../motion'
import { isSpacePanel, SpacePanels } from '../shell/spaces/SpacePanels'
import { getOrbitState, useWindow } from '../store'
import { paletteVars, usePalette } from '../theme'
import { CommandBar } from './CommandBar'
import { installTypeahead } from './commandbar/typeahead'
import { PeekLayer } from './PeekLayer'
import { SiteControls } from './site/SiteControls'

// Keys typed before the bar mounts (CB-22). Only here: a Mini Window's bar takes its keys itself.
installTypeahead()

/**
 * The mirror's update for an open bar, applied to a copy and dropped: the first real open then runs
 * that code warm (CB-22).
 */
function rehearsePatch(mode: CommandBarMode): void {
  const state = getOrbitState()
  const id = window.orbit.windowId
  if (!state?.windows[id]) return
  try {
    applyPatches(state, [
      { op: 'replace', path: ['windows', id, 'overlay'], value: { kind: 'commandbar', mode, query: '', nonce: 0 } },
    ])
  } catch {
    // Nothing to warm.
  }
}

/** The bar's opens out of sight after start-up (CB-22): ⌘T's and ⌘L's, until the engine has compiled their code. */
const WARM_OPENS: readonly CommandBarMode[] = ['new-tab', 'edit-url', 'new-tab', 'edit-url']
/** How long each open out of sight stays: a few frames of its entrance. */
const WARM_OPEN_MS = 40

/**
 * Pre-warm (CB-22): right after start-up the bar opens a few times out of sight, so the first real
 * open runs code the engine has already compiled, as later opens do: the mirror's update, and an
 * invisible, inert bar's mount (in an AnimatePresence, as a real bar), focus, entrance and exit.
 * Then main warms its own part (search.warm). A real open ends it. Returns the mode of the bar to
 * show out of sight now, if any, and whether it is done.
 */
function useWarmUp(open: boolean): { mode: CommandBarMode | undefined; key: number; done: boolean } {
  const [step, setStep] = useState(0)
  const done = step >= WARM_OPENS.length * 2
  useEffect(() => {
    if (open) setStep(WARM_OPENS.length * 2)
  }, [open])
  useEffect(() => {
    if (done) {
      void invoke('search.warm', {})
      return
    }
    // Even steps show a bar, odd ones take it away: each open runs its mount, then its unmount.
    const mode = WARM_OPENS[step >> 1] ?? 'new-tab'
    if (step % 2 === 0) rehearsePatch(mode)
    const id = setTimeout(() => setStep((s) => s + 1), step % 2 === 0 ? WARM_OPEN_MS : 0)
    return () => clearTimeout(id)
  }, [step, done])
  return { mode: !done && step % 2 === 0 ? WARM_OPENS[step >> 1] : undefined, key: step, done }
}

/**
 * After a resize, main shows the idle overlay out of sight at the window's new size (CB-22); once it
 * has drawn there, it says so (search.warm) and main hides it again.
 */
function useRewarm(warm: boolean, idle: boolean): void {
  const idleRef = useRef(idle)
  idleRef.current = idle
  useEffect(() => {
    if (!warm) return
    let frame = 0
    const onResize = () => {
      if (!idleRef.current) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => void invoke('search.warm', {}))
      })
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(frame)
    }
  }, [warm])
}

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
  const warm = useWarmUp(kind !== 'none')
  useRewarm(warm.done, kind === 'none')
  return (
    <LazyMotion features={domAnimation} strict>
      <OrbitMotionConfig>
        <div
          className={`overlay overlay--${kind}`}
          style={paletteVars(palette) as CSSProperties}
          data-testid="overlay"
          data-warm={warm.done ? 'warm' : 'warming'}
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
          {/* The pre-warm's bars (CB-22): never seen, never focused once their mount is over. */}
          <AnimatePresence>
            {warm.mode && kind === 'none' && (
              <div key={warm.key} className="cmdbar-warm" aria-hidden>
                <CommandBar warm mode={warm.mode} initialQuery="" dark={palette?.dark} />
              </div>
            )}
          </AnimatePresence>
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
