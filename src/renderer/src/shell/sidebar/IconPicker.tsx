import { motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isFolderId } from '../../../../shared/ids'
import { invoke } from '../../api'
import { POPOVER } from '../../motion'
import { useIconPicker } from './ui-state'

/** A compact emoji set with search words (TB-12, FD-07). Any emoji can also be typed or pasted. */
const EMOJI: [string, string][] = [
  ['⭐', 'star favorite'],
  ['🔥', 'fire hot'],
  ['📌', 'pin'],
  ['📁', 'folder files'],
  ['📚', 'books docs read'],
  ['📝', 'note memo write'],
  ['📅', 'calendar date'],
  ['✉️', 'mail email'],
  ['💬', 'chat message'],
  ['🎵', 'music song'],
  ['🎬', 'movie video film'],
  ['📷', 'camera photo'],
  ['🛒', 'shop cart buy'],
  ['💰', 'money finance bank'],
  ['📈', 'chart growth stats'],
  ['🧪', 'test lab experiment'],
  ['🐛', 'bug issue'],
  ['🚀', 'rocket launch deploy'],
  ['💡', 'idea light'],
  ['🔧', 'tool settings wrench'],
  ['🧠', 'brain think'],
  ['🎨', 'art design paint'],
  ['🏠', 'home house'],
  ['💼', 'work job briefcase'],
  ['✈️', 'travel plane flight'],
  ['🍕', 'food pizza'],
  ['☕', 'coffee'],
  ['🎮', 'game play'],
  ['⚽', 'sport ball football'],
  ['🌍', 'world globe earth'],
  ['🔒', 'lock secure private'],
  ['🔑', 'key password'],
  ['❤️', 'heart love'],
  ['✅', 'done check todo'],
  ['❗', 'important alert'],
  ['🗂️', 'index archive'],
  ['🧾', 'receipt invoice'],
  ['📦', 'package box'],
  ['🎓', 'school study learn'],
  ['🐙', 'code repo octopus'],
  ['🤖', 'robot ai bot'],
  ['📰', 'news paper'],
  ['🎧', 'podcast audio headphones'],
  ['🌱', 'plant grow'],
  ['🏃', 'run fitness'],
  ['🧘', 'calm health'],
  ['🐶', 'dog pet'],
  ['🌙', 'moon night'],
]

/** Emoji picker for a tab or folder icon (TB-12, FD-07). Removing the icon restores the favicon. */
export function IconPicker() {
  const id = useIconPicker((s) => s.id)
  const [query, setQuery] = useState('')
  const [top, setTop] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (!id) return
    setQuery('')
    const root = ref.current?.parentElement
    const row = root?.querySelector<HTMLElement>(`[data-slot][data-key="${id}"], [data-fav-id="${id}"]`)
    if (root && row) {
      const r = row.getBoundingClientRect()
      const p = root.getBoundingClientRect()
      setTop(Math.max(4, Math.min(r.bottom - p.top + 4, p.height - 230)))
    }
    input.current?.focus()
  }, [id])
  useEffect(() => {
    if (!id) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) useIconPicker.setState({ id: null })
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [id])
  if (!id) return null
  const set = (icon: string | null) => {
    if (isFolderId(id)) void invoke('folders.setIcon', { folderId: id, icon })
    else void invoke('tabs.setIcon', { tabId: id, icon })
    useIconPicker.setState({ id: null })
  }
  const q = query.trim().toLowerCase()
  const list = q ? EMOJI.filter(([e, words]) => words.includes(q) || e === q) : EMOJI
  const typed = q && !/^[a-z0-9 ]+$/i.test(q) ? [...q][0] : undefined
  return (
    <motion.div
      className="icon-picker"
      ref={ref}
      style={{ top }}
      data-testid="icon-picker"
      role="dialog"
      aria-label="Choose icon"
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={POPOVER.in}
    >
      <input
        ref={input}
        className="icon-picker__search"
        placeholder="Search or type an emoji"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') useIconPicker.setState({ id: null })
          if (e.key === 'Enter') {
            const pick = typed ?? list[0]?.[0]
            if (pick) set(pick)
          }
        }}
      />
      <div className="icon-picker__grid">
        {typed && (
          <button type="button" className="icon-picker__emoji" onClick={() => set(typed)}>
            {typed}
          </button>
        )}
        {list.map(([emoji, words]) => (
          <button
            key={emoji}
            type="button"
            className="icon-picker__emoji"
            title={words.split(' ')[0]}
            data-testid="icon-choice"
            onClick={() => set(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      <button type="button" className="icon-picker__remove" onClick={() => set(null)}>
        Remove icon
      </button>
    </motion.div>
  )
}
