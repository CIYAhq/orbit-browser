import { AppWindow, ArrowRight, Globe, History, Layers, Search, Zap } from 'lucide-react'
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SearchResult } from '../../../shared/commands/commandbar'
import type { CommandBarMode } from '../../../shared/state'
import { invoke, perfMark } from '../api'
import { Favicon } from '../ui/Favicon'

const KIND_ICON = {
  tab: AppWindow,
  history: History,
  suggestion: Search,
  url: Globe,
  search: Search,
  action: Zap,
  space: Layers,
} as const

/** The command bar: type to search tabs, history and actions, or enter a URL. */
export function CommandBar({ mode, initialQuery }: { mode: CommandBarMode; initialQuery: string }) {
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<SearchResult[]>([])
  /** The query the shown results answer (they may still be an earlier query's). */
  const [answered, setAnswered] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Enter pressed before the results for the typed text arrived: open their top row then. */
  const pendingEnter = useRef<{ disposition?: 'new-tab' } | null>(null)

  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    if (mode === 'edit-url') input.select()
    requestAnimationFrame(() => perfMark('commandbar:open:painted'))
  }, [mode])

  useEffect(() => {
    let cancelled = false
    void invoke('search.query', { query, mode }).then((r) => {
      if (cancelled) return // a newer query's answer is on its way
      setResults(r)
      setAnswered(query)
      setSelected(0)
    })
    return () => {
      cancelled = true
    }
  }, [query, mode])

  const open = (result: SearchResult | undefined, disposition?: 'current' | 'new-tab') => {
    if (!result) return
    void invoke('search.open', { result, mode, disposition })
  }

  useEffect(() => {
    const pending = pendingEnter.current
    if (!pending || answered !== query) return
    pendingEnter.current = null
    const top = results[0]
    if (top) void invoke('search.open', { result: top, mode, disposition: pending.disposition })
  }, [answered, query, results, mode])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Emacs-style Ctrl+N/P list navigation (macOS only; Ctrl+N is New Window elsewhere).
    const ctrlNav = window.orbit.platform === 'darwin' && e.ctrlKey && !e.metaKey && !e.altKey
    if (e.key === 'ArrowDown' || (ctrlNav && e.key === 'n')) {
      e.preventDefault()
      setSelected((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp' || (ctrlNav && e.key === 'p')) {
      e.preventDefault()
      setSelected((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const disposition = e.metaKey || e.ctrlKey ? 'new-tab' : undefined
      // Rows from an earlier query (e.g. "switch to" a recent tab) must not be what Enter opens.
      if (answered === query) open(results[selected], disposition)
      else pendingEnter.current = { disposition }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      void invoke('overlay.close', {})
    }
  }

  const placeholder = mode === 'edit-url' ? 'Enter a URL or search' : 'Search or enter address…'
  return (
    <div className="cmdbar" role="dialog" aria-label="Command bar" data-testid="command-bar" data-mode={mode}>
      <div className="cmdbar__input-row">
        <Search size={18} className="cmdbar__search-icon" />
        <input
          ref={inputRef}
          className="cmdbar__input"
          data-testid="command-input"
          value={query}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {results.length > 0 && (
        <div className="cmdbar__results" role="listbox" data-testid="command-results">
          {results.map((r, i) => {
            const Icon = KIND_ICON[r.kind]
            return (
              <div
                key={r.id}
                role="option"
                aria-selected={i === selected}
                className={`cmdbar__result${i === selected ? ' is-selected' : ''}`}
                data-testid="command-result"
                data-kind={r.kind}
                onMouseMove={() => setSelected(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  open(r)
                }}
              >
                <span className="cmdbar__result-icon">
                  {r.kind === 'tab' || r.kind === 'history' ? <Favicon src={r.favicon} /> : <Icon size={16} />}
                </span>
                <span className="cmdbar__result-title">{r.title}</span>
                {r.subtitle && <span className="cmdbar__result-subtitle">{r.subtitle}</span>}
                {i === selected && <ArrowRight size={14} className="cmdbar__result-enter" />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
