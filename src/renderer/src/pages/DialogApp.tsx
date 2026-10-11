import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { PageDialogContent } from '../../../shared/pages'
import { invoke } from '../api'
import { useWindow } from '../store'
import { paletteVars, usePalette } from '../theme'
import './dialog.css'

/**
 * A page's dialog (NV-24), in a transparent view main keeps over that page only: the page's alert,
 * confirm or prompt, "Leave site?", or HTTP sign-in. It takes the keyboard while it shows (KS-19):
 * Enter answers with the accepting button, Esc cancels, and Tab stays inside the card. Main gives
 * the keyboard back to the page when it goes (KS-16).
 */
export function DialogApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const [content, setContent] = useState<PageDialogContent | null>(null)
  /** The dialog answered last: its card is gone until main sends the next one. */
  const answered = useRef<number | null>(null)

  useEffect(() => {
    let heard = false
    const take = (next: PageDialogContent | null) => {
      if (next && next.id === answered.current) return
      setContent(next)
    }
    const off = window.orbit.on('dialog:content', (payload) => {
      heard = true
      take(payload as PageDialogContent)
    })
    // What main sent before this page listened is lost: ask for the dialog now.
    void invoke('pages.dialogContent', {}).then((first) => {
      if (!heard) take(first)
    })
    return off
  }, [])

  const answer = useCallback((dialog: PageDialogContent, ok: boolean, fields: Fields = {}) => {
    if (answered.current === dialog.id) return
    answered.current = dialog.id
    // Gone at once: the view may show another page's dialog next, and must not show this one first.
    setContent(null)
    void invoke('pages.dialogAnswer', { id: dialog.id, ok, ...fields })
  }, [])

  return (
    <div className="page-dialog-view" style={paletteVars(palette) as CSSProperties} data-testid="page-dialog-view">
      {content && <DialogCard key={content.id} content={content} answer={answer} />}
    </div>
  )
}

interface Fields {
  value?: string
  user?: string
  password?: string
}

function DialogCard({
  content,
  answer,
}: {
  content: PageDialogContent
  answer: (dialog: PageDialogContent, ok: boolean, fields?: Fields) => void
}) {
  const card = useRef<HTMLFormElement>(null)
  const firstField = useRef<HTMLInputElement>(null)
  const okButton = useRef<HTMLButtonElement>(null)
  const [value, setValue] = useState(content.value ?? '')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const titleId = `page-dialog-title-${content.id}`
  const messageId = `page-dialog-message-${content.id}`

  // The prompt's text is selected, sign-in starts at the username, the rest at the accepting button.
  useLayoutEffect(() => {
    const field = firstField.current
    if (field) {
      field.focus()
      if (content.kind === 'prompt') field.select()
    } else okButton.current?.focus()
  }, [content.kind])

  // The view can get the keyboard after the card shows (main focuses it when the page is current).
  useEffect(() => {
    const onFocus = () => {
      if (card.current?.contains(document.activeElement)) return
      const field = firstField.current
      if (field) field.focus()
      else okButton.current?.focus()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const accept = () => {
    if (content.kind === 'prompt') answer(content, true, { value })
    else if (content.kind === 'auth') answer(content, true, { user, password })
    else answer(content, true)
  }
  const cancel = () => answer(content, false)

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    accept()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      // An alert has one button: Esc closes it as OK does.
      if (content.noCancel) accept()
      else cancel()
      return
    }
    if (e.key !== 'Tab' || !card.current) return
    // Tab goes round the card's own controls.
    const controls = [...card.current.querySelectorAll<HTMLElement>('input, button')].filter(
      (el) => !(el as HTMLButtonElement).disabled,
    )
    if (controls.length === 0) return
    const at = controls.indexOf(document.activeElement as HTMLElement)
    const next = e.shiftKey
      ? at <= 0
        ? controls.length - 1
        : at - 1
      : at < 0 || at >= controls.length - 1
        ? 0
        : at + 1
    e.preventDefault()
    controls[next]?.focus()
  }

  const alert =
    content.kind === 'alert' || content.kind === 'confirm' || content.kind === 'leave' || content.kind === 'reload'
  return (
    <form
      ref={card}
      className="page-dialog"
      role={alert ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={content.message ? messageId : undefined}
      data-testid="page-dialog"
      data-dialog-id={content.id}
      data-kind={content.kind}
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      autoComplete="off"
    >
      <h2 id={titleId} className="page-dialog__title" data-testid="page-dialog-title">
        {content.title}
      </h2>
      {content.message && (
        <p id={messageId} className="page-dialog__message" data-testid="page-dialog-message">
          {content.message}
        </p>
      )}
      {content.kind === 'prompt' && (
        <input
          ref={firstField}
          className="page-dialog__field"
          data-testid="page-dialog-input"
          aria-label={content.message || 'Answer'}
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      {content.kind === 'auth' && (
        <div className="page-dialog__fields">
          <label className="page-dialog__label">
            <span>Username</span>
            <input
              ref={firstField}
              className="page-dialog__field"
              data-testid="page-dialog-user"
              autoComplete="username"
              spellCheck={false}
              value={user}
              onChange={(e) => setUser(e.target.value)}
            />
          </label>
          <label className="page-dialog__label">
            <span>Password</span>
            <input
              type="password"
              className="page-dialog__field"
              data-testid="page-dialog-password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </div>
      )}
      {content.note && (
        <p className="page-dialog__note" data-testid="page-dialog-note">
          {content.note}
        </p>
      )}
      <div className="page-dialog__actions">
        {!content.noCancel && (
          <button type="button" className="page-dialog__button" data-testid="page-dialog-cancel" onClick={cancel}>
            Cancel
          </button>
        )}
        <button ref={okButton} type="submit" className="page-dialog__button is-primary" data-testid="page-dialog-ok">
          {content.okLabel}
        </button>
      </div>
    </form>
  )
}
