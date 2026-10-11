import {
  type Box,
  type DropTarget,
  dragSizes,
  dropTargetAt,
  insertPane,
  intersect,
  type LayoutPath,
  layoutBoxes,
  layoutLeaves,
  MAX_PANES,
  nodeAt,
  PANE_GAP,
  type PaneBox,
  type PaneSide,
  paneDropZone,
  removePane,
  type SplitAxis,
  sameLayout,
  setSizesAt,
  swapPanes,
} from '../../../../shared/split'
import type { SplitLayout, TabId } from '../../../../shared/state'
import { waapi } from '../../motion'
import { getSeq } from '../../store'
import { prefersReducedMotion, SNAPPY, SpringValue, STANDARD } from './spring'

/** Key of the drop indicator's placeholder pane. */
export const DROP_PANE = '__drop__'
/** Corner radius of page cards (SB-19); native views get the same radius. */
export const FRAME_RADIUS = 10
/** Follow the frame for at most this long after a sidebar/padding transition starts (review F6). */
const FOLLOW_CAP_MS = 700

/** True while the shell's sidebar column is mid-transition. */
function columnSliding(shell: HTMLElement): boolean {
  return shell
    .getAnimations()
    .some(
      (a) =>
        a instanceof CSSTransition && a.transitionProperty === 'grid-template-columns' && a.playState === 'running',
    )
}

export interface FrameModel {
  /** Leaf for a single tab, a tree for a split, null for an empty window. */
  layout: SplitLayout | null
  /** Panes without a page yet (drawn as placeholders, not reported to main). */
  blank: Set<TabId>
  focused: TabId | null
}

export interface DropPreview {
  tabId: TabId
  target: TabId
  side: PaneSide | 'center'
  /** A pane of the shown split being moved (SV-20) rather than a tab joining it. */
  move?: boolean
}

interface PaneAnim {
  x: SpringValue
  y: SpringValue
  w: SpringValue
  h: SpringValue
}

interface Drag {
  path: LayoutPath
  index: number
  axis: SplitAxis
  start: number
  startSizes: number[]
  length: number
  sizes: number[]
}

export const dividerKey = (path: LayoutPath, index: number) => `${path.join('.')}:${index}`

const rectOf = (a: PaneAnim): Box => ({ x: a.x.value, y: a.y.value, width: a.w.value, height: a.h.value })

function union(boxes: Box[]): Box | undefined {
  if (boxes.length === 0) return undefined
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.width))
  const bottom = Math.max(...boxes.map((b) => b.y + b.height))
  return { x, y, width: right - x, height: bottom - y }
}

/**
 * Lays out the content frame imperatively: pane cards, dividers and the focus ring are
 * positioned by writing styles, and pane rectangles go to the main process (which moves
 * the native page views) at most once per animation frame. React only renders which
 * elements exist; dragging a divider or animating panes never re-renders anything.
 */
export class PaneEngine {
  private host: HTMLElement | null = null
  /** Host rect in window coordinates. */
  private frame: Box = { x: 0, y: 0, width: 0, height: 0 }
  private model: FrameModel = { layout: null, blank: new Set(), focused: null }
  private preview: DropPreview | null = null
  private drag: Drag | null = null
  /** Sizes kept after a drag until the state echoes them back. */
  private held: { path: LayoutPath; sizes: number[] } | null = null
  private anims = new Map<TabId, PaneAnim>()
  private paneEls = new Map<TabId, HTMLElement>()
  private dividerEls = new Map<string, HTMLElement>()
  private ring: HTMLElement | null = null
  private raf = 0
  private followUntil = 0
  /**
   * Where the native page views stay while the sidebar slides in or out (SB-11, FL-02). They can't
   * move in step with the shell's frames, so they keep to the part of the frame the sidebar never
   * covers: showing, where they will end; hiding, where they were. The page-colour card (SB-19)
   * fills the rest, in step with the sidebar (review A-M4).
   */
  private slide: Box | null = null
  private lastReport = ''
  private cleanup: (() => void)[] = []
  /** Nothing is reported before the first model arrives (avoids hiding the views on mount). */
  private ready = false
  private reportRaf = 0
  /** True while running inside this frame's work (rAF tick, resize observer): reports go out at once. */
  private inFrame = false

  attach(host: HTMLElement): void {
    this.host = host
    this.measure()
    const onResize = () => this.inFrameDo(() => this.measure() && this.relayout(false))
    const observer = new ResizeObserver(onResize)
    observer.observe(host)
    window.addEventListener('resize', onResize)
    // Follow the frame every frame while the sidebar or content padding transitions (sidebar hide/show).
    // Only those elements count, and a time cap ends the loop even if an end event never arrives.
    const content = host.parentElement
    const shell = content?.parentElement
    const onRun = (e: TransitionEvent) => {
      if (e.target !== content && e.target !== shell) return
      if (e.propertyName !== 'grid-template-columns' && !e.propertyName.startsWith('padding')) return
      this.followUntil = performance.now() + FOLLOW_CAP_MS
      if (shell && content && e.target === shell && e.propertyName === 'grid-template-columns') {
        this.startSlide(shell, content)
      }
      this.schedule()
    }
    const onEnd = (e: TransitionEvent) => {
      if (e.target !== content && e.target !== shell) return
      requestAnimationFrame(() =>
        this.inFrameDo(() => {
          // A reversal cancels one slide and runs another: the slide is over once no column transition runs.
          if (this.slide && !(shell && columnSliding(shell))) this.endSlide()
          else if (this.measure()) this.relayout(false)
        }),
      )
    }
    document.addEventListener('transitionrun', onRun)
    document.addEventListener('transitionend', onEnd)
    document.addEventListener('transitioncancel', onEnd)
    this.cleanup.push(
      () => observer.disconnect(),
      () => window.removeEventListener('resize', onResize),
      () => document.removeEventListener('transitionrun', onRun),
      () => document.removeEventListener('transitionend', onEnd),
      () => document.removeEventListener('transitioncancel', onEnd),
    )
    this.relayout(false)
  }

  detach(): void {
    for (const fn of this.cleanup.splice(0)) fn()
    if (this.raf) cancelAnimationFrame(this.raf)
    if (this.reportRaf) cancelAnimationFrame(this.reportRaf)
    this.raf = 0
    this.reportRaf = 0
    this.host = null
  }

  registerPane(tabId: TabId, el: HTMLElement | null): void {
    if (el) {
      this.paneEls.set(tabId, el)
      const anim = this.anims.get(tabId)
      if (anim) this.writePane(el, rectOf(anim))
    } else this.paneEls.delete(tabId)
  }

  registerDivider(key: string, el: HTMLElement | null): void {
    if (el) this.dividerEls.set(key, el)
    else this.dividerEls.delete(key)
  }

  registerRing(el: HTMLElement | null): void {
    this.ring = el
  }

  /** New state from the store (layout, focus, blank panes). Animates when the same panes rearrange. */
  setModel(model: FrameModel): void {
    const before = this.model.layout ? layoutLeaves(this.model.layout) : []
    const after = model.layout ? layoutLeaves(model.layout) : []
    const related = after.some((id) => before.includes(id))
    if (this.held && model.layout) {
      const node = nodeAt(model.layout, this.held.path)
      const echoed =
        node && node.type !== 'leaf' && node.sizes.every((s, i) => Math.abs(s - (this.held?.sizes[i] ?? -1)) < 1e-6)
      if (echoed || !node || node.type === 'leaf') this.held = null
    }
    if (this.drag && model.layout) {
      // The split changed shape under a divider drag: drop the drag rather than resize the wrong container.
      const node = nodeAt(model.layout, this.drag.path)
      if (!node || node.type === 'leaf' || node.children.length !== this.drag.startSizes.length) this.drag = null
    } else if (!model.layout) this.drag = null
    if (this.preview?.move) {
      // A pane drag's preview ends as soon as the drop changes the stored layout.
      if (!sameLayout(this.model.layout, model.layout)) this.preview = null
    } else if (this.preview && after.includes(this.preview.tabId)) this.preview = null
    this.model = model
    this.ready = true
    this.relayout(related && !prefersReducedMotion())
  }

  /** Drop indicator for a tab dragged over the frame (SV-04), or null to clear it. */
  setPreview(preview: DropPreview | null): void {
    const same =
      preview?.tabId === this.preview?.tabId &&
      preview?.target === this.preview?.target &&
      preview?.side === this.preview?.side
    if (same) return
    this.preview = preview
    this.relayout(!prefersReducedMotion(), SNAPPY)
  }

  /** Current pane rectangles in window coordinates (target layout, not the animated one). */
  paneBoxes(): PaneBox[] {
    if (!this.model.layout) return []
    return this.boxesOf(this.model.layout)
  }

  /** Where `layout`'s panes are when this frame shows it (window coordinates; TB-09). */
  boxesOf(layout: SplitLayout): PaneBox[] {
    return layoutBoxes(layout, this.frame, PANE_GAP).panes
  }

  contains(x: number, y: number): boolean {
    const f = this.frame
    return x >= f.x && y >= f.y && x <= f.x + f.width && y <= f.y + f.height
  }

  /** Where a pane of the shown split dragged to (x, y) would go (SV-20). */
  paneDropTargetFor(x: number, y: number, tabId: TabId): { target: TabId; side: PaneSide | 'center' } | null {
    if (!this.contains(x, y)) return null
    const pane = this.paneBoxes().find(
      (p) =>
        p.tabId !== tabId &&
        x >= p.rect.x &&
        x <= p.rect.x + p.rect.width &&
        y >= p.rect.y &&
        y <= p.rect.y + p.rect.height,
    )
    return pane ? { target: pane.tabId, side: paneDropZone(pane.rect, x, y) } : null
  }

  /** Where a tab dragged to (x, y) would go; `full` when the shown split has no room. */
  dropTargetFor(x: number, y: number, tabId: TabId): (DropTarget & { full?: boolean }) | null {
    const layout = this.model.layout
    if (!layout) return null
    if (!this.contains(x, y)) return null
    const leaves = layoutLeaves(layout)
    if (leaves.includes(tabId)) return null
    const target = dropTargetAt(this.paneBoxes(), x, y)
    if (!target) return null
    return leaves.length >= MAX_PANES ? { ...target, full: true } : target
  }

  // ---- Divider drags (SV-13): 1:1 with the pointer, no React renders ----

  beginDrag(key: string, clientX: number, clientY: number): boolean {
    const layout = this.displayLayout()
    if (!layout) return false
    const local = { x: 0, y: 0, width: this.frame.width, height: this.frame.height }
    const divider = layoutBoxes(layout, local, PANE_GAP).dividers.find((d) => dividerKey(d.path, d.index) === key)
    const node = divider ? nodeAt(layout, divider.path) : undefined
    if (!divider || !node || node.type === 'leaf') return false
    const horizontal = divider.axis === 'row'
    this.drag = {
      path: divider.path,
      index: divider.index,
      axis: divider.axis,
      start: horizontal ? clientX : clientY,
      startSizes: [...node.sizes],
      length: horizontal ? divider.container.width : divider.container.height,
      sizes: [...node.sizes],
    }
    return true
  }

  moveDrag(clientX: number, clientY: number): void {
    const drag = this.drag
    const layout = this.model.layout
    if (!drag || !layout) return
    const node = nodeAt(layout, drag.path)
    if (!node) return
    const delta = (drag.axis === 'row' ? clientX : clientY) - drag.start
    drag.sizes = dragSizes(node, drag.startSizes, drag.index, delta, drag.length).sizes
    this.relayout(false)
  }

  /** Drops a drag without saving (its divider went away). */
  cancelDrag(key: string): void {
    if (this.drag && dividerKey(this.drag.path, this.drag.index) === key) this.drag = null
  }

  /** Ends a drag; returns the container path and its new sizes to save. */
  endDrag(): { path: LayoutPath; sizes: number[] } | null {
    const drag = this.drag
    this.drag = null
    if (!drag) return null
    const changed = drag.sizes.some((s, i) => Math.abs(s - (drag.startSizes[i] ?? 0)) > 1e-4)
    if (!changed) return null
    this.held = { path: drag.path, sizes: drag.sizes }
    return { path: drag.path, sizes: drag.sizes }
  }

  // ---- Layout ----

  private displayLayout(): SplitLayout | null {
    let layout = this.model.layout
    if (!layout) return null
    const sizes = this.drag ? { path: this.drag.path, sizes: this.drag.sizes } : this.held
    if (sizes) layout = setSizesAt(layout, sizes.path, sizes.sizes)
    const p = this.preview
    if (p?.move) {
      if (p.side === 'center') return swapPanes(layout, p.tabId, p.target)
      const without = removePane(layout, p.tabId)
      return without ? insertPane(without, p.target, DROP_PANE, p.side) : layout
    }
    if (p && p.side !== 'center' && !layoutLeaves(layout).includes(p.tabId)) {
      layout = insertPane(layout, p.target, DROP_PANE, p.side)
    }
    return layout
  }

  private measure(): boolean {
    if (!this.host) return false
    this.catchSlide(this.host)
    const r = this.host.getBoundingClientRect()
    const changed =
      r.left !== this.frame.x ||
      r.top !== this.frame.y ||
      r.width !== this.frame.width ||
      r.height !== this.frame.height
    this.frame = { x: r.left, y: r.top, width: r.width, height: r.height }
    return changed
  }

  /**
   * The sidebar's slide starts a frame along (FL-02), so its first frame already moves the frame,
   * before the transition's run event comes: whatever measures that frame first (the resize observer,
   * or the frame loop still following the last slide) starts the slide, from the frame as it was.
   */
  private catchSlide(host: HTMLElement): void {
    const content = host.parentElement
    const shell = content?.parentElement
    if (this.slide || !content || !shell || !columnSliding(shell)) return
    this.followUntil = performance.now() + FOLLOW_CAP_MS
    this.startSlide(shell, content)
    this.schedule()
  }

  /** Recomputes targets; springs toward them when `animate`, otherwise jumps. Writes at once. */
  private relayout(animate: boolean, params = STANDARD): void {
    const layout = this.displayLayout()
    const now = performance.now()
    const local = { x: 0, y: 0, width: this.frame.width, height: this.frame.height }
    const targets = layout ? layoutBoxes(layout, local, PANE_GAP).panes : []
    const keep = new Set(targets.map((t) => t.tabId))
    const previous = new Map([...this.anims].map(([id, a]) => [id, rectOf(a)]))
    for (const [id, rect] of previous) {
      if (keep.has(id)) continue
      this.anims.delete(id)
      // A pane closing within the same split fades and shrinks while its neighbours grow (SV-26).
      if (animate && id !== DROP_PANE && targets.length > 0) this.ghost(rect)
    }
    for (const { tabId, rect } of targets) {
      let anim = this.anims.get(tabId)
      // A drop zone already shown moves to its new half at once (FL-18); the panes making room glide.
      const zoneMoves = tabId === DROP_PANE && !!anim
      if (!anim) {
        const from = animate ? this.entryRect(tabId, rect, targets, previous) : rect
        anim = {
          x: new SpringValue(from.x),
          y: new SpringValue(from.y),
          w: new SpringValue(from.width),
          h: new SpringValue(from.height),
        }
        this.anims.set(tabId, anim)
      }
      // Without animation, values already in flight are retargeted (e.g. the frame resizes
      // while a pane is still growing); everything else jumps.
      const values: [SpringValue, number][] = [
        [anim.x, rect.x],
        [anim.y, rect.y],
        [anim.w, rect.width],
        [anim.h, rect.height],
      ]
      for (const [value, to] of values) {
        if (!zoneMoves && (animate || value.animating)) value.to(to, now, params)
        else value.jump(to)
      }
    }
    this.write()
    if ([...this.anims.values()].some((a) => a.x.animating || a.y.animating || a.w.animating || a.h.animating)) {
      this.schedule()
    }
  }

  /** A short-lived card where a closed pane was; the page view is already gone. */
  private ghost(r: Box): void {
    if (!this.host || r.width < 1 || r.height < 1) return
    const el = document.createElement('div')
    el.className = 'pane pane--ghost'
    el.dataset.testid = 'split-ghost'
    this.writePane(el, r)
    this.host.prepend(el)
    const at = `translate(${r.x}px, ${r.y}px)`
    const fade = el.animate(
      [
        { opacity: 1, transform: `${at} scale(1)` },
        { opacity: 0, transform: `${at} scale(0.96)` },
      ],
      { ...waapi('snappy'), fill: 'forwards' },
    )
    fade.onfinish = () => el.remove()
    fade.oncancel = () => el.remove()
  }

  /**
   * Where a new pane grows from: a zero-width (or zero-height) sliver at the edge of the
   * pane it splits, on the side it was added (SV-26), or the drop indicator's place.
   */
  private entryRect(tabId: TabId, target: Box, targets: PaneBox[], previous: Map<TabId, Box>): Box {
    const fromDrop = this.preview === null ? previous.get(DROP_PANE) : undefined
    if (fromDrop && tabId !== DROP_PANE) return fromDrop
    let best: { id: TabId; area: number } | undefined
    for (const [id, rect] of previous) {
      if (id === DROP_PANE) continue
      const o = intersect(rect, target)
      const area = o.width * o.height
      if (area > 0 && (!best || area > best.area)) best = { id, area }
    }
    const old = best ? previous.get(best.id) : undefined
    const now = best ? targets.find((t) => t.tabId === best?.id)?.rect : undefined
    if (!old || !now) return target
    if (target.x >= now.x + now.width - 1)
      return { x: old.x + old.width + PANE_GAP, y: target.y, width: 0, height: target.height }
    if (target.x + target.width <= now.x + 1)
      return { x: old.x - PANE_GAP, y: target.y, width: 0, height: target.height }
    if (target.y >= now.y + now.height - 1)
      return { x: target.x, y: old.y + old.height + PANE_GAP, width: target.width, height: 0 }
    return { x: target.x, y: old.y - PANE_GAP, width: target.width, height: 0 }
  }

  private schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.tick(t))
  }

  private inFrameDo(fn: () => void): void {
    this.inFrame = true
    try {
      fn()
    } finally {
      this.inFrame = false
    }
  }

  private tick(now: number): void {
    this.inFrameDo(() => this.step(now))
  }

  /** The sidebar's column started to slide: the views keep to where the frame is both now and at the end. */
  private startSlide(shell: HTMLElement, content: HTMLElement): void {
    const end = this.endFrame(shell, content)
    // A reversal starts from where the views are, not from where the frame has got to.
    const kept = end && intersect(this.slide ?? this.frame, end)
    this.slide = kept && kept.width >= 1 && kept.height >= 1 ? kept : null
  }

  /** The slide ended: the views go where the frame now is. */
  private endSlide(): void {
    this.slide = null
    this.lastReport = ''
    this.measure()
    this.relayout(false)
  }

  /**
   * Where the frame will be once the running sidebar and padding transitions end: measured with
   * them at their end, then put back where they were, all before the frame is drawn.
   */
  private endFrame(shell: HTMLElement, content: HTMLElement): Box | null {
    if (!this.host) return null
    const running = [...shell.getAnimations(), ...content.getAnimations()].filter(
      (a): a is CSSTransition =>
        a instanceof CSSTransition &&
        (a.transitionProperty === 'grid-template-columns' || a.transitionProperty.startsWith('padding')),
    )
    const times = new Map(running.map((a) => [a, a.currentTime]))
    try {
      for (const [a, time] of times) {
        const end = Number(a.effect?.getComputedTiming().endTime ?? 0)
        // Just short of the end, so the transition never finishes (or sends its end event) here.
        if (time !== null && end > 0) a.currentTime = end - 0.01
      }
      const r = this.host.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    } finally {
      for (const [a, time] of times) if (time !== null) a.currentTime = time
    }
  }

  private step(now: number): void {
    this.raf = 0
    // An end event that never came: the slide ends with the time cap.
    if (this.slide && now >= this.followUntil) this.endSlide()
    let moving = false
    for (const anim of this.anims.values()) {
      const a = anim.x.step(now)
      const b = anim.y.step(now)
      const c = anim.w.step(now)
      const d = anim.h.step(now)
      moving = moving || a || b || c || d
    }
    const following = now < this.followUntil
    if (following && this.measure()) this.relayout(false)
    else this.write()
    if (moving || following) this.schedule()
  }

  private writePane(el: HTMLElement, r: Box): void {
    el.style.transform = `translate(${r.x}px, ${r.y}px)`
    el.style.width = `${Math.max(0, r.width)}px`
    el.style.height = `${Math.max(0, r.height)}px`
  }

  /** Writes pane, divider and focus-ring styles from the animated rects, then reports to main. */
  private write(): void {
    for (const [id, el] of this.paneEls) {
      const anim = this.anims.get(id)
      // A pane lifted out of the layout (being dragged, SV-20) hides its card.
      el.style.visibility = anim ? '' : 'hidden'
      if (anim) this.writePane(el, rectOf(anim))
    }
    const layout = this.displayLayout()
    const split = !!layout && layout.type !== 'leaf'
    const placed = new Set<string>()
    if (layout && split) {
      const local = { x: 0, y: 0, width: this.frame.width, height: this.frame.height }
      for (const d of layoutBoxes(layout, local, PANE_GAP).dividers) {
        const el = this.dividerEls.get(dividerKey(d.path, d.index))
        const node = nodeAt(layout, d.path)
        if (!el || !node || node.type === 'leaf') continue
        const box = (child: SplitLayout | undefined) =>
          union(
            (child ? layoutLeaves(child) : [])
              .map((id) => this.anims.get(id))
              .filter((a): a is PaneAnim => !!a)
              .map(rectOf),
          )
        const a = box(node.children[d.index])
        const b = box(node.children[d.index + 1])
        if (!a || !b) continue
        const r =
          d.axis === 'row'
            ? {
                x: a.x + a.width,
                y: Math.min(a.y, b.y),
                width: Math.max(0, b.x - a.x - a.width),
                height: Math.max(a.height, b.height),
              }
            : {
                x: Math.min(a.x, b.x),
                y: a.y + a.height,
                width: Math.max(a.width, b.width),
                height: Math.max(0, b.y - a.y - a.height),
              }
        this.writePane(el, r)
        placed.add(dividerKey(d.path, d.index))
      }
    }
    // Dividers that don't exist in the drawn layout (e.g. while a drop indicator reshapes it) hide.
    for (const [key, el] of this.dividerEls) el.style.display = placed.has(key) ? '' : 'none'
    const focused = this.model.focused ? this.anims.get(this.model.focused) : undefined
    if (this.ring) {
      if (split && focused) {
        const r = rectOf(focused)
        this.ring.style.display = ''
        this.writePane(this.ring, { x: r.x - 2, y: r.y - 2, width: r.width + 4, height: r.height + 4 })
      } else this.ring.style.display = 'none'
    }
    this.report()
  }

  /** Sends the live panes' rectangles (window coordinates, clipped to the frame) to main. */
  /**
   * At most one pane report per animation frame. Work already running in this frame (the
   * animation tick, the resize observer) reports at once, so native views never trail the
   * cards by an extra frame; event-driven changes are coalesced into the next frame.
   */
  private report(): void {
    if (!this.ready) return
    if (this.inFrame) {
      this.sendReport()
      return
    }
    if (this.reportRaf) return
    this.reportRaf = requestAnimationFrame(() => {
      this.reportRaf = 0
      this.sendReport()
    })
  }

  private sendReport(): void {
    const frame = this.slide ?? this.frame
    const panes: { tabId: TabId; rect: Box }[] = []
    for (const [tabId, r] of this.reportedRects(frame)) {
      if (tabId === DROP_PANE || this.model.blank.has(tabId)) continue
      const rect = intersect({ x: frame.x + r.x, y: frame.y + r.y, width: r.width, height: r.height }, frame)
      if (rect.width < 1 || rect.height < 1) continue
      panes.push({ tabId, rect })
    }
    const key = JSON.stringify([panes, frame])
    if (key === this.lastReport) return
    this.lastReport = key
    window.orbit.send('layout.panes', { panes, radius: FRAME_RADIUS, seq: getSeq(), frame: { ...frame } })
  }

  /** The panes in `frame`: as drawn, or (the sidebar sliding) laid out in the part of the frame kept for the views. */
  private reportedRects(frame: Box): [TabId, Box][] {
    if (!this.slide) return [...this.anims].map(([tabId, anim]) => [tabId, rectOf(anim)])
    const layout = this.displayLayout()
    const local = { x: 0, y: 0, width: frame.width, height: frame.height }
    return (layout ? layoutBoxes(layout, local, PANE_GAP).panes : []).map((p) => [p.tabId, p.rect])
  }

  /** Forces the next report even if nothing changed (e.g. after main dropped one). */
  invalidate(): void {
    this.lastReport = ''
    this.write()
  }
}
