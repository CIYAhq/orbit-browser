import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isFolderId, isSplitId } from '../../../../shared/ids'
import { invoke } from '../../api'
import { POPOVER, useReducedMotion } from '../../motion'
import { useOrbit } from '../../store'
import { EmojiPicker } from '../spaces/EmojiPicker'
import { useIconPicker } from './ui-state'

/**
 * Change Icon… on a tab, folder, split or Favorite (TB-12, FD-07, SV-22): the Space icon's emoji
 * picker (SP-05) in its six-column form, under the row. Search, skin tones and the recently used
 * emoji are the Space picker's own; an emoji typed or pasted into the search is offered as it is.
 * Remove icon restores the favicon.
 */
export function IconPicker() {
  const id = useIconPicker((s) => s.id)
  // FL-25: it closes with the quick timing (fade and back to 0.97).
  return <AnimatePresence>{id && <IconPickerPanel key={id} id={id} />}</AnimatePresence>
}

const close = () => useIconPicker.setState({ id: null })

function IconPickerPanel({ id }: { id: string }) {
  const present = useIsPresent()
  // With reduced motion it only fades, also when the setting changes while it is open (FL-28).
  const reduced = useReducedMotion()
  const icon = useOrbit((s) =>
    isFolderId(id) ? s.folders[id]?.icon : isSplitId(id) ? s.splits[id]?.icon : s.tabs[id]?.icon,
  )
  const [top, setTop] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  // Under its row or Favorite, kept inside the sidebar.
  useLayoutEffect(() => {
    const panel = ref.current
    const root = panel?.parentElement
    const row = root?.querySelector<HTMLElement>(`[data-slot][data-key="${id}"], [data-fav-id="${id}"]`)
    if (!panel || !root || !row) return
    const r = row.getBoundingClientRect()
    const p = root.getBoundingClientRect()
    setTop(Math.max(4, Math.min(r.bottom - p.top + 4, p.height - panel.offsetHeight - 4)))
  }, [id])
  // Closing: it fades out, and keys go back to the sidebar at once.
  useEffect(() => {
    const focused = document.activeElement
    if (!present && focused instanceof HTMLElement && ref.current?.contains(focused)) focused.blur()
  }, [present])
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])
  const set = (value: string | null) => {
    if (isFolderId(id)) void invoke('folders.setIcon', { folderId: id, icon: value })
    else if (isSplitId(id)) void invoke('split.setIcon', { splitId: id, icon: value })
    else void invoke('tabs.setIcon', { tabId: id, icon: value })
    close()
  }
  return (
    <motion.div
      className="icon-picker"
      ref={ref}
      style={{ top }}
      data-testid="icon-picker"
      role="dialog"
      aria-label="Choose icon"
      initial={{ opacity: 0, scale: reduced ? 1 : 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: reduced ? 1 : 0.97, transition: POPOVER.out, pointerEvents: 'none' }}
      transition={POPOVER.in}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close()
      }}
    >
      <EmojiPicker compact autoFocus current={icon} onPick={set} onRemove={icon ? () => set(null) : undefined} />
    </motion.div>
  )
}
