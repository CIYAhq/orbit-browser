import { Search, X, Zap } from 'lucide-react'
import { m, useIsPresent, useReducedMotion } from 'motion/react'
import {
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  findSiteSearch,
  mergeSuggestions,
  type OpenDisposition,
  type SearchResponse,
  type SearchResult,
  type SiteSearchInfo,
} from '../../../shared/commands/commandbar'
import type { CommandBarMode } from '../../../shared/state'
import { invoke, isMac, perfMark } from '../api'
import { activeTabId } from '../selectors'
import { getOrbitState, useOrbit } from '../store'
import { Favicon } from '../ui/Favicon'
import { ResultRow } from './commandbar/ResultRow'
import { claimTypeahead, installTypeahead, releaseTypeahead } from './commandbar/typeahead'

installTypeahead()

const ROW_H = 40
const INPUT_H = 56
const MAX_ROWS = 9

/** Keystroke → results-on-screen latencies (ms), newest last; read by e2e tests (CB-22). */
const latencies: number[] = []
;(window as unknown as { __orbitCommandBar: { latencies: number[] } }).__orbitCommandBar = { latencies }

/** Sample rows for the warm-up instance (one of each look). */
const WARM_ROWS: SearchResult[] = [
  { id: 'w1', kind: 'tab', title: 'Tab', subtitle: 'example.com', label: 'Tab', hint: 'Switch to tab', score: 0 },
  { id: 'w2', kind: 'search', title: 'Search', subtitle: 'Search', label: 'Search', score: 0 },
  { id: 'w3', kind: 'history', title: 'Page', subtitle: 'example.com/a', label: 'History', removable: true, score: 0 },
  { id: 'w4', kind: 'action', title: 'Action', label: 'Action', shortcut: 'Ctrl+T', score: 0 },
  { id: 'w5', kind: 'space', title: 'Space', label: 'Space', score: 0 },
]

/** Site search chip (CB-11) or actions-only mode (CB-14). */
type Scope = { kind: 'site'; site: SiteSearchInfo } | { kind: 'actions' } | null

/** Rows that fit between the input (about 36% down the window) and a 24 px bottom margin (CB-04). */
function rowsThatFit(): number {
  const h = window.innerHeight
  const top = Math.max(24, Math.round(h * 0.36 - INPUT_H / 2))
  return Math.max(3, Math.min(MAX_ROWS, Math.floor((h - top - INPUT_H - 24 - 13) / ROW_H)))
}

function useMaxRows(): number {
  const [rows, setRows] = useState(rowsThatFit)
  useEffect(() => {
    const onResize = () => setRows(rowsThatFit())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return rows
}

/**
 * The command bar (CB-01…CB-23): one field and one ranked result list. Ranking
 * runs in the main process per keystroke; this component keeps the field
 * responsive (native echo, inline completion re-applied synchronously) and only
 * swaps rows whose content changed.
 */
export function CommandBar({
  mode,
  initialQuery,
  dark,
  warm = false,
}: {
  mode: CommandBarMode
  initialQuery: string
  dark?: boolean
  /** An inert, hidden instance rendered once at overlay start-up so the first real open is as fast as later ones (CB-22). */
  warm?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [results, setResults] = useState<SearchResult[]>(warm ? WARM_ROWS : [])
  const [selected, setSelected] = useState(0)
  const [scope, setScopeState] = useState<Scope>(null)
  const maxRows = useMaxRows()
  const present = useIsPresent()
  // FL-28: with reduced motion the bar only fades (no scale or drop, not even for one frame).
  const reduced = useReducedMotion() ?? false
  const spaceId = useOrbit((s) => s.windows[window.orbit.windowId]?.spaceId)
  const suggestOn = useOrbit((s) => !!s.settings.searchSuggestions)
  const currentFavicon = useOrbit((s) => {
    const id = activeTabId(s)
    return id ? s.tabs[id]?.favicon : undefined
  })

  // Event-handler state that must not wait for a render.
  const st = useRef({
    typed: initialQuery,
    seq: 0,
    answered: 0,
    completion: undefined as SearchResponse['autocomplete'],
    noAuto: false,
    composing: false,
    pendingEnter: undefined as { disposition?: OpenDisposition } | undefined,
    results: [] as SearchResult[],
    selected: 0,
    scope: null as Scope,
    maxRows,
    closed: false,
    suggestOn,
    /** Latest engine suggestions (CB-15), kept while they still match so rows don't blink. */
    suggestions: [] as SearchResult[],
    suggestTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  }).current
  st.maxRows = maxRows
  st.suggestOn = suggestOn
  if (!present) st.closed = true

  // Plain (hoisted) functions: they read `st`, so they never go stale.
  function select(i: number) {
    st.selected = i
    setSelected(i)
  }

  function close() {
    if (st.closed) return
    st.closed = true
    void invoke('overlay.close', {})
  }

  function siteById(id: string): SiteSearchInfo | undefined {
    const s = (getOrbitState().settings.siteSearch ?? []).find((x) => x.id === id)
    return s ? { id: s.id, name: s.name, keyword: s.keyword } : undefined
  }

  function choose(r: SearchResult | undefined, disposition?: OpenDisposition) {
    if (!r || st.closed) return
    if (r.kind === 'sitesearch') {
      const site = r.siteSearchId ? siteById(r.siteSearchId) : undefined
      if (site) setScope({ kind: 'site', site })
      return
    }
    if ((r.kind === 'search' || r.kind === 'url') && !r.url) return
    st.closed = true
    void invoke('search.open', { result: r, mode, disposition })
  }

  /** Applies (or drops) the inline completion for the current text (CB-08). */
  function applyCompletion(ac: SearchResponse['autocomplete']) {
    const input = inputRef.current
    if (!input) return
    const typed = st.typed
    const caretAtEnd = input.selectionEnd === input.value.length
    if (
      ac &&
      !st.noAuto &&
      !st.composing &&
      !st.scope &&
      caretAtEnd &&
      ac.text.length > typed.length &&
      ac.text.toLowerCase().startsWith(typed.toLowerCase())
    ) {
      input.value = typed + ac.text.slice(typed.length)
      input.setSelectionRange(typed.length, input.value.length)
      st.completion = ac
    } else if (st.completion) {
      st.completion = undefined
      if (input.value !== typed) {
        input.value = typed
        input.setSelectionRange(typed.length, typed.length)
      }
    }
  }

  function runQuery() {
    const seq = ++st.seq
    const sentAt = performance.now()
    const scope = st.scope
    void invoke('search.query', {
      query: st.typed,
      mode,
      siteSearchId: scope?.kind === 'site' ? scope.site.id : undefined,
      actionsOnly: scope?.kind === 'actions',
      noAutocomplete: st.noAuto || st.composing,
    }).then((resp) => {
      if (seq !== st.seq || st.closed) return
      st.answered = seq
      applyCompletion(resp.autocomplete)
      const engineOn = st.suggestOn && !st.scope && !!st.typed.trim()
      // With engine suggestions on, local rows leave three slots for them.
      let rows = resp.results.slice(0, engineOn ? Math.max(3, st.maxRows - 3) : st.maxRows)
      if (engineOn) {
        const typed = st.typed.trim().toLowerCase()
        const still = st.suggestions.filter((r) => r.title.toLowerCase().startsWith(typed))
        rows = mergeSuggestions(rows, still, st.maxRows)
        requestSuggestions(seq)
      }
      st.results = rows
      setResults(rows)
      select(0)
      requestAnimationFrame(() => {
        latencies.push(performance.now() - sentAt)
        if (latencies.length > 100) latencies.shift()
      })
      const pending = st.pendingEnter
      if (pending) {
        st.pendingEnter = undefined
        choose(rows[0], pending.disposition)
      }
    })
  }

  /** Fetches engine suggestions and adds them below, never moving the highlighted row (FL-17). */
  function requestSuggestions(seq: number) {
    clearTimeout(st.suggestTimer)
    st.suggestTimer = setTimeout(() => {
      const query = st.typed
      void invoke('search.suggest', { query }).then((list) => {
        if (seq !== st.seq || st.closed || st.typed !== query) return
        st.suggestions = list
        const highlighted = st.results[st.selected]
        if (highlighted?.id.startsWith('engine:')) return
        const base = st.results.filter((r) => !r.id.startsWith('engine:'))
        const merged = mergeSuggestions(base, list, st.maxRows)
        if (merged.length === st.results.length && merged.every((r, i) => r.id === st.results[i]?.id)) return
        st.results = merged
        setResults(merged)
      })
    }, 60)
  }

  function setScope(next: Scope) {
    st.scope = next
    setScopeState(next)
    st.completion = undefined
    st.noAuto = false
    const input = inputRef.current
    if (input) {
      // Entering a scope starts an empty query; leaving one keeps the text.
      if (next) input.value = ''
      st.typed = input.value
    }
    runQuery()
  }

  function removeRow(r: SearchResult) {
    if (!r.removable) return
    void invoke('search.remove', { result: r }).then(() => {
      if (!st.closed) runQuery()
    })
  }

  // Stable callbacks for memoized rows.
  const latest = useRef({ select, choose, removeRow })
  latest.current = { select, choose, removeRow }
  const onRowHover = useCallback((i: number) => latest.current.select(i), [])
  const onRowChoose = useCallback(
    (r: SearchResult, e: MouseEvent) => latest.current.choose(r, e.metaKey || e.ctrlKey ? 'new-tab' : undefined),
    [],
  )
  const onRowRemove = useCallback((r: SearchResult) => latest.current.removeRow(r), [])

  // Mount: focus on the first frame, apply type-ahead, first query.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per open (the component is keyed by nonce)
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input || warm) return
    st.closed = false
    const buffered = claimTypeahead()
    const editing = mode === 'edit-url' && initialQuery
    input.value = buffered.text ? (editing ? buffered.text : initialQuery + buffered.text) : initialQuery
    st.typed = input.value
    input.focus()
    if (editing && !buffered.text) input.select()
    else input.setSelectionRange(input.value.length, input.value.length)
    requestAnimationFrame(() => perfMark('commandbar:open:painted'))
    if (buffered.enter) st.pendingEnter = {}
    runQuery()
    return () => {
      st.closed = true
      clearTimeout(st.suggestTimer)
      releaseTypeahead(buffered.token)
    }
  }, [])

  // CB-19 / FL-17: switching Space keeps the bar open and refreshes results for the new Space and profile.
  const firstSpace = useRef(spaceId)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runQuery reads live state from st; warm never changes
  useEffect(() => {
    if (warm || spaceId === firstSpace.current) return
    firstSpace.current = spaceId
    if (!st.closed) runQuery()
  }, [spaceId, st])

  const onInput = (e: FormEvent<HTMLInputElement>) => {
    const input = e.currentTarget
    const inputType = (e.nativeEvent as InputEvent).inputType ?? ''
    const deleting = inputType.startsWith('delete')
    const v = input.value
    // "/ " at the start is the older way into actions mode (CB-14).
    if (!st.scope && v === '/ ' && !deleting) {
      setScope({ kind: 'actions' })
      return
    }
    st.typed = v
    st.noAuto = deleting
    // Keep a still-matching completion while typing forward, so it never flickers (CB-08, FL-17).
    const c = st.completion
    if (
      c &&
      !deleting &&
      !st.composing &&
      input.selectionEnd === v.length &&
      c.text.length > v.length &&
      c.text.toLowerCase().startsWith(v.toLowerCase())
    ) {
      input.value = v + c.text.slice(v.length)
      input.setSelectionRange(v.length, input.value.length)
    } else {
      st.completion = undefined
    }
    runQuery()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget
    if (e.nativeEvent.isComposing || st.composing) return // IME owns the keys (CB-22)
    const ctrlNav = isMac && e.ctrlKey && !e.metaKey && !e.altKey
    const n = st.results.length
    if (e.key === 'ArrowDown' || (ctrlNav && e.key === 'n')) {
      e.preventDefault()
      if (n) select(Math.min(n - 1, st.selected + 1))
    } else if (e.key === 'ArrowUp' || (ctrlNav && e.key === 'p')) {
      e.preventDefault()
      if (n) select(Math.max(0, st.selected - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = st.results[st.selected]
      const disposition: OpenDisposition | undefined =
        e.metaKey || e.ctrlKey || (e.altKey && row?.kind === 'tab') ? 'new-tab' : undefined
      // Type-ahead: Enter before the latest results arrived runs the top row once they do.
      if (st.answered !== st.seq) st.pendingEnter = { disposition }
      else choose(row, disposition)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (st.scope) setScope(null)
      else close()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey || st.scope) return
      if (input.value === '') {
        setScope({ kind: 'actions' })
        return
      }
      const site = findSiteSearch(getOrbitState().settings.siteSearch ?? [], st.typed)
      if (site) setScope({ kind: 'site', site })
    } else if (e.key === 'Backspace' && st.scope && input.value === '') {
      e.preventDefault()
      setScope(null)
    } else if (
      (isMac && e.key === 'Backspace' && e.metaKey && e.altKey) ||
      (!isMac && e.key === 'Delete' && e.shiftKey)
    ) {
      const row = st.results[st.selected]
      if (row?.removable) {
        e.preventDefault()
        removeRow(row)
      }
    } else if (
      (e.key === 'ArrowRight' || e.key === 'End' || e.key === 'ArrowLeft' || e.key === 'Home') &&
      st.completion
    ) {
      // Moving the caret accepts the completion (the caret moves natively); results follow the full text.
      queueMicrotask(() => {
        st.typed = input.value
        st.completion = undefined
        st.noAuto = true
        runQuery()
      })
    }
  }

  const placeholder =
    scope?.kind === 'site'
      ? `Search ${scope.site.name}…`
      : scope?.kind === 'actions'
        ? 'Run an action…'
        : mode === 'edit-url'
          ? 'Enter a URL or search'
          : 'Search or enter address…'

  return (
    <>
      <m.div
        className="cmdbar-scrim"
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: 0.14 } }}
        exit={{ opacity: 0, transition: { duration: 0.1 } }}
      />
      <div className="cmdbar-layer">
        <m.div
          className={`cmdbar${dark ? ' cmdbar--dark' : ''}`}
          role="dialog"
          aria-label="Command bar"
          data-testid={warm ? undefined : present ? 'command-bar' : 'command-bar-closing'}
          data-mode={mode}
          data-scope={scope?.kind ?? ''}
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -4 }}
          animate={
            reduced
              ? { opacity: 1, transition: { duration: 0.1 } }
              : {
                  opacity: 1,
                  scale: 1,
                  y: 0,
                  transition: { type: 'spring', stiffness: 632, damping: 45, mass: 1, opacity: { duration: 0.12 } },
                }
          }
          exit={
            reduced
              ? { opacity: 0, transition: { duration: 0.08 } }
              : { opacity: 0, scale: 0.98, transition: { duration: 0.1, ease: [0.2, 0, 0, 1] } }
          }
        >
          <div className="cmdbar__input-row">
            {scope ? (
              <span className="cmdbar__chip" data-testid="command-chip">
                {scope.kind === 'actions' ? <Zap size={13} /> : <Search size={13} />}
                {scope.kind === 'actions' ? 'Actions' : scope.site.name}
                <button
                  type="button"
                  className="cmdbar__chip-x"
                  aria-label="Leave this mode"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setScope(null)
                  }}
                >
                  <X size={11} />
                </button>
              </span>
            ) : mode === 'edit-url' && currentFavicon ? (
              <span className="cmdbar__lead">
                <Favicon src={currentFavicon} size={18} />
              </span>
            ) : (
              <Search size={18} className="cmdbar__lead cmdbar__lead--search" />
            )}
            <input
              ref={inputRef}
              className="cmdbar__input"
              data-testid={warm ? undefined : 'command-input'}
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
              role="combobox"
              aria-expanded={results.length > 0}
              aria-controls="cmdbar-list"
              aria-autocomplete="both"
              aria-activedescendant={results.length ? `cmdbar-option-${selected}` : undefined}
              onInput={onInput}
              onKeyDown={onKeyDown}
              onCompositionStart={() => {
                st.composing = true
              }}
              onCompositionEnd={(e) => {
                st.composing = false
                st.typed = e.currentTarget.value
                runQuery()
              }}
            />
          </div>
          {results.length > 0 && (
            <div
              className="cmdbar__results"
              role="listbox"
              id={warm ? undefined : 'cmdbar-list'}
              data-testid={warm ? undefined : 'command-results'}
            >
              {results.map((r, i) => (
                <ResultRow
                  key={r.id}
                  r={r}
                  index={i}
                  selected={i === selected}
                  onHover={onRowHover}
                  onChoose={onRowChoose}
                  onRemove={onRowRemove}
                />
              ))}
            </div>
          )}
        </m.div>
      </div>
    </>
  )
}
