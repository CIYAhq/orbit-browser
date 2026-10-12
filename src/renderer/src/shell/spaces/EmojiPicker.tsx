import { Search, Trash2 } from 'lucide-react'
import { type CSSProperties, type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EMOJI_CATEGORIES, type EmojiEntry, SKIN_TONES, withTone } from './emoji-data'
import './emoji-picker.css'

const RECENT_KEY = 'orbit.emoji.recent'
const TONE_KEY = 'orbit.emoji.tone'
const MAX_RECENT = 16
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u

interface Cell {
  emoji: string
  name: string
}

interface Section {
  id: string
  label: string
  cells: Cell[]
}

/** Emoji without skin-tone modifiers or variation selectors (for lookups and "same emoji" checks). */
const baseKey = (emoji: string): string => emoji.replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, '')

const BY_KEY = new Map<string, EmojiEntry>()
for (const category of EMOJI_CATEGORIES) {
  for (const entry of category.items) {
    const key = baseKey(entry.e)
    if (!BY_KEY.has(key)) BY_KEY.set(key, entry)
  }
}

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

function readTone(): string {
  try {
    const id = localStorage.getItem(TONE_KEY)
    return id && SKIN_TONES.some((t) => t.id === id) ? id : 'default'
  } catch {
    return 'default'
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable; the picker works without it.
  }
}

export interface EmojiPickerProps {
  onPick: (emoji: string) => void
  /** Shows a trash button that clears the icon (SP-05). */
  onRemove?: () => void
  /** The icon currently set (marked in the grid). */
  current?: string
  autoFocus?: boolean
  /** Six columns instead of eight, for narrow places like the sidebar. */
  compact?: boolean
}

/**
 * Emoji picker for Space icons (SP-05): search, skin tones, recently used,
 * category tabs and a keyboard-navigable grid.
 */
export function EmojiPicker({ onPick, onRemove, current, autoFocus, compact }: EmojiPickerProps) {
  const [query, setQuery] = useState('')
  const [toneId, setToneId] = useState(readTone)
  const [recent, setRecent] = useState(readRecent)
  const [highlight, setHighlight] = useState(-1)
  const [tonesOpen, setTonesOpen] = useState(false)
  const [activeTab, setActiveTab] = useState(() => (recent.length > 0 ? 'recent' : (EMOJI_CATEGORIES[0]?.id ?? '')))
  const inputRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const columns = compact ? 6 : 8
  const tone = SKIN_TONES.find((t) => t.id === toneId) ?? SKIN_TONES[0]
  const modifier = tone?.modifier ?? ''
  const currentKey = current ? baseKey(current) : ''

  // The search has the keyboard from the frame the picker first shows: what is typed finds the emoji.
  useLayoutEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  const sections = useMemo<Section[]>(() => {
    const toCell = (entry: EmojiEntry): Cell => ({ emoji: withTone(entry, modifier), name: entry.n })
    const typed = query.trim()
    const q = typed.toLowerCase()
    if (q) {
      const seen = new Set<string>()
      const cells: Cell[] = []
      // An emoji typed or inserted from the OS emoji panel is offered as it is.
      if (PICTOGRAPHIC.test(typed)) {
        seen.add(baseKey(typed))
        cells.push({ emoji: typed, name: BY_KEY.get(baseKey(typed))?.n ?? 'emoji' })
      }
      for (const category of EMOJI_CATEGORIES) {
        for (const entry of category.items) {
          const key = baseKey(entry.e)
          if (seen.has(key)) continue
          if (entry.n.includes(q) || (entry.k?.includes(q) ?? false)) {
            seen.add(key)
            cells.push(toCell(entry))
          }
        }
      }
      return [{ id: 'results', label: 'Search results', cells }]
    }
    const list: Section[] = []
    if (recent.length > 0) {
      list.push({
        id: 'recent',
        label: 'Recently used',
        cells: recent.map((emoji) => ({ emoji, name: BY_KEY.get(baseKey(emoji))?.n ?? 'emoji' })),
      })
    }
    for (const category of EMOJI_CATEGORIES) {
      list.push({ id: category.id, label: category.label, cells: category.items.map(toCell) })
    }
    return list
  }, [query, modifier, recent])

  const flat = useMemo(() => sections.flatMap((s) => s.cells), [sections])

  const tabs = useMemo(
    () => [
      ...(recent.length > 0 ? [{ id: 'recent', label: 'Recently used', icon: '🕘' }] : []),
      ...EMOJI_CATEGORIES.map(({ id, label, icon }) => ({ id, label, icon })),
    ],
    [recent.length],
  )

  useEffect(() => {
    if (highlight < 0) return
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [highlight])

  const pick = (emoji: string) => {
    const next = [emoji, ...recent.filter((r) => r !== emoji)].slice(0, MAX_RECENT)
    setRecent(next)
    save(RECENT_KEY, JSON.stringify(next))
    onPick(emoji)
  }

  const chooseTone = (id: string) => {
    setToneId(id)
    save(TONE_KEY, id)
    setTonesOpen(false)
  }

  const jumpTo = (id: string) => {
    setActiveTab(id)
    if (query) {
      setQuery('')
      setHighlight(-1)
    }
    requestAnimationFrame(() => {
      const grid = gridRef.current
      const section = grid?.querySelector<HTMLElement>(`[data-section="${id}"]`)
      if (grid && section) grid.scrollTo({ top: section.offsetTop })
    })
  }

  const onScroll = () => {
    const grid = gridRef.current
    if (!grid || query) return
    let visible = ''
    for (const el of grid.querySelectorAll<HTMLElement>('[data-section]')) {
      if (el.offsetTop > grid.scrollTop + 8) break
      visible = el.dataset.section ?? visible
    }
    if (visible && visible !== activeTab) setActiveTab(visible)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (flat.length === 0) return
    const inSearch = e.target === inputRef.current
    const go = (index: number) => {
      e.preventDefault()
      setHighlight(Math.max(0, Math.min(flat.length - 1, index)))
    }
    switch (e.key) {
      case 'ArrowDown':
        go(highlight < 0 ? 0 : highlight + columns)
        break
      case 'ArrowUp':
        if (highlight >= 0) go(highlight - columns)
        break
      case 'ArrowRight':
        // While typing in the search field, Left/Right keep moving the caret until the grid is in use.
        if (inSearch && highlight < 0 && query) return
        go(highlight < 0 ? 0 : highlight + 1)
        break
      case 'ArrowLeft':
        if (inSearch && highlight < 0 && query) return
        go(highlight < 0 ? 0 : highlight - 1)
        break
      case 'Enter': {
        const cell = flat[highlight] ?? flat[0]
        if (!cell) return
        e.preventDefault()
        pick(cell.emoji)
        break
      }
    }
  }

  let index = 0
  return (
    <div
      className={`emoji-picker${compact ? ' emoji-picker--compact' : ''}`}
      data-testid="emoji-picker"
      style={{ '--emoji-cols': columns } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <div className="emoji-picker__header">
        <label className="emoji-picker__search">
          <Search size={13} aria-hidden />
          <input
            ref={inputRef}
            className="emoji-picker__input"
            data-testid="emoji-search"
            placeholder="Search emoji"
            aria-label="Search emoji"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlight(-1)
            }}
          />
        </label>
        <button
          type="button"
          className="emoji-picker__icon-button"
          aria-label="Skin tone"
          aria-expanded={tonesOpen}
          title="Skin tone"
          data-testid="emoji-tone"
          onClick={() => setTonesOpen((open) => !open)}
        >
          <span className="emoji-picker__swatch" style={{ background: tone?.swatch }} />
        </button>
        {onRemove && (
          <button
            type="button"
            className="emoji-picker__icon-button"
            aria-label="Remove icon"
            title="Remove icon"
            data-testid="emoji-remove"
            onClick={onRemove}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {tonesOpen && (
        <div className="emoji-picker__tones" role="radiogroup" aria-label="Skin tones">
          {SKIN_TONES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={t.id === toneId}
              aria-label={t.label}
              title={t.label}
              className="emoji-picker__tone"
              data-testid="emoji-tone-option"
              onClick={() => chooseTone(t.id)}
            >
              <span className="emoji-picker__swatch" style={{ background: t.swatch }} />
            </button>
          ))}
        </div>
      )}
      {!query && (
        <div className="emoji-picker__tabs" role="tablist" aria-label="Emoji categories">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-label={tab.label}
              title={tab.label}
              className={`emoji-picker__tab${activeTab === tab.id ? ' is-active' : ''}`}
              data-testid="emoji-category"
              onClick={() => jumpTo(tab.id)}
            >
              {tab.icon}
            </button>
          ))}
        </div>
      )}
      <div className="emoji-picker__grid" ref={gridRef} role="listbox" aria-label="Emoji" onScroll={onScroll}>
        {flat.length === 0 && <div className="emoji-picker__empty">No emoji found</div>}
        {sections.map((section) =>
          section.cells.length === 0 ? null : (
            <div key={section.id} className="emoji-picker__section" data-section={section.id}>
              <div className="emoji-picker__section-label">{section.label}</div>
              <div className="emoji-picker__cells">
                {section.cells.map((cell) => {
                  const i = index++
                  const highlighted = i === highlight
                  const isCurrent = currentKey !== '' && baseKey(cell.emoji) === currentKey
                  return (
                    <button
                      key={`${section.id}:${cell.emoji}`}
                      type="button"
                      role="option"
                      aria-selected={highlighted}
                      aria-label={cell.name}
                      title={cell.name}
                      className={`emoji-picker__cell${highlighted ? ' is-highlighted' : ''}${isCurrent ? ' is-current' : ''}`}
                      data-testid="emoji-option"
                      data-emoji={cell.emoji}
                      data-index={i}
                      onClick={() => pick(cell.emoji)}
                    >
                      {cell.emoji}
                    </button>
                  )
                })}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  )
}
