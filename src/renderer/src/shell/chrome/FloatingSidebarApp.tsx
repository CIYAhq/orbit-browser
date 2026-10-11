import { animate, type MotionValue, motion, useMotionValue } from 'motion/react'
import { type CSSProperties, useEffect, useLayoutEffect } from 'react'
import { invoke } from '../../api'
import { EASE, ONE_FRAME_S, SNAPPY, SNAPPY_EXIT, tween, useReducedMotion } from '../../motion'
import { useWindow } from '../../store'
import { useShellTheme } from '../../theme'
import { Sidebar } from '../sidebar/Sidebar'
import './chrome.css'

/** The window's left edge band that brings the card (FL-03: 4–8 px), as wide as the shell's edge zone. */
const EDGE_PX = 6
/** The card's margin from the window's edges with the sidebar hidden (`--gutter-hidden`). */
const GUTTER = 6
/** Room for the card's shadow: the card slides this much further than its own width plus margin. */
const SHADOW_ROOM = 16
/**
 * FL-03: from rest, in with the snappy timing and no overshoot, already a frame along in the first
 * frame so it moves at once; out with the quick curve in about 160 ms (FL-03's own 150–200 ms).
 */
const SLIDE_IN = tween('snappy', { delay: -ONE_FRAME_S })
const SLIDE_OUT = { duration: 0.16, ease: EASE.quick }

/**
 * The hidden sidebar's floating card (SB-12, FL-03). Pages are native views above the shell, so the
 * card lives in a transparent view of its own at the window's left edge, which main places while the
 * card is out. It holds everything the docked sidebar has, in the Space's theme, and slides in and
 * out on `sidebar.peeking`.
 */
export function FloatingSidebarApp() {
  const win = useWindow()
  const theme = useShellTheme(win?.spaceId)
  const peeking = !!win?.sidebar.peeking
  usePointerReports(peeking)
  // Docking from here (⌘S): the card stays put while the docked sidebar slides in beneath it.
  const out = !!win && (win.sidebar.peeking || win.sidebar.visible)
  useEdgeWhileLeaving(!!win && !out)
  const x = useSlide(out, win ? -(win.sidebar.width + GUTTER + SHADOW_ROOM) : undefined)
  if (!win) return null
  const style = { '--sidebar-w': `${win.sidebar.width}px` } as CSSProperties
  return (
    <div
      className={`shell float-sidebar${out ? ' is-out' : ''}${win.focused ? '' : ' shell--blurred'}`}
      style={style}
      ref={theme.shellRef}
      data-testid="floating-sidebar"
      data-out={out ? 'true' : 'false'}
      onMouseDown={(e) => {
        // Beside the card is the page: the card goes at once and the click goes on to the page.
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        const button = e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left'
        void invoke('sidebar.peekDismiss', { x: e.clientX, y: e.clientY, button })
      }}
    >
      <motion.div className="float-sidebar__slide" style={{ x }}>
        <div className="float-sidebar__shadow" aria-hidden />
        <div className="float-sidebar__card">
          <div className="shell-bg" ref={theme.backgroundRef} aria-hidden>
            <div className="shell-bg__grain" />
          </div>
          <Sidebar win={win} floating />
        </div>
      </motion.div>
    </div>
  )
}

/**
 * The card's slide: to 0 while it is out, to `hiddenX` (off the window's left edge) while it is not.
 * From rest it takes FL-03's timing curves. Turned round mid-way (the pointer back at the edge as it
 * leaves, or gone as it arrives), it takes the snappy spring, or its exit, from where the card is and
 * how fast it is going (FL-01: interruptions carry position and velocity). Under reduced motion it
 * moves at once (FL-28).
 */
function useSlide(out: boolean, hiddenX: number | undefined): MotionValue<number> {
  const reduced = useReducedMotion()
  // Far off the edge until the window's state arrives.
  const x = useMotionValue(-10_000)
  // Before the frame is drawn, so the card moves in the first frame after the state arrives.
  useLayoutEffect(() => {
    if (hiddenX === undefined) return
    const moving = x.isAnimating()
    // The first state: the card starts just off the edge (and slides in if it is out already).
    if (!moving && x.get() < hiddenX) x.jump(hiddenX)
    const target = out ? 0 : hiddenX
    if (!moving && x.get() === target) return
    if (reduced) {
      x.jump(target)
      return
    }
    animate(x, target, moving ? (out ? SNAPPY : SNAPPY_EXIT) : out ? SLIDE_IN : SLIDE_OUT)
  }, [out, hiddenX, reduced, x])
  useEffect(() => () => x.stop(), [x])
  return x
}

/**
 * While the card slides away its view still covers the window's left edge, so the shell's edge zone
 * can't hear a pointer coming back to it. The card listens there instead and brings itself back,
 * turning round from where it is (FL-03: re-entering the edge while it slides out reverses it).
 */
function useEdgeWhileLeaving(leaving: boolean) {
  useEffect(() => {
    if (!leaving) return
    let last = 0
    const onMove = (e: MouseEvent) => {
      if (e.buttons || e.clientX >= EDGE_PX) return
      const now = performance.now()
      if (now - last < 100) return
      last = now
      void invoke('sidebar.reveal', {})
    }
    document.addEventListener('mousemove', onMove, { passive: true })
    return () => document.removeEventListener('mousemove', onMove)
  }, [leaving])
}

/** How often a pointer moving over the card says so again (well inside main's grace delay). */
const REASSERT_MS = 250

const isEditable = (el: Element | null) =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement | null)?.isContentEditable

/**
 * Tells main whether the pointer is over the card (or just beside it) and whether a text field in it
 * has focus. The view reaches the window's top, left and bottom edges and ends beside the card, so
 * the pointer leaves it through an edge. A leave short of the edge says nothing about where the
 * pointer went: on over the window's resize border or the card's drag region, where nothing hears
 * it, or nowhere, as a menu or the command bar came up over the card. The card says so (`over:
 * null`), and main reads the pointer until a view hears it (round 2 fix check, M4).
 */
function usePointerReports(peeking: boolean) {
  useEffect(() => {
    if (!peeking) return
    let over: boolean | null = null
    let editing: boolean | null = null
    let said = 0
    let unsure = false
    const setOver = (value: boolean) => {
      // While the pointer moves over the card, say so now and then: main may have heard otherwise.
      const now = performance.now()
      if (value === over && (!value || now - said < REASSERT_MS)) return
      over = value
      said = now
      unsure = false
      void invoke('sidebar.peekState', { over: value })
    }
    const setEditing = (value: boolean) => {
      if (value === editing) return
      editing = value
      void invoke('sidebar.peekState', { editing: value })
    }
    const onMove = () => setOver(true)
    const onOut = (e: MouseEvent) => {
      if (e.relatedTarget || e.buttons) return
      const atEdge = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth - 1 || e.clientY >= innerHeight - 1
      if (atEdge) {
        setOver(false)
        return
      }
      over = null
      if (unsure) return
      unsure = true
      void invoke('sidebar.peekState', { over: null })
    }
    let focusTimer = 0
    const onFocus = () => {
      clearTimeout(focusTimer)
      // After a blur, focus lands on the next element a moment later.
      focusTimer = window.setTimeout(() => setEditing(!!isEditable(document.activeElement)), 0)
    }
    document.addEventListener('mousemove', onMove, { passive: true })
    document.addEventListener('mouseout', onOut)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('focusout', onFocus)
    onFocus()
    return () => {
      clearTimeout(focusTimer)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseout', onOut)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('focusout', onFocus)
    }
  }, [peeking])
}
