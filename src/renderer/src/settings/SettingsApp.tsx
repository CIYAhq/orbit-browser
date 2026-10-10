import { Search, X } from 'lucide-react'
import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SettingsReveal } from '../../../shared/commands/settings'
import { DEFAULT_PROFILE_ID } from '../../../shared/defaults'
import { NEUTRAL_THEME } from '../../../shared/theme'
import { invoke, isMac } from '../api'
import { useOrbit } from '../store'
import { cachedPalette, paletteVars, prefersReducedMotion, useDark } from '../theme'
import { type SettingsView, SettingsViewContext } from './context'
import { useCommitCounter } from './controls'
import { type SettingsSection, settingsSections } from './registry'
import './settings.css'

/**
 * The Settings window (ST-01): a sidebar of sections (./registry) and the selected section's page.
 * Changes apply at once; main stores them. The window takes the light/dark mode (AP-01) and the
 * theme colours of the Space it was opened from.
 */
export function SettingsApp() {
  useCommitCounter()
  const view = useReveal()
  const sections = settingsSections()
  const current = useOrbit((s) => s.settings.settingsSection)
  const section = sections.find((s) => s.id === current) ?? sections[0]
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLElement>(null)
  const [matches, setMatches] = useState<ReadonlySet<string> | undefined>()

  const palette = useSettingsPalette(view)
  const style = useMemo(() => paletteVars(palette), [palette])

  // A new opening shows what it asked for, not a search left from before.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per opening
  useEffect(() => setQuery(''), [view.nonce])

  useEffect(
    () =>
      window.orbit.on('settings.find', () => {
        searchRef.current?.focus()
        searchRef.current?.select()
      }),
    [],
  )

  // Each section starts at its top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on section changes only
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [section?.id])

  useRevealItem(contentRef, view, section?.id, query)

  const go = (id: string) => {
    setQuery('')
    if (id !== current) void invoke('settings.update', { settingsSection: id })
  }

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const i = sections.findIndex((s) => s.id === section?.id)
    const next =
      e.key === 'Home'
        ? sections[0]
        : e.key === 'End'
          ? sections[sections.length - 1]
          : sections[(i + (e.key === 'ArrowDown' ? 1 : sections.length - 1)) % sections.length]
    if (!next) return
    go(next.id)
    document.getElementById(`settings-tab-${next.id}`)?.focus()
  }

  if (!section) return null
  return (
    <SettingsViewContext.Provider value={view}>
      <div className="settings" data-testid="settings" data-dark={palette.dark ? '' : undefined} style={style}>
        {isMac && <div className="settings__drag" />}
        <nav className="settings__nav" aria-label="Settings">
          <label className="settings__search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search settings"
              aria-label="Search settings"
              data-testid="settings-search"
              value={query}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault()
                  setQuery('')
                }
              }}
            />
            {query && (
              <button type="button" className="settings__clear" aria-label="Clear search" onClick={() => setQuery('')}>
                <X size={12} />
              </button>
            )}
          </label>
          <div className="settings__tabs" role="tablist" aria-orientation="vertical" onKeyDown={onTabKey}>
            {sections.map((s) => {
              const Icon = s.icon
              const selected = !query && s.id === section.id
              return (
                <button
                  key={s.id}
                  id={`settings-tab-${s.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls="settings-panel"
                  tabIndex={s.id === section.id ? 0 : -1}
                  className="settings__tab"
                  data-testid={`settings-tab-${s.id}`}
                  data-dim={query && matches && !matches.has(s.id) ? '' : undefined}
                  onClick={() => go(s.id)}
                >
                  <Icon size={16} strokeWidth={1.9} />
                  <span>{s.label}</span>
                </button>
              )
            })}
          </div>
        </nav>
        <main
          ref={contentRef}
          id="settings-panel"
          className="settings__content"
          role="tabpanel"
          aria-labelledby={query ? undefined : `settings-tab-${section.id}`}
          aria-label={query ? 'Search results' : undefined}
          data-testid="settings-content"
          data-section={query ? 'search' : section.id}
        >
          <div className="settings__page">
            {query ? (
              <SearchResults query={query} sections={sections} onMatches={setMatches} onOpen={go} />
            ) : (
              <SectionPage key={section.id} section={section} />
            )}
          </div>
        </main>
      </div>
    </SettingsViewContext.Provider>
  )
}

function SectionPage({ section }: { section: SettingsSection }) {
  const Page = section.component
  return (
    <>
      <h1 className="settings__title">{section.label}</h1>
      <Page />
    </>
  )
}

/** What Settings was opened with: fetched at start, then pushed by main on each reopening. */
function useReveal(): SettingsView {
  const [view, setView] = useState<SettingsView>({ context: { profileId: DEFAULT_PROFILE_ID }, target: {}, nonce: -1 })
  useEffect(() => {
    let latest = -1
    const apply = (r: SettingsReveal) => {
      if (r.nonce < latest) return
      latest = r.nonce
      setView({ context: r.context, target: r.target, nonce: r.nonce })
    }
    void invoke('settings.context', {}).then(apply)
    return window.orbit.on('settings.reveal', (payload) => apply(payload as SettingsReveal))
  }, [])
  return view
}

/** The opener window's Space theme in the current light/dark mode (follows Space switches live). */
function useSettingsPalette(view: SettingsView) {
  const windowId = view.context.windowId
  const spaceId = useOrbit(
    (s) => (windowId ? s.windows[windowId]?.spaceId : undefined) ?? view.context.spaceId ?? s.spaceOrder[0],
  )
  const theme = useOrbit((s) => (spaceId ? s.spaces[spaceId]?.theme : undefined))
  const dark = useDark()
  const palette = cachedPalette(theme ?? NEUTRAL_THEME, dark)
  // Light/dark changes cross-fade (AP-01) instead of snapping.
  const lastDark = useRef(dark)
  useLayoutEffect(() => {
    if (lastDark.current === dark) return
    lastDark.current = dark
    const root = document.documentElement
    if (prefersReducedMotion()) return
    root.dataset.themeFade = ''
    const t = setTimeout(() => delete root.dataset.themeFade, 260)
    return () => clearTimeout(t)
  }, [dark])
  return palette
}

/** Scrolls to and highlights the row `settings.open({ item })` asked for (ST-02). */
function useRevealItem(
  contentRef: RefObject<HTMLElement | null>,
  view: SettingsView,
  sectionId: string | undefined,
  query: string,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening and section
  useEffect(() => {
    const item = view.target.item
    const root = contentRef.current
    if (!item || !root || query) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    // The row may render a moment later (a page that loads its data first).
    const find = () => {
      const id = CSS.escape(item)
      const row = root.querySelector<HTMLElement>(`[data-setting="${id}"], [data-setting-group="${id}"]`)
      if (!row) {
        if (++tries < 20) timer = setTimeout(find, 50)
        return
      }
      row.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
      row.dataset.flash = ''
      timer = setTimeout(() => delete row.dataset.flash, 1800)
    }
    find()
    return () => clearTimeout(timer)
  }, [view.nonce, sectionId])
}

/**
 * Settings search (ST-02): every section's page, showing only the rows whose text (or whose
 * section's name and keywords) contains every word typed.
 */
function SearchResults({
  query,
  sections,
  onMatches,
  onOpen,
}: {
  query: string
  sections: SettingsSection[]
  onMatches: (ids: ReadonlySet<string> | undefined) => void
  onOpen: (id: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [empty, setEmpty] = useState(false)

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const has = (text: string) => words.every((w) => text.includes(w))
    let reported: string | undefined
    const filter = () => {
      const found = new Set<string>()
      for (const block of root.querySelectorAll<HTMLElement>('[data-section-block]')) {
        const whole = has(block.dataset.keywords ?? '')
        let shown = 0
        for (const row of block.querySelectorAll<HTMLElement>('[data-setting]')) {
          const match = whole || has((row.textContent ?? '').toLowerCase())
          if (row.hidden === match) row.hidden = !match
          if (match) shown++
        }
        for (const group of block.querySelectorAll<HTMLElement>('.st-group')) {
          const visible = !!group.querySelector('[data-setting]:not([hidden])')
          if (group.hidden === visible) group.hidden = !visible
        }
        const visible = shown > 0
        if (block.hidden === visible) block.hidden = !visible
        if (visible) found.add(block.dataset.sectionBlock as string)
      }
      setEmpty(found.size === 0)
      const key = [...found].join(' ')
      if (key === reported) return
      reported = key
      onMatches(found)
    }
    filter()
    // Pages render rows as their data arrives: filter again when the DOM changes (not on the
    // `hidden` attributes set here, which are attribute changes).
    const observer = new MutationObserver(filter)
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      onMatches(undefined)
    }
  }, [query, onMatches])

  return (
    <div ref={ref} className="settings__results" data-testid="settings-results">
      {sections.map((s) => {
        const Page = s.component
        return (
          <div
            key={s.id}
            className="settings__result"
            data-section-block={s.id}
            data-keywords={[s.label, ...(s.keywords ?? [])].join(' ').toLowerCase()}
          >
            <button type="button" className="settings__result-title" onClick={() => onOpen(s.id)}>
              {s.label}
            </button>
            <Page />
          </div>
        )
      })}
      {empty && (
        <p className="settings__empty" data-testid="settings-no-results">
          No settings match “{query}”.
        </p>
      )}
    </div>
  )
}
