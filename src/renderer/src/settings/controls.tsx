import { Check, ChevronDown, Ellipsis } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'

/**
 * Building blocks for Settings pages (see ./registry). Rows carry `data-setting` (their id) and
 * their text: the search box (ST-02) filters rows by it, and `settings.open({ item })` scrolls to one.
 */

let commits = 0

/** Counts commits of Settings components: the background-cost test (ST-01) reads it. */
export function useCommitCounter(): void {
  useEffect(() => {
    commits++
  })
}
// Read-only diagnostics for tests (Orbit UI pages only; web pages never load this).
;(globalThis as unknown as { __orbitSettings: unknown }).__orbitSettings = { commits: () => commits }

export function SettingGroup({
  title,
  description,
  children,
  id,
}: {
  title?: string
  description?: ReactNode
  children: ReactNode
  id?: string
}) {
  const headingId = useId()
  return (
    <section className="st-group" aria-labelledby={title ? headingId : undefined} data-setting-group={id}>
      {title && (
        <h2 className="st-group__title" id={headingId}>
          {title}
        </h2>
      )}
      {description && <p className="st-group__desc">{description}</p>}
      <div className="st-group__body">{children}</div>
    </section>
  )
}

/**
 * One setting: label and description on the left, its control on the right. `profile` names the
 * profile a per-profile setting belongs to (ST-20).
 */
export function SettingRow({
  id,
  label,
  description,
  profile,
  children,
  stacked = false,
}: {
  id: string
  label: ReactNode
  description?: ReactNode
  profile?: string
  children?: ReactNode
  /** Puts the control under the text (lists, wide editors). */
  stacked?: boolean
}) {
  useCommitCounter()
  const labelId = useId()
  return (
    <div
      className={`st-row${stacked ? ' st-row--stacked' : ''}`}
      data-setting={id}
      data-testid={`setting-${id}`}
      role="group"
      aria-labelledby={labelId}
    >
      <div className="st-row__text">
        <div className="st-row__label" id={labelId}>
          {label}
          {profile && (
            <span className="st-scope" title={`This setting belongs to the profile “${profile}”`}>
              {profile}
            </span>
          )}
        </div>
        {description && <div className="st-row__desc">{description}</div>}
      </div>
      {children !== undefined && <div className="st-row__control">{children}</div>}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  testId,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      className="st-switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
    >
      <span className="st-switch__knob" />
    </button>
  )
}

export interface Option<T extends string | number> {
  value: T
  label: string
  disabled?: boolean
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
  testId,
}: {
  value: T
  options: readonly Option<T>[]
  onChange: (next: T) => void
  label: string
  disabled?: boolean
  testId?: string
}) {
  return (
    <span className="st-select">
      <select
        value={String(value)}
        aria-label={label}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => {
          const next = options.find((o) => String(o.value) === e.target.value)
          if (next) onChange(next.value)
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </span>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  testId,
}: {
  value: T
  options: readonly (Option<T> & { icon?: ReactNode })[]
  onChange: (next: T) => void
  label: string
  testId?: string
}) {
  return (
    <div className="st-seg" role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="st-seg__item"
          data-testid={testId ? `${testId}-${o.value}` : undefined}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            const i = options.findIndex((x) => x.value === value)
            const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length]
            if (next) onChange(next.value)
          }}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export function Button({
  children,
  onClick,
  kind = 'normal',
  disabled,
  title,
  testId,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  kind?: 'normal' | 'primary' | 'danger'
  disabled?: boolean
  title?: string
  testId?: string
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      className={`st-button st-button--${kind}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
    >
      {children}
    </button>
  )
}

/** A check mark list item (checkbox look), for dialogs such as Clear browsing data. */
export function Checkbox({
  checked,
  onChange,
  label,
  description,
  testId,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  description?: string
  testId?: string
}) {
  return (
    <label className="st-check" data-testid={testId}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="st-check__box" aria-hidden="true">
        {checked && <Check size={12} strokeWidth={3} />}
      </span>
      <span className="st-check__text">
        <span>{label}</span>
        {description && <span className="st-check__desc">{description}</span>}
      </span>
    </label>
  )
}

/** A labelled text box with its error under it. */
export function TextField({
  value,
  onChange,
  label,
  placeholder,
  error,
  testId,
  autoFocus,
  wide,
}: {
  value: string
  onChange: (next: string) => void
  label: string
  placeholder?: string
  error?: string
  testId?: string
  autoFocus?: boolean
  wide?: boolean
}) {
  const errorId = useId()
  const input = useRef<HTMLInputElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: on mount only
  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [])
  return (
    <label className={`st-field${wide ? ' st-field--wide' : ''}`}>
      <span className="st-field__label">{label}</span>
      <input
        ref={input}
        className="st-input"
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <span className="st-field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </label>
  )
}

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  testId?: string
}

/** A row's "…" menu. */
export function RowMenu({ label, items, testId }: { label: string; items: MenuItem[]; testId?: string }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const close = () => {
    setOpen(false)
    button.current?.focus()
  }
  return (
    <div className="st-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="st-icon-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => setOpen((v) => !v)}
      >
        <Ellipsis size={16} />
      </button>
      {open && (
        <div
          className="st-menu__list"
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              close()
              return
            }
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
            e.preventDefault()
            const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
            const i = all.indexOf(document.activeElement as HTMLButtonElement)
            all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`st-menu__item${item.danger ? ' st-menu__item--danger' : ''}`}
              disabled={item.disabled}
              data-testid={item.testId}
              onClick={() => {
                close()
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
