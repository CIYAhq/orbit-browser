import { ChevronDown, Pencil, RotateCcw, Shuffle } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { Tweak } from '../../../shared/state'
import { shuffleStyle, TWEAK_LIMITS } from '../../../shared/tweaks'
import { invoke } from '../api'
import { updateTweak } from './edit'

type MenuState = 'closed' | 'open' | 'confirm'

/**
 * The panel's title (BO-12): the Tweak's name with a ▾ menu of Rename…, Shuffle (BO-13) and Reset all
 * edits…, which asks first. Rename edits the name in place: Enter keeps it, Esc leaves it as it was.
 */
export function TitleMenu({ tweak, host, intro }: { tweak: Tweak; host: string | null; intro: boolean }) {
  const [menu, setMenu] = useState<MenuState>('closed')
  const [renaming, setRenaming] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)

  // A press anywhere else closes the menu.
  useEffect(() => {
    if (menu === 'closed') return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (list.current?.contains(target) || button.current?.contains(target)) return
      setMenu('closed')
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [menu])

  // The menu takes the keyboard as it opens, and as it asks.
  useEffect(() => {
    if (menu !== 'closed') list.current?.querySelector<HTMLElement>('[role="menuitem"], button')?.focus()
  }, [menu])

  const close = (refocus = true) => {
    setMenu('closed')
    if (refocus) button.current?.focus()
  }
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // The menu goes, not the panel.
      e.preventDefault()
      close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]
    next?.focus()
  }

  return (
    <div className="tweak-panel__title">
      {renaming ? (
        <Rename
          tweak={tweak}
          done={() => {
            setRenaming(false)
            requestAnimationFrame(() => button.current?.focus())
          }}
        />
      ) : (
        <button
          ref={button}
          type="button"
          className="tweak-panel__name"
          data-testid="tweak-name"
          aria-haspopup="menu"
          aria-expanded={menu !== 'closed'}
          disabled={intro}
          title={intro ? undefined : 'Rename, shuffle or reset'}
          onClick={() => setMenu(menu === 'closed' ? 'open' : 'closed')}
        >
          <span className="tweak-panel__name-text">{tweak.name}</span>
          {!intro && <ChevronDown size={13} aria-hidden />}
        </button>
      )}
      {tweak.name !== host && host && <span className="tweak-panel__host">{host}</span>}
      {menu !== 'closed' && (
        <div ref={list} className="tweak-menu" data-testid="tweak-menu" onKeyDown={onMenuKey}>
          {menu === 'open' ? (
            <div role="menu" aria-label={tweak.name}>
              <button
                type="button"
                role="menuitem"
                className="tweak-menu__item"
                data-testid="tweak-menu-rename"
                onClick={() => {
                  close(false)
                  setRenaming(true)
                }}
              >
                <Pencil size={13} aria-hidden />
                Rename…
              </button>
              <button
                type="button"
                role="menuitem"
                className="tweak-menu__item"
                data-testid="tweak-menu-shuffle"
                title="A random look: colours, font, size and case"
                onClick={() => updateTweak(tweak.id, { style: shuffleStyle() })}
              >
                <Shuffle size={13} aria-hidden />
                Shuffle
              </button>
              <div className="tweak-menu__line" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="tweak-menu__item is-danger"
                data-testid="tweak-menu-reset"
                onClick={() => setMenu('confirm')}
              >
                <RotateCcw size={13} aria-hidden />
                Reset all edits…
              </button>
            </div>
          ) : (
            <div className="tweak-menu__confirm" role="alertdialog" aria-label="Reset all edits?">
              <strong>Reset all edits?</strong>
              <p>Colours, font, size, case, hidden elements and code go back to the site’s own.</p>
              <div className="tweak-menu__buttons">
                <button type="button" className="tweak-button" data-testid="tweak-reset-cancel" onClick={() => close()}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="tweak-button is-danger"
                  data-testid="tweak-reset-confirm"
                  onClick={() => {
                    void invoke('tweaks.reset', { id: tweak.id })
                    close()
                  }}
                >
                  Reset
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** The name, editable in place: Enter (or leaving the field) keeps it, Esc leaves it as it was. */
function Rename({ tweak, done }: { tweak: Tweak; done: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const finish = (keep: boolean) => {
    if (finished.current) return
    finished.current = true
    const name = input.current?.value.trim() ?? ''
    if (keep && name && name !== tweak.name) updateTweak(tweak.id, { name })
    done()
  }
  return (
    <input
      ref={input}
      className="tweak-panel__rename"
      data-testid="tweak-name-input"
      aria-label="Name"
      defaultValue={tweak.name}
      maxLength={TWEAK_LIMITS.name}
      spellCheck={false}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          // The rename goes, not the panel.
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}
