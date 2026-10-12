import { useEffect, useLayoutEffect, useRef } from 'react'
import type { OverlayState } from '../../../shared/state'
import { invoke } from '../api'
import { ExtensionIcon } from './ExtensionIcon'
import './extensions.css'

type PanelOverlay = Extract<OverlayState, { kind: 'panel' }>

/**
 * Orbit's own dialog about an extension, in the window's overlay (EX-02, EX-08): never in a page.
 * Installing shows its icon, its name and what it may do, with Add extension / Cancel; removing asks
 * "Remove “<name>”?" with Remove / Cancel. Cancel has the focus. Esc or a click outside is Cancel.
 */
export function ExtensionDialog({ overlay }: { overlay: PanelOverlay }) {
  const params = overlay.params ?? {}
  const requestId = typeof params.requestId === 'string' ? params.requestId : ''
  const kind = params.kind === 'remove' ? 'remove' : 'install'
  const name = typeof params.name === 'string' ? params.name : ''
  const icon = typeof params.icon === 'string' ? params.icon : ''
  const lines = typeof params.lines === 'string' && params.lines ? params.lines.split('\n') : []
  const cancelRef = useRef<HTMLButtonElement>(null)
  const answered = useRef(false)

  const answer = (accept: boolean) => {
    if (answered.current) return
    answered.current = true
    void invoke('extensions.answer', { requestId, accept })
  }

  useLayoutEffect(() => cancelRef.current?.focus(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      answer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const install = kind === 'install'
  return (
    <div
      className="ext-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) answer(false)
      }}
    >
      <div
        className="ext-dialog"
        role="alertdialog"
        aria-modal
        aria-labelledby="ext-dialog-title"
        data-testid="ext-dialog"
        data-kind={kind}
      >
        <div className="ext-dialog__head">
          <ExtensionIcon icon={icon} size={32} testId="ext-dialog-icon" />
          <h2 id="ext-dialog-title" className="ext-dialog__title" data-testid="ext-dialog-title">
            {install ? `Add “${name}”?` : `Remove “${name}”?`}
          </h2>
        </div>
        {install && lines.length > 0 && (
          <>
            <p className="ext-dialog__text">It can:</p>
            <ul className="ext-dialog__perms" data-testid="ext-dialog-permissions">
              {lines.map((line) => (
                <li key={line} className="ext-dialog__perm">
                  {line}
                </li>
              ))}
            </ul>
          </>
        )}
        {install && lines.length === 0 && (
          <p className="ext-dialog__text" data-testid="ext-dialog-permissions">
            It asks for no special permissions.
          </p>
        )}
        {!install && <p className="ext-dialog__text">It is removed from this profile, with its data and settings.</p>}
        <div className="ext-dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="ext-button"
            data-testid="ext-dialog-cancel"
            onClick={() => answer(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`ext-button ${install ? 'is-primary' : 'is-danger'}`}
            data-testid="ext-dialog-confirm"
            onClick={() => answer(true)}
          >
            {install ? 'Add extension' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  )
}
