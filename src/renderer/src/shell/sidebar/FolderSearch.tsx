import { motion } from 'motion/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Tab } from '../../../../shared/state'
import { tabTitle } from '../../../../shared/tabs'
import { tabsInItem } from '../../../../shared/tree'
import { invoke } from '../../api'
import { POPOVER } from '../../motion'
import { useOrbit } from '../../store'
import { Favicon } from '../../ui/Favicon'
import { useFolderSearch } from './ui-state'

const NO_TABS: Tab[] = []
const NO_MAP: Record<string, Tab> = {}

/**
 * Folder preview and search (FD-08): a popover under the folder listing its tabs (nested
 * folders included, custom names shown) with a search field. Typing filters and selects the
 * first match; Enter or a click opens it (it peeks under the closed folder); Escape closes.
 */
export function FolderSearch() {
  const id = useFolderSearch((s) => s.id)
  const folderName = useOrbit((s) => (id ? s.folders[id]?.name : undefined))
  const tabIds = useOrbit((s) => (id ? tabsInItem(s, id).join(',') : ''))
  // Only watch the tabs while open (a stable empty map otherwise).
  const tabsMap = useOrbit((s) => (id ? s.tabs : NO_MAP))
  const tabs = useMemo(
    () =>
      tabIds
        ? tabIds
            .split(',')
            .map((t) => tabsMap[t])
            .filter((t): t is Tab => !!t)
        : NO_TABS,
    [tabIds, tabsMap],
  )
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [top, setTop] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()
  const matches = q
    ? tabs.filter((t) => tabTitle(t).toLowerCase().includes(q) || t.url.toLowerCase().includes(q))
    : tabs
  useLayoutEffect(() => {
    if (!id) return
    setQuery('')
    setSelected(0)
    const root = ref.current?.parentElement
    const row = root?.querySelector<HTMLElement>(`[data-slot][data-key="${id}"]`)
    if (root && row) {
      const r = row.getBoundingClientRect()
      const p = root.getBoundingClientRect()
      setTop(Math.max(4, Math.min(r.bottom - p.top + 4, p.height - 260)))
    }
    input.current?.focus()
  }, [id])
  useEffect(() => {
    if (!id) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) useFolderSearch.setState({ id: null })
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [id])
  if (!id) return null
  const open = (tab: Tab | undefined) => {
    if (!tab) return
    useFolderSearch.setState({ id: null })
    void invoke('tabs.activate', { tabId: tab.id })
  }
  return (
    <motion.div
      className="folder-search"
      ref={ref}
      style={{ top }}
      data-testid="folder-search"
      role="dialog"
      aria-label={`Search ${folderName ?? 'folder'}`}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={POPOVER.in}
    >
      <input
        ref={input}
        className="icon-picker__search"
        data-testid="folder-search-input"
        placeholder={`Search ${folderName ?? 'folder'}`}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setSelected(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') useFolderSearch.setState({ id: null })
          else if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSelected((i) => Math.min(matches.length - 1, i + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSelected((i) => Math.max(0, i - 1))
          } else if (e.key === 'Enter') open(matches[selected])
        }}
      />
      <div className="folder-search__list" role="listbox">
        {matches.length === 0 && <div className="folder-search__empty">No matching tabs</div>}
        {matches.map((t, i) => (
          <div
            key={t.id}
            role="option"
            aria-selected={i === selected}
            className={`folder-search__item${i === selected ? ' is-selected' : ''}`}
            data-testid="folder-search-item"
            onMouseMove={() => setSelected(i)}
            onPointerDown={(e) => {
              e.preventDefault()
              open(t)
            }}
          >
            <span className="tab-row__icon">
              {t.icon ? <span className="tab-row__emoji">{t.icon}</span> : <Favicon src={t.favicon} />}
            </span>
            <span className="tab-row__title">{tabTitle(t)}</span>
          </div>
        ))}
      </div>
    </motion.div>
  )
}
