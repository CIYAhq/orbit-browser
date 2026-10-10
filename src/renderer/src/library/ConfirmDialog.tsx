import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react'

interface ConfirmDialogProps {
  title: string
  children: ReactNode
  confirmLabel: string
  /** The confirm button is styled as destructive (red). */
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
  testId?: string
}

/**
 * A small modal question over the Library (AR-07 Clear Archive, AR-11 Restore Data). Cancel has
 * the focus, so Enter right away never deletes; Esc cancels and stays in the Library; Tab keeps
 * to the two buttons. Keys inside never reach the list underneath.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const titleId = useId()
  const bodyId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef<Element | null>(null)

  useEffect(() => {
    restoreFocus.current = document.activeElement
    cancelRef.current?.focus()
    return () => {
      const el = restoreFocus.current
      if (el instanceof HTMLElement && el.isConnected) el.focus()
    }
  }, [])

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onCancel()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const next = document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current
      next?.focus()
    }
  }

  return (
    <div className="library-dialog__backdrop" role="presentation" onMouseDown={props.onCancel}>
      <div
        className="library-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid={props.testId}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="library-dialog__title">
          {props.title}
        </h2>
        <div id={bodyId} className="library-dialog__body">
          {props.children}
        </div>
        <div className="library-dialog__buttons">
          <button
            ref={cancelRef}
            type="button"
            className="library-dialog__button"
            data-testid={props.testId ? `${props.testId}-cancel` : undefined}
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`library-dialog__button is-primary${props.destructive ? ' is-destructive' : ''}`}
            data-testid={props.testId ? `${props.testId}-ok` : undefined}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
