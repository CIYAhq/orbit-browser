import { Lock, RotateCw } from 'lucide-react'
import type { BrowserKind, ImportDataType, ImportSource, Inspection } from '../../../shared/commands/import'

/** A browser's letter tile colour (no logos: Orbit doesn't ship other browsers' marks). */
const TILE: Record<BrowserKind, string> = {
  chrome: '#1a73e8',
  chromium: '#5f6caf',
  brave: '#fb542b',
  edge: '#0c8484',
  vivaldi: '#ef3939',
  opera: '#ff1b2d',
  'opera-gx': '#d81b60',
  firefox: '#ff7139',
  safari: '#1c8ef9',
}

export const TYPE_LABELS: Record<ImportDataType | 'links', string> = {
  bookmarks: 'Bookmarks',
  history: 'History',
  extensions: 'Extensions',
  cookies: 'Cookies',
  links: 'Links',
}

/** Browsers found on this computer (IM-02), as tiles to choose one from. */
export function SourcePicker({
  sources,
  chosen,
  onPick,
  onOpen,
}: {
  sources: ImportSource[] | undefined
  chosen: string | undefined
  onPick: (id: string) => void
  onOpen: () => void
}) {
  if (!sources) {
    return (
      <p className="im-note" data-testid="import-sources-loading">
        Looking for browsers on this computer…
      </p>
    )
  }
  if (sources.length === 0) {
    return (
      <p className="im-note" data-testid="import-no-sources">
        No other browsers were found on this computer.
      </p>
    )
  }
  return (
    <div className="im-sources" role="radiogroup" aria-label="Browsers on this computer">
      {sources.map((s) => {
        const checked = s.id === chosen
        const profiles = s.profiles.length
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={checked}
            className="im-source"
            data-testid={`import-source-${s.id}`}
            data-blocked={s.blocked ? '' : undefined}
            onClick={() => onPick(s.id)}
            onDoubleClick={() => {
              if (s.blocked) return
              onPick(s.id)
              onOpen()
            }}
          >
            <span className="im-source__tile" style={{ background: TILE[s.browser] }} aria-hidden="true">
              {s.name.charAt(0)}
            </span>
            <span className="im-source__text">
              <strong>{s.name}</strong>
              <span>
                {s.blocked ? (
                  <>
                    <Lock size={11} aria-hidden="true" /> {s.blocked}
                  </>
                ) : profiles === 1 ? (
                  (s.profiles[0]?.name ?? '1 profile')
                ) : (
                  `${profiles} profiles`
                )}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/**
 * What to bring over (IM-03), with how much the chosen profiles hold. Extensions are listed but
 * can't be added yet (IM-09); cookies are off unless chosen (IM-10). Files the browser holds open
 * ask for it to be quit (IM-14).
 */
export function TypesPicker({
  inspection,
  types,
  onChange,
  onRetry,
}: {
  inspection: Inspection | 'loading' | undefined
  types: ImportDataType[]
  onChange: (types: ImportDataType[]) => void
  onRetry: () => void
}) {
  if (!inspection || inspection === 'loading') {
    return (
      <p className="im-note" data-testid="import-inspecting">
        Reading what’s there…
      </p>
    )
  }
  let bookmarks = 0
  let history = 0
  let cookies = 0
  let cookiesUnavailable: string | undefined
  let hasBookmarks = false
  let hasHistory = false
  let hasCookies = false
  const extensions = new Map<string, string>()
  const locked = new Set<ImportDataType>()
  for (const p of inspection.profiles) {
    if (p.bookmarks) {
      hasBookmarks = true
      bookmarks += p.bookmarks.count
    }
    if (p.history) {
      hasHistory = true
      history += p.history.count
    }
    if (p.cookies) {
      hasCookies = true
      cookies += p.cookies.count
      cookiesUnavailable ??= p.cookies.unavailable
    }
    for (const x of p.extensions?.items ?? []) extensions.set(x.id, x.name)
    for (const t of p.locked) locked.add(t)
  }
  const toggle = (t: ImportDataType, on: boolean) =>
    onChange(on ? [...new Set([...types, t])] : types.filter((x) => x !== t))
  const row = (t: ImportDataType, detail: string, disabled = false, note?: string) => (
    <label className="im-type" key={t} data-testid={`import-type-${t}`} data-disabled={disabled ? '' : undefined}>
      <input
        type="checkbox"
        checked={!disabled && types.includes(t)}
        disabled={disabled}
        onChange={(e) => toggle(t, e.target.checked)}
      />
      <span className="im-type__text">
        <strong>{TYPE_LABELS[t]}</strong>
        <span>{detail}</span>
        {note && <span className="im-type__note">{note}</span>}
      </span>
    </label>
  )
  return (
    <>
      <p className="im-lead">From {inspection.name}. Passwords and cards are never imported.</p>
      {locked.size > 0 && (
        <div className="im-banner" role="alert" data-testid="import-locked">
          <span>
            {inspection.name} is using some of its files. Quit {inspection.name} and try again, or import the rest.
          </span>
          <button type="button" className="im-link" onClick={onRetry} data-testid="import-retry">
            <RotateCw size={12} aria-hidden="true" /> Try again
          </button>
        </div>
      )}
      <div className="im-types">
        {hasBookmarks &&
          row('bookmarks', `${plural(bookmarks, 'bookmark', 'bookmarks')}, as pinned tabs`, locked.has('bookmarks'))}
        {hasHistory && row('history', plural(history, 'page visited', 'pages visited'), locked.has('history'))}
        {extensions.size > 0 &&
          row(
            'extensions',
            [...extensions.values()].slice(0, 4).join(', ') + (extensions.size > 4 ? `, +${extensions.size - 4}` : ''),
            true,
            'Not importable yet: install them again from their store.',
          )}
        {hasCookies &&
          row(
            'cookies',
            cookiesUnavailable ?? `${plural(cookies, 'cookie', 'cookies')}: stay signed in to sites`,
            !!cookiesUnavailable || locked.has('cookies'),
            'Cookies can sign anyone using this profile in to your accounts. Off unless you choose it.',
          )}
        {!hasBookmarks && !hasHistory && extensions.size === 0 && !hasCookies && (
          <p className="im-note" data-testid="import-nothing">
            Nothing to import from this profile.
          </p>
        )}
      </div>
    </>
  )
}
