import { ArrowRight, Check, Monitor, Moon, Sun } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type DefaultBrowserStatus, ENGINE_ORDER } from '../../../shared/commands/settings'
import { DEFAULT_PROFILE_ID, MAX_FAVORITES } from '../../../shared/defaults'
import { STARTER_APPS } from '../../../shared/onboarding'
import type { ColorMode, SpaceTheme } from '../../../shared/state'
import { NEUTRAL_THEME } from '../../../shared/theme'
import { engineFor, SEARCH_ENGINES } from '../../../shared/url'
import { invoke } from '../api'
import { swatchBackground, ThemeEditor } from '../shell/spaces/ThemeEditor'
import '../shell/spaces/spaces.css'
import { useOrbit } from '../store'
import { cachedPalette, prefersReducedMotion, useDark } from '../theme'
import { OrbitLogo } from './OrbitLogo'

/** A step's title, focused when the step appears (Enter continues from there). */
function Title({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h1 className="ob-title" id={`ob-title-${id}`} tabIndex={-1}>
      {children}
    </h1>
  )
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="ob-actions">{children}</div>
}

function Button({
  children,
  onClick,
  primary,
  disabled,
  testId,
}: {
  children: ReactNode
  onClick: () => void
  primary?: boolean
  disabled?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      className={`ob-button${primary ? ' ob-button--primary' : ''}`}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
    >
      {children}
    </button>
  )
}

// ---- OB-01 ----

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="ob-welcome">
      <OrbitLogo size={112} moving={!prefersReducedMotion()} />
      <Title id="welcome">Welcome to Orbit</Title>
      <p className="ob-lead">
        A Space for each part of your life, a sidebar that tidies itself, and a command bar that gets you anywhere.
      </p>
      <p className="ob-note">There’s no account to make. What you do in Orbit stays on this computer.</p>
      <Actions>
        <Button primary onClick={onNext} testId="onboarding-next">
          Get started
          <ArrowRight size={15} aria-hidden="true" />
        </Button>
      </Actions>
    </div>
  )
}

// ---- OB-03 ----

export function ImportStep({ importer, onNext }: { importer: boolean; onNext: () => void }) {
  if (!importer) {
    // The import lane hasn't shipped its flow (`import.open`): say so plainly and move on.
    return (
      <div className="ob-narrow" data-testid="onboarding-import-placeholder">
        <Title id="import">Bring your bookmarks along</Title>
        <p className="ob-lead">
          Orbit can’t import from other browsers yet. When it can, you’ll find it in Settings, under General.
        </p>
        <Actions>
          <Button primary onClick={onNext} testId="onboarding-next">
            Continue
          </Button>
        </Actions>
      </div>
    )
  }
  return (
    <div className="ob-narrow">
      <Title id="import">Bring your bookmarks along</Title>
      <p className="ob-lead">
        Copy bookmarks, history and more from another browser on this computer. You can also do it later from Settings.
      </p>
      <Actions>
        {/* The same weight for both: doing it later is a fine choice. */}
        <Button onClick={onNext} testId="onboarding-import-later">
          Do this later
        </Button>
        <Button onClick={() => void invoke('settings.openImport', {}).then(onNext)} testId="onboarding-import">
          Import…
        </Button>
      </Actions>
    </div>
  )
}

// ---- OB-04 ----

const MODES: { mode: ColorMode; label: string; icon: ReactNode }[] = [
  { mode: 'light', label: 'Light', icon: <Sun size={14} aria-hidden="true" /> },
  { mode: 'dark', label: 'Dark', icon: <Moon size={14} aria-hidden="true" /> },
  { mode: 'system', label: 'Match system', icon: <Monitor size={14} aria-hidden="true" /> },
]

/** Light, Dark or Match system (AP-01). */
function ModeSwitch() {
  const appearance = useOrbit((s) => s.settings.appearance)
  // Through onboarding, which keeps the mode it replaces for Skip setup (D44).
  const set = (mode: ColorMode) => void invoke('onboarding.setTheme', { appearance: mode })
  return (
    <div className="ob-modes" role="radiogroup" aria-label="Appearance">
      {MODES.map((m, i) => (
        <button
          key={m.mode}
          type="button"
          role="radio"
          aria-checked={appearance === m.mode}
          tabIndex={appearance === m.mode ? 0 : -1}
          className="ob-modes__option"
          data-testid={`onboarding-appearance-${m.mode}`}
          onClick={() => set(m.mode)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            const to = MODES[(i + (e.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length]
            if (!to) return
            set(to.mode)
            e.currentTarget.parentElement
              ?.querySelector<HTMLElement>(`[data-testid="onboarding-appearance-${to.mode}"]`)
              ?.focus()
          }}
        >
          {m.icon}
          <span>{m.label}</span>
        </button>
      ))}
    </div>
  )
}

/** A small Orbit window in the chosen colours: sidebar, tabs and a page. */
function ThemePreview({ theme }: { theme: SpaceTheme }) {
  const dark = useDark()
  const p = cachedPalette(theme, dark)
  return (
    <div
      className="ob-preview"
      aria-hidden="true"
      style={{ background: `linear-gradient(180deg, ${p.frameTop}, ${p.frameMid}, ${p.frameBottom})`, color: p.text }}
    >
      <div className="ob-preview__sidebar">
        <span className="ob-preview__lights">
          <i />
          <i />
          <i />
        </span>
        <span className="ob-preview__address" style={{ background: p.hover }} />
        <span className="ob-preview__favs">
          {[0, 1, 2, 3].map((n) => (
            <i key={n} style={{ background: p.hover }} />
          ))}
        </span>
        <span className="ob-preview__tab is-active" style={{ background: p.active, boxShadow: p.activeShadow }} />
        <span className="ob-preview__tab" style={{ background: p.hover }} />
        <span className="ob-preview__tab" style={{ background: p.hover }} />
        <span className="ob-preview__spacer" />
        <span className="ob-preview__dots">
          <i style={{ background: p.accent }} />
          <i style={{ background: p.textMuted }} />
        </span>
      </div>
      <div className="ob-preview__page" style={{ background: dark ? '#1d1d21' : '#ffffff' }}>
        <span style={{ background: dark ? '#2b2b31' : '#eeeef2' }} />
        <span style={{ background: dark ? '#2b2b31' : '#eeeef2' }} />
        <span style={{ background: dark ? '#2b2b31' : '#eeeef2' }} />
      </div>
    </div>
  )
}

export function ThemeStep({ spaceId, onNext }: { spaceId: string; onNext: () => void }) {
  const stored = useOrbit((s) => s.spaces[spaceId]?.theme) ?? NEUTRAL_THEME
  const name = useOrbit((s) => s.spaces[spaceId]?.name) ?? 'your first Space'
  const [draft, setDraft] = useState<SpaceTheme>(stored)
  const pending = useRef<SpaceTheme | null>(null)
  const frame = useRef(0)
  // Leaving the step mid-drag still applies the last colour.
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current)
      if (pending.current) void invoke('onboarding.setTheme', { theme: pending.current })
    },
    [],
  )
  // Applies live at drag rate, at most once a frame, like the Space theme picker (FL-14).
  const change = (next: SpaceTheme) => {
    setDraft(next)
    pending.current = next
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const theme = pending.current
      pending.current = null
      // Through onboarding, which keeps the colours it replaces for Skip setup (D44).
      if (theme) void invoke('onboarding.setTheme', { theme })
    })
  }
  return (
    <div className="ob-theme">
      <div className="ob-theme__intro">
        <Title id="theme">Pick your colours</Title>
        <p className="ob-lead">
          These are for “{name}”, your first Space. Each Space can have its own; change them any time from the Space’s
          menu.
        </p>
        <ModeSwitch />
        <ThemePreview theme={draft} />
      </div>
      <div className="ob-theme__editor">
        <ThemeEditor theme={draft} onChange={change} />
        <Actions>
          <Button primary onClick={onNext} testId="onboarding-next">
            Continue
          </Button>
        </Actions>
      </div>
    </div>
  )
}

// ---- OB-05 ----

/** A letter tile in a colour of its own (Orbit shows no site logos here: nothing is fetched). */
function tileColor(index: number): string {
  return `hsl(${(index * 67 + 225) % 360} 58% 54%)`
}

export function FavoritesStep({
  chosen,
  onChange,
  onNext,
}: {
  chosen: string[]
  onChange: (ids: string[]) => void
  onNext: () => void
}) {
  const full = chosen.length >= MAX_FAVORITES
  const toggle = (id: string) =>
    onChange(chosen.includes(id) ? chosen.filter((c) => c !== id) : full ? chosen : [...chosen, id])
  return (
    <div className="ob-favorites">
      <Title id="favorites">Choose a few Favorites</Title>
      <p className="ob-lead">
        Sites you open every day. They sit at the top of the sidebar in every Space and open with one click. Pick up to{' '}
        {MAX_FAVORITES}, or none for now.
      </p>
      <div className="ob-apps" role="group" aria-label="Web apps">
        {STARTER_APPS.map((app, i) => {
          const on = chosen.includes(app.id)
          return (
            <button
              key={app.id}
              type="button"
              className="ob-app"
              aria-pressed={on}
              disabled={!on && full}
              data-testid={`onboarding-app-${app.id}`}
              onClick={() => toggle(app.id)}
            >
              <span className="ob-app__icon" style={{ background: tileColor(i) }} aria-hidden="true">
                {app.name.charAt(0)}
              </span>
              <span className="ob-app__name">{app.name}</span>
              <span className="ob-app__check" aria-hidden="true">
                {on && <Check size={11} strokeWidth={3} />}
              </span>
            </button>
          )
        })}
      </div>
      <p className="ob-count" aria-live="polite" data-testid="onboarding-favorites-count">
        {chosen.length === 0
          ? 'None chosen'
          : full
            ? `${chosen.length} chosen: that’s the most Favorites can hold`
            : `${chosen.length} chosen`}
      </p>
      <Actions>
        <Button primary onClick={onNext} testId="onboarding-next">
          Continue
        </Button>
      </Actions>
    </div>
  )
}

// ---- OB-07 ----

export function BrowserStep({
  status,
  onMakeDefault,
  onNotNow,
  onNext,
}: {
  status: DefaultBrowserStatus | undefined
  onMakeDefault: () => Promise<void>
  onNotNow: () => void
  onNext: () => void
}) {
  const [asked, setAsked] = useState(false)
  const windows = window.orbit.platform === 'win32'
  return (
    <div className="ob-narrow">
      <Title id="browser">Open links in Orbit?</Title>
      <p className="ob-lead">
        As your default browser, Orbit opens the links you click in other apps, such as mail, chat and documents.
      </p>
      {status?.isDefault ? (
        <>
          <p className="ob-done" data-testid="onboarding-browser-status">
            <Check size={15} aria-hidden="true" />
            Orbit is your default browser.
          </p>
          <Actions>
            <Button primary onClick={onNext} testId="onboarding-next">
              Continue
            </Button>
          </Actions>
        </>
      ) : status && !status.canSet ? (
        <>
          <p className="ob-note" data-testid="onboarding-browser-status">
            {status.note ?? 'This copy of Orbit can’t become the default browser.'}
          </p>
          <Actions>
            <Button primary onClick={onNext} testId="onboarding-next">
              Continue
            </Button>
          </Actions>
        </>
      ) : (
        <>
          {windows && !asked && (
            <p className="ob-note">Windows opens its Default apps settings: choose Orbit as the web browser there.</p>
          )}
          {asked && (
            <p className="ob-note" data-testid="onboarding-browser-status">
              Once you’ve chosen Orbit there, come back here and continue.
            </p>
          )}
          <Actions>
            {/* The same weight for both: not now is a fine answer, and Orbit won't keep asking. */}
            <Button onClick={asked ? onNext : onNotNow} testId="onboarding-browser-later">
              {asked ? 'Continue' : 'Not now'}
            </Button>
            {!asked && (
              <Button
                onClick={() => {
                  setAsked(true)
                  void onMakeDefault()
                }}
                testId="onboarding-browser-default"
              >
                Make Orbit my default
              </Button>
            )}
          </Actions>
        </>
      )}
    </div>
  )
}

// ---- OB-09, OB-08 ----

function modeLabel(mode: ColorMode): string {
  return mode === 'light' ? 'Light' : mode === 'dark' ? 'Dark' : 'Matches your system'
}

function favoritesLabel(ids: string[]): string {
  const names = ids.map((id) => STARTER_APPS.find((a) => a.id === id)?.name).filter(Boolean) as string[]
  if (names.length === 0) return 'None for now: add any site from its tab later'
  if (names.length <= 3) return names.join(', ').replace(/, ([^,]*)$/, ' and $1')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

/** The Default profile's search engine (OB-08). */
function SearchChoice({ id }: { id: string }) {
  const current = useOrbit((s) => engineFor(s, DEFAULT_PROFILE_ID).id)
  const currentName = useOrbit((s) => engineFor(s, DEFAULT_PROFILE_ID).name)
  const options = ENGINE_ORDER.map((id) => ({ value: id as string, label: SEARCH_ENGINES[id].name }))
  if (!options.some((o) => o.value === current)) options.push({ value: current, label: currentName })
  return (
    <select
      id={id}
      className="ob-select"
      value={current}
      data-testid="onboarding-search-engine"
      onChange={(e) =>
        void invoke('settings.setSearchEngine', { profileId: DEFAULT_PROFILE_ID, engine: e.target.value })
      }
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function DoneStep({
  spaceId,
  favorites,
  browser,
  declined,
  importer,
  returning,
  finishing,
  onStart,
}: {
  spaceId: string | undefined
  favorites: string[]
  browser: DefaultBrowserStatus | undefined
  declined: boolean
  importer: boolean
  returning: boolean
  finishing: boolean
  onStart: () => void
}) {
  const theme = useOrbit((s) => (spaceId ? s.spaces[spaceId]?.theme : undefined)) ?? NEUTRAL_THEME
  const appearance = useOrbit((s) => s.settings.appearance)
  const dark = useDark()
  return (
    <div className="ob-narrow">
      <Title id="done">You’re all set</Title>
      <dl className="ob-summary" data-testid="onboarding-summary">
        <div>
          <dt>Colours</dt>
          <dd>
            <span className="ob-swatch" style={{ background: swatchBackground(theme, dark) }} aria-hidden="true" />
            {modeLabel(appearance)}
          </dd>
        </div>
        <div>
          <dt>Favorites</dt>
          <dd data-testid="onboarding-summary-favorites">{favoritesLabel(favorites)}</dd>
        </div>
        <div>
          <dt>Default browser</dt>
          <dd data-testid="onboarding-summary-browser">
            {browser?.isDefault
              ? 'Orbit'
              : declined
                ? 'Not now: it’s in Settings, under General'
                : 'Unchanged: it’s in Settings, under General'}
          </dd>
        </div>
        {!importer && (
          <div>
            <dt>Import</dt>
            <dd>Not yet available</dd>
          </div>
        )}
        <div>
          <dt>
            <label htmlFor="ob-search">Search with</label>
          </dt>
          <dd>
            <SearchChoice id="ob-search" />
          </dd>
        </div>
      </dl>
      <Actions>
        <Button primary onClick={onStart} disabled={finishing} testId="onboarding-start">
          {returning ? 'Back to browsing' : 'Start browsing'}
          <ArrowRight size={15} aria-hidden="true" />
        </Button>
      </Actions>
    </div>
  )
}
