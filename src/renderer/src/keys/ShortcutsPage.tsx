import { Check, Lock, Plus, Search, X } from 'lucide-react'
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ACTIONS, ACTIONS_BY_ID, formatAccelerator, shortcutsFor } from '../../../shared/actions'
import type { BindingConflict, BindResult, RecordedKey, ShortcutPriority } from '../../../shared/commands/keys'
import { acceleratorFromInput, MAX_BINDINGS, modifiersOf } from '../../../shared/keymap'
import { invoke } from '../api'
import { Button, Dialog, Select, SettingGroup, SettingRow, Switch } from '../settings/controls'
import { useMainValue } from '../settings/hooks'
import { useOrbit } from '../store'
import { setRecordingKeys, useKeymap } from './live'
import {
  clashesOf,
  entryMatches,
  formatModifiers,
  type ShortcutEntry,
  searchWords,
  shortcutGroups,
} from './shortcut-list'
import './shortcuts.css'

const platform = window.orbit.platform
const mac = platform === 'darwin'
const keys = (accel: string) => formatAccelerator(accel, platform)

/** A binding being recorded: a new one for `actionId`, or one in place of `replace`. */
interface Recording {
  actionId: string
  replace?: string
  /** Modifiers held now ("Cmd+Shift"), shown while the user builds a combination. */
  held: string
  /** Tells one recording from the next, for answers that come back late. */
  session: number
}

/** The keys asked for belong to another action: Settings asks what to do (ST-08). */
interface Conflict {
  actionId: string
  accel: string
  replace?: string
  other: BindingConflict
}

function bindKeys(
  actionId: string,
  accel: string,
  replace?: string,
  onConflict?: 'clear' | 'swap',
): Promise<BindResult> {
  return invoke('keys.bind', {
    actionId,
    accel,
    ...(replace ? { replace } : {}),
    ...(onConflict ? { onConflict } : {}),
  })
}

/**
 * Recording a binding: main sends each key press in this window as `keys.recorded` and runs
 * nothing while it records (src/main/keys/router.ts). Esc cancels, ⌫ / Delete removes the binding
 * being changed; a press that makes a binding gives it to the action, or asks about a conflict.
 */
function useRecorder() {
  const [recording, setRecording] = useState<Recording>()
  const [problem, setProblem] = useState<{ actionId: string; text: string }>()
  const [conflict, setConflict] = useState<Conflict>()
  const current = useRef<Recording | undefined>(undefined)
  const busy = useRef(false)
  const sessions = useRef(0)

  const update = useCallback((next: Recording | undefined) => {
    current.current = next
    setRecording(next)
  }, [])

  const stop = useCallback(() => {
    if (!current.current) return
    update(undefined)
    setRecordingKeys(false)
    void invoke('keys.record', { on: false })
  }, [update])

  const start = useCallback(
    (actionId: string, replace?: string) => {
      const was = current.current
      setProblem(undefined)
      setConflict(undefined)
      update({ actionId, ...(replace ? { replace } : {}), held: '', session: ++sessions.current })
      setRecordingKeys(true)
      if (!was) void invoke('keys.record', { on: true })
    },
    [update],
  )

  const pressed = useCallback(
    (key: RecordedKey) => {
      const rec = current.current
      if (!rec || busy.current) return
      if (!key.accel) {
        if (key.modifiers !== rec.held) update({ ...rec, held: key.modifiers })
        return
      }
      const accel = key.accel
      if (accel === 'Escape') return stop()
      if (accel === 'Backspace' || accel === 'Delete') {
        if (rec.replace) void invoke('keys.unbind', { actionId: rec.actionId, accel: rec.replace })
        return stop()
      }
      busy.current = true
      void bindKeys(rec.actionId, accel, rec.replace)
        .then((result) => {
          if (current.current?.session !== rec.session) return
          if (result.ok) {
            setProblem(undefined)
            return stop()
          }
          if ('problem' in result) {
            // Not a binding Orbit can use: say why and keep listening.
            setProblem({ actionId: rec.actionId, text: result.problem })
            update({ ...rec, held: '' })
            return
          }
          stop()
          setConflict({
            actionId: rec.actionId,
            accel,
            ...(rec.replace ? { replace: rec.replace } : {}),
            other: result.conflict,
          })
        })
        .finally(() => {
          busy.current = false
        })
    },
    [stop, update],
  )

  const active = recording !== undefined
  useEffect(() => {
    if (!active) return
    const offMain = window.orbit.on('keys.recorded', (payload) => pressed(payload as RecordedKey))
    // Key presses main didn't take (synthetic input) are recorded the same way.
    const fromPage = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const input = { key: e.key, code: e.code, meta: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey }
      const accel = e.type === 'keydown' ? acceleratorFromInput(input) : undefined
      pressed({ modifiers: modifiersOf(input), ...(accel ? { accel } : {}) })
    }
    // A click anywhere but on the binding being recorded stops recording.
    const onPointer = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-recording]')) stop()
    }
    window.addEventListener('keydown', fromPage, true)
    window.addEventListener('keyup', fromPage, true)
    document.addEventListener('mousedown', onPointer, true)
    window.addEventListener('blur', stop)
    return () => {
      offMain()
      window.removeEventListener('keydown', fromPage, true)
      window.removeEventListener('keyup', fromPage, true)
      document.removeEventListener('mousedown', onPointer, true)
      window.removeEventListener('blur', stop)
    }
  }, [active, pressed, stop])
  // Leaving the page (another section, a search, closing Settings) stops recording.
  useEffect(() => stop, [stop])

  const resolve = useCallback((c: Conflict, how: 'clear' | 'swap') => {
    setConflict(undefined)
    void bindKeys(c.actionId, c.accel, c.replace, how).then((result) => {
      if (!result.ok && 'problem' in result) setProblem({ actionId: c.actionId, text: result.problem })
    })
  }, [])

  return { recording, problem, conflict, start, stop, resolve, dismiss: () => setConflict(undefined) }
}

/** The first binding of an action as this platform shows it, or ''. */
function firstKeys(actionId: string): string {
  const action = ACTIONS_BY_ID[actionId]
  const accel = action ? shortcutsFor(action, platform)[0] : undefined
  return accel ? keys(accel) : ''
}

/**
 * Settings → Shortcuts (ST-08): every action with its keys, a search, recording new keys,
 * conflicts, Reset to Default and the per-action priority on right-click (KS-02), and the Go to
 * Tab options (TB-04, FV-10).
 */
export function ShortcutsPage() {
  const version = useKeymap()
  const priorities = useOrbit((s) => s.settings.shortcutPriority)
  const lastTabOnCmd9 = useOrbit((s) => s.settings.lastTabOnCmd9)
  const countFavorites = useOrbit((s) => s.settings.countFavoritesInShortcuts)
  const [clashes] = useMainValue(() => invoke('keys.systemClashes', {}))
  // Only actions Orbit has: the table also names some that no feature runs yet.
  const [available] = useMainValue(() => invoke('keys.available', {}))
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ actionId: string; x: number; y: number }>()
  const [confirmReset, setConfirmReset] = useState(false)
  const recorder = useRecorder()
  const { recording, problem, conflict, start, stop } = recorder

  // biome-ignore lint/correctness/useExhaustiveDependencies: the keymap's version stands for the bindings
  const groups = useMemo(() => {
    if (!available) return []
    const has = new Set(available)
    return shortcutGroups(
      platform,
      { ...(priorities ? { priorities } : {}), lastTabOnCmd9 },
      ACTIONS.filter((a) => has.has(a.id)),
    )
  }, [version, priorities, lastTabOnCmd9, available])
  const words = searchWords(query)
  const shown = groups
    .map((g) => ({ ...g, entries: g.entries.filter((e) => entryMatches(e, words, platform)) }))
    .filter((g) => g.entries.length > 0)
  const entries = useMemo(() => new Map(groups.flatMap((g) => g.entries.map((e) => [e.action.id, e]))), [groups])
  const allDefault = groups.every((g) => g.entries.every((e) => e.isDefault))
  const clashing = groups.flatMap((g) => g.entries.flatMap((e) => clashesOf(e, clashes)))

  const goto = firstKeys('tab.goto.1') && firstKeys('tab.goto.8')
  const range = goto ? `${firstKeys('tab.goto.1')}–${firstKeys('tab.goto.8')}` : 'Go to Tab 1–8'
  const nine = firstKeys('tab.goto.9') || 'Go to Tab 9'
  const favoritesText = `${range} count your Favorites first, then pinned and Today tabs.`
  const lastText = 'The last item, or the ninth.'
  const has = (text: string) => words.every((w) => text.toLowerCase().includes(w))
  const showFavorites = has(`Go to Tab Include Favorites in ordering ${favoritesText}`)
  const showLast = has(`Go to Tab ${nine} goes to ${lastText}`)
  const resetText = 'Reset all shortcuts'
  const showReset = has(`${resetText} default`)

  const onContextMenu = (e: ReactMouseEvent) => {
    const target = e.target as Element
    if (target.closest('.ks-menu')) return
    const row = target.closest('[data-setting]')
    const actionId = row?.querySelector<HTMLElement>('[data-shortcut-action]')?.dataset.shortcutAction
    const entry = actionId ? entries.get(actionId) : undefined
    if (!entry || entry.action.fixed) return
    e.preventDefault()
    stop()
    // From the keyboard (⇧F10, the menu key) the menu opens at the row's keys.
    let { clientX: x, clientY: y } = e
    if (x === 0 && y === 0) {
      const rect = (row?.querySelector('[data-shortcut-action]') ?? target).getBoundingClientRect()
      x = rect.left
      y = rect.bottom
    }
    setMenu({ actionId: entry.action.id, x, y })
  }

  const menuEntry = menu ? entries.get(menu.actionId) : undefined

  return (
    <div className="ks-page" onContextMenu={onContextMenu}>
      {/* .st-groups with no rows: Settings search (ST-02), which searches every page, hides them. */}
      <div className="st-group ks-search-bar">
        <label className="ks-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="Search shortcuts"
            aria-label="Search shortcuts"
            spellCheck={false}
            data-testid="shortcuts-search"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button type="button" className="ks-search__clear" aria-label="Clear search" onClick={() => setQuery('')}>
              <X size={11} />
            </button>
          )}
        </label>
      </div>
      <div className="st-group ks-head">
        <p className="ks-intro">
          Click a shortcut, then press the new keys. Right-click an action to reset it, or to choose whether websites or
          Orbit get its keys first.
        </p>
        {clashing.length > 0 && (
          <p className="ks-notice" role="note" data-testid="shortcuts-system-notice">
            {mac
              ? 'macOS keeps some of these keys for itself, so they never reach Orbit (marked below). Turn them off in System Settings → Keyboard → Keyboard Shortcuts, or give those actions other keys here.'
              : 'Your desktop keeps some of these keys for itself, so they never reach Orbit (marked below). Change them in your desktop’s keyboard settings, or give those actions other keys here.'}
          </p>
        )}
      </div>

      {(showFavorites || showLast) && (
        <SettingGroup title="Go to Tab">
          {showFavorites && (
            <SettingRow id="shortcut-count-favorites" label="Include Favorites in ordering" description={favoritesText}>
              <Switch
                label="Include Favorites in ordering"
                checked={countFavorites}
                testId="shortcut-count-favorites"
                onChange={(next) => void invoke('keys.setOptions', { countFavorites: next })}
              />
            </SettingRow>
          )}
          {showLast && (
            <SettingRow id="shortcut-last-tab" label={`${nine} goes to`} description={lastText}>
              <Select
                label={`${nine} goes to`}
                value={lastTabOnCmd9 ? 'last' : 'ninth'}
                options={[
                  { value: 'last', label: 'The last item' },
                  { value: 'ninth', label: 'The ninth item' },
                ]}
                testId="shortcut-last-tab"
                onChange={(next) => void invoke('keys.setOptions', { lastTabOnCmd9: next === 'last' })}
              />
            </SettingRow>
          )}
        </SettingGroup>
      )}

      {shown.map((group) => (
        <SettingGroup key={group.category} title={group.category}>
          {group.entries.map((entry) => {
            const id = entry.action.id
            const mine = recording?.actionId === id ? recording : undefined
            const clash = clashesOf(entry, clashes)[0]
            return (
              <ShortcutRow
                key={id}
                actionId={id}
                title={entry.title}
                bindings={entry.bindings.join(' ')}
                fixed={!!entry.action.fixed}
                websites={entry.priority === 'websites'}
                recording={mine ? (mine.replace ?? '') : undefined}
                held={mine?.held ?? ''}
                problem={problem?.actionId === id ? problem.text : undefined}
                clash={
                  clash
                    ? `${keys(clash.accel)} never reaches Orbit: your system uses it for ${clash.owner}.`
                    : undefined
                }
                start={start}
                stop={stop}
              />
            )
          })}
        </SettingGroup>
      ))}
      {available && shown.length === 0 && (
        <p className="ks-empty" data-testid="shortcuts-no-results">
          No shortcuts match “{query}”.
        </p>
      )}

      {showReset && (
        <SettingGroup>
          <SettingRow
            id="shortcuts-reset-all"
            label={resetText}
            description="Every action gets back the keys Orbit comes with, and the keys go first to whoever they went to at first."
          >
            <Button testId="shortcuts-reset-all" disabled={allDefault} onClick={() => setConfirmReset(true)}>
              Reset All…
            </Button>
          </SettingRow>
        </SettingGroup>
      )}

      {menu && menuEntry && (
        <ShortcutMenu
          entry={menuEntry}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(undefined)}
          onPriority={(priority) => void invoke('keys.setPriority', { actionId: menu.actionId, priority })}
        />
      )}

      {conflict && <ConflictDialog conflict={conflict} onClose={recorder.dismiss} onResolve={recorder.resolve} />}

      {confirmReset && (
        <Dialog
          title="Reset all shortcuts?"
          description="Every shortcut you changed goes back to the one Orbit comes with."
          testId="shortcuts-reset-all-dialog"
          onClose={() => setConfirmReset(false)}
          actions={
            <>
              <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
              <Button
                kind="danger"
                testId="shortcuts-reset-all-confirm"
                onClick={() => void invoke('keys.resetAll', {}).finally(() => setConfirmReset(false))}
              >
                Reset All
              </Button>
            </>
          }
        />
      )}
    </div>
  )
}

/** One action's row: its name, and its keys to click and record (ST-08). */
const ShortcutRow = memo(function ShortcutRow({
  actionId,
  title,
  bindings,
  fixed,
  websites,
  recording,
  held,
  problem,
  clash,
  start,
  stop,
}: {
  actionId: string
  title: string
  /** Its bindings, space-separated. */
  bindings: string
  fixed: boolean
  websites: boolean
  /** Recording: '' for a new binding, else the binding being changed. */
  recording: string | undefined
  held: string
  problem?: string
  clash?: string
  start: (actionId: string, replace?: string) => void
  stop: () => void
}) {
  const list = bindings ? bindings.split(' ') : []
  const adding = recording === ''
  const listening = held ? `${formatModifiers(held, platform)}…` : 'Type shortcut'
  const remove = mac ? '⌫' : 'Backspace'
  let description: ReactNode
  if (problem) {
    description = (
      <span className="ks-problem" role="alert" data-testid="shortcut-problem">
        {problem}
      </span>
    )
  } else if (recording !== undefined) {
    description = adding
      ? 'Press the keys to add. Esc cancels.'
      : `Press the new keys. Esc cancels; ${remove} removes this shortcut.`
  } else if (clash) {
    description = (
      <span className="ks-clash" data-testid="shortcut-clash">
        {clash}
      </span>
    )
  } else if (fixed) {
    description = 'This shortcut can’t be changed.'
  }
  const toggle = (replace?: string) => {
    if (recording === (replace ?? '')) stop()
    else start(actionId, replace)
  }
  const keysRef = useRef<HTMLDivElement>(null)
  const listeningNow = recording !== undefined
  // The row says what to do while it records: all of it in view.
  useEffect(() => {
    if (listeningNow) keysRef.current?.closest('[data-setting]')?.scrollIntoView({ block: 'nearest' })
  }, [listeningNow])
  return (
    <SettingRow
      id={`shortcut-${actionId}`}
      label={
        <>
          {title}
          {websites && (
            <span className="ks-tag" title="A page that uses these keys gets them first; press again to run the action">
              Websites first
            </span>
          )}
        </>
      }
      description={description}
    >
      <div ref={keysRef} className="ks-bindings" data-shortcut-action={actionId} data-testid="shortcut-bindings">
        {fixed
          ? list.map((accel) => (
              <span key={accel} className="ks-chip ks-chip--fixed" data-testid="shortcut-binding">
                <Lock size={10} aria-hidden="true" />
                {keys(accel)}
              </span>
            ))
          : list.map((accel, i) => {
              const on = recording === accel
              return (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: a changed binding keeps its place and its focus
                  key={i}
                  type="button"
                  className={`ks-chip${on ? ' ks-chip--recording' : ''}`}
                  data-testid="shortcut-binding"
                  data-recording={on ? '' : undefined}
                  aria-label={on ? `${title}: type the new shortcut` : `${title}: ${keys(accel)}. Change`}
                  aria-pressed={on}
                  title="Click, then press the new keys"
                  onClick={() => toggle(accel)}
                >
                  {on ? listening : keys(accel)}
                </button>
              )
            })}
        {!fixed && (adding || list.length < MAX_BINDINGS) && (
          <button
            type="button"
            className={
              adding || list.length === 0 ? `ks-chip ks-chip--empty${adding ? ' ks-chip--recording' : ''}` : 'ks-add'
            }
            data-testid={list.length === 0 ? 'shortcut-record' : 'shortcut-add'}
            data-recording={adding ? '' : undefined}
            aria-label={adding ? `${title}: type the new shortcut` : `Add a shortcut for ${title}`}
            aria-pressed={adding}
            title={list.length === 0 ? 'Click, then press the keys' : 'Add another shortcut'}
            onClick={() => toggle()}
          >
            {adding ? listening : list.length === 0 ? 'Record Shortcut' : <Plus size={13} aria-hidden="true" />}
          </button>
        )}
      </div>
    </SettingRow>
  )
})

/** Asks what to do when the keys pressed belong to another action: swap, clear it there, or cancel. */
function ConflictDialog({
  conflict,
  onClose,
  onResolve,
}: {
  conflict: Conflict
  onClose: () => void
  onResolve: (c: Conflict, how: 'clear' | 'swap') => void
}) {
  const { accel, replace, other } = conflict
  const title = ACTIONS_BY_ID[conflict.actionId]?.title ?? 'this action'
  return (
    <Dialog
      title={`${keys(accel)} is used by “${other.title}”`}
      description={
        replace
          ? `Swap gives “${other.title}” ${keys(replace)} instead. Remove takes ${keys(accel)} away from it.`
          : `Remove takes ${keys(accel)} away from “${other.title}” and gives it to “${title}”.`
      }
      testId="shortcut-conflict"
      onClose={onClose}
      actions={
        <>
          <Button testId="shortcut-conflict-cancel" onClick={onClose}>
            Cancel
          </Button>
          <Button
            kind={replace ? 'normal' : 'primary'}
            testId="shortcut-conflict-clear"
            onClick={() => onResolve(conflict, 'clear')}
          >
            {`Remove from “${other.title}”`}
          </Button>
          {replace && (
            <Button kind="primary" testId="shortcut-conflict-swap" onClick={() => onResolve(conflict, 'swap')}>
              Swap
            </Button>
          )}
        </>
      }
    />
  )
}

/** The menu a right-click on an action opens: Reset to Default, Remove Shortcuts and the priority (KS-02). */
function ShortcutMenu({
  entry,
  x,
  y,
  onClose,
  onPriority,
}: {
  entry: ShortcutEntry
  x: number
  y: number
  onClose: () => void
  onPriority: (priority: ShortcutPriority) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const id = entry.action.id
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    // Kept inside the window.
    const { width, height } = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`
    menu.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
  }, [x, y])
  useEffect(() => {
    const close = () => closeRef.current()
    // The menu closes once the list under it moves. Where each scroller holding it is as it opens:
    // the scroll event of a scroll made just before the right-click can come in after it.
    const where = (el: Element) => `${el.scrollLeft},${el.scrollTop}`
    const at = new Map<Element, string>()
    for (let el = ref.current?.parentElement; el; el = el.parentElement) at.set(el, where(el))
    const onScroll = (e: Event) => {
      const el = e.target === document ? document.scrollingElement : e.target
      if (el instanceof Element && at.has(el) && at.get(el) !== where(el)) close()
    }
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [])
  const run = (fn: () => void) => () => {
    onClose()
    fn()
  }
  const item = (
    label: string,
    testId: string,
    onSelect: () => void,
    options: { disabled?: boolean; checked?: boolean } = {},
  ) => (
    <button
      type="button"
      role={options.checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={options.checked}
      className="st-menu__item ks-menu__item"
      disabled={options.disabled}
      data-testid={testId}
      onClick={run(onSelect)}
    >
      <span className="ks-menu__check" aria-hidden="true">
        {options.checked && <Check size={12} strokeWidth={2.5} />}
      </span>
      {label}
    </button>
  )
  return (
    <div
      ref={ref}
      className="st-menu__list ks-menu"
      role="menu"
      aria-label={`${entry.title} shortcut`}
      data-testid="shortcut-menu"
      style={{ left: x, top: y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
          return
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        e.preventDefault()
        const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')]
        const i = all.indexOf(document.activeElement as HTMLButtonElement)
        all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
      }}
    >
      {item('Reset to Default', 'shortcut-menu-reset', () => void invoke('keys.reset', { actionId: id }), {
        disabled: entry.isDefault,
      })}
      {item(
        entry.bindings.length > 1 ? 'Remove Shortcuts' : 'Remove Shortcut',
        'shortcut-menu-remove',
        () => {
          void (async () => {
            for (const accel of entry.bindings) await invoke('keys.unbind', { actionId: id, accel })
          })()
        },
        { disabled: entry.bindings.length === 0 },
      )}
      <div className="ks-menu__sep" role="separator" />
      {item('Prefer Websites', 'shortcut-menu-websites', () => onPriority('websites'), {
        checked: entry.priority === 'websites',
      })}
      {item('Prefer Orbit', 'shortcut-menu-orbit', () => onPriority('orbit'), { checked: entry.priority === 'orbit' })}
    </div>
  )
}
