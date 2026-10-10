import { ArrowLeft } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DefaultBrowserStatus } from '../../../shared/commands/settings'
import { ONBOARDING_STEPS, type OnboardingInfo, type OnboardingStep } from '../../../shared/onboarding'
import { NEUTRAL_THEME } from '../../../shared/theme'
import { invoke, isMac } from '../api'
import { useOrbit } from '../store'
import { cachedPalette, paletteVars, prefersReducedMotion, useDark } from '../theme'
import { BrowserStep, DoneStep, FavoritesStep, ImportStep, ThemeStep, WelcomeStep } from './steps'
import './onboarding.css'

/** Each step's name in the progress dots, for screen readers. */
const STEP_NAMES: Record<OnboardingStep, string> = {
  welcome: 'Welcome',
  import: 'Import',
  theme: 'Colours',
  favorites: 'Favorites',
  browser: 'Default browser',
  done: 'Done',
}

/**
 * First-run onboarding (OB-01…OB-09, OB-14): a window of its own before the first browser window.
 * Every step can be skipped and none asks for an account (OB-02). The window takes the first Space's
 * colours, live, as the theme step changes them.
 */
export function OnboardingApp() {
  const [info, setInfo] = useState<OnboardingInfo>()
  useEffect(() => {
    void invoke('onboarding.info', {}).then(setInfo)
  }, [])
  const spaceId = useOrbit((s) => info?.spaceId ?? s.spaceOrder[0])
  const theme = useOrbit((s) => (spaceId ? s.spaces[spaceId]?.theme : undefined)) ?? NEUTRAL_THEME
  const dark = useDark()
  const palette = cachedPalette(theme, dark)
  const style = useMemo(() => paletteVars(palette), [palette])
  useThemeFade(dark)
  return (
    <div className="ob" data-testid="onboarding" data-dark={dark ? '' : undefined} style={style}>
      <div className="ob__grain" aria-hidden="true" />
      {isMac && <div className="ob__drag" />}
      {info && <Flow info={info} />}
    </div>
  )
}

/** Light/dark changes cross-fade (AP-01). */
function useThemeFade(dark: boolean): void {
  const last = useRef(dark)
  useLayoutEffect(() => {
    if (last.current === dark) return
    last.current = dark
    if (prefersReducedMotion()) return
    const root = document.documentElement
    root.dataset.themeFade = ''
    const t = setTimeout(() => delete root.dataset.themeFade, 260)
    return () => clearTimeout(t)
  }, [dark])
}

const FAVORITES_AT = ONBOARDING_STEPS.indexOf('favorites')

function Flow({ info }: { info: OnboardingInfo }) {
  const [index, setIndex] = useState(() => Math.max(0, ONBOARDING_STEPS.indexOf(info.step)))
  const [forward, setForward] = useState(true)
  const [favorites, setFavorites] = useState<string[]>([])
  const [browser, setBrowser] = useState<DefaultBrowserStatus>()
  const [declined, setDeclined] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const step = ONBOARDING_STEPS[index] as OnboardingStep
  const last = ONBOARDING_STEPS.length - 1
  const stepRef = useRef<HTMLElement>(null)

  // Asked again when the window comes back to the front: the OS's own prompt or settings may have
  // made Orbit the default meanwhile (OB-07).
  useEffect(() => {
    const check = () => void invoke('settings.defaultBrowser', {}).then(setBrowser)
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])

  const go = useCallback(
    (to: number) => {
      const next = Math.min(Math.max(to, 0), last)
      if (next === index) return
      setForward(next > index)
      setIndex(next)
      void invoke('onboarding.setStep', { step: ONBOARDING_STEPS[next] as OnboardingStep })
    },
    [index, last],
  )
  const end = useCallback(
    (chosen: string[]) => {
      if (finishing) return
      setFinishing(true)
      invoke('onboarding.finish', { favorites: chosen }).catch(() => setFinishing(false))
    },
    [finishing],
  )
  const finish = useCallback(() => end(favorites), [end, favorites])
  // Skip setup (OB-14): what earlier steps set stays (colours apply as they're picked, Favorites once
  // continued past) and the rest keep their defaults. From the start, that's the default first window.
  const skip = useCallback(() => end(index > FAVORITES_AT ? favorites : []), [end, favorites, index])
  const next = useCallback(() => (index === last ? finish() : go(index + 1)), [finish, go, index, last])
  const back = useCallback(() => go(index - 1), [go, index])

  // Enter continues and Escape goes back (OB-01), unless a control wants the key itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const target = e.target instanceof Element ? e.target : null
      if (e.key === 'Enter' && !target?.closest('button, a, input, select, textarea, [role="radio"]')) {
        e.preventDefault()
        next()
      } else if (e.key === 'Escape' && !(target instanceof HTMLSelectElement)) {
        e.preventDefault()
        back()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, back])

  // Each step starts with its title focused, so screen readers read it and Enter continues.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per step
  useLayoutEffect(() => {
    stepRef.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true })
  }, [step])

  const setDefault = async () => setBrowser(await invoke('settings.setDefaultBrowser', {}))

  return (
    <>
      <header className="ob__top">
        <ol className="ob-progress" aria-label="Setup steps">
          {ONBOARDING_STEPS.map((s, i) => (
            <li
              key={s}
              className={`ob-progress__dot${i === index ? ' is-current' : i < index ? ' is-done' : ''}`}
              aria-current={i === index ? 'step' : undefined}
            >
              <span className="ob-sr">
                Step {i + 1} of {ONBOARDING_STEPS.length}: {STEP_NAMES[s]}
              </span>
            </li>
          ))}
        </ol>
        {step !== 'done' && (
          <button
            type="button"
            className="ob-skip"
            data-testid="onboarding-skip"
            disabled={finishing}
            onClick={skip}
            title="Go straight to the browser; everything here is in Settings later"
          >
            Skip setup
          </button>
        )}
      </header>
      <main className="ob__main">
        <section
          key={step}
          ref={stepRef}
          className={`ob-step ${forward ? 'is-forward' : 'is-back'}`}
          aria-labelledby={`ob-title-${step}`}
          data-testid={`onboarding-step-${step}`}
        >
          {step === 'welcome' && <WelcomeStep onNext={next} />}
          {step === 'import' && <ImportStep importer={info.importer} onNext={next} />}
          {step === 'theme' && info.spaceId && <ThemeStep spaceId={info.spaceId} onNext={next} />}
          {step === 'favorites' && <FavoritesStep chosen={favorites} onChange={setFavorites} onNext={next} />}
          {step === 'browser' && (
            <BrowserStep
              status={browser}
              onMakeDefault={setDefault}
              onNotNow={() => {
                setDeclined(true)
                next()
              }}
              onNext={next}
            />
          )}
          {step === 'done' && (
            <DoneStep
              spaceId={info.spaceId}
              favorites={favorites}
              browser={browser}
              declined={declined}
              importer={info.importer}
              returning={info.returning}
              finishing={finishing}
              onStart={finish}
            />
          )}
        </section>
      </main>
      <footer className="ob__bottom">
        {index > 0 && (
          <button type="button" className="ob-back" data-testid="onboarding-back" onClick={back}>
            <ArrowLeft size={14} aria-hidden="true" />
            Back
          </button>
        )}
      </footer>
    </>
  )
}
