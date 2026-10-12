import { randomUUID } from 'node:crypto'
import { EXTENSION_DIALOG_PANEL, type ExtensionDialogParams } from '../../shared/commands/extensions'
import type { OrbitState, WindowId } from '../../shared/state'
import type { MainContext } from '../context'

/**
 * Orbit's own dialogs about an extension (EX-02, EX-08): a panel in the window's overlay, never in a
 * page. `ask` resolves true only for the dialog's own Add or Remove button. Cancel, Esc, a click
 * outside, another overlay taking its place or the window closing all answer no.
 */
export class ExtensionDialogs {
  /** Open questions; `shown` once the window's overlay has shown the dialog (it opens a moment after `ask`). */
  private pending = new Map<string, { windowId: WindowId; shown: boolean; resolve: (yes: boolean) => void }>()

  constructor(private readonly ctx: MainContext) {
    ctx.commands.register('extensions.answer', ({ requestId, accept }, c) => {
      const asked = this.pending.get(requestId)
      if (!asked || (c.windowId && c.windowId !== asked.windowId)) return
      this.settle(requestId, accept === true)
      this.close(asked.windowId, requestId)
    })
    ctx.store.subscribe((next) => {
      if (this.pending.size === 0) return
      for (const [requestId, asked] of this.pending) {
        if (showing(next, asked.windowId, requestId)) asked.shown = true
        else if (asked.shown || !next.windows[asked.windowId]) this.settle(requestId, false)
      }
    })
  }

  /** Shows the dialog over a window; false at once if there is no such window. */
  ask(windowId: WindowId | undefined, params: Omit<ExtensionDialogParams, 'requestId'>): Promise<boolean> {
    if (!windowId || !this.ctx.store.state.windows[windowId]) return Promise.resolve(false)
    const requestId = randomUUID()
    const answer = new Promise<boolean>((resolve) => this.pending.set(requestId, { windowId, shown: false, resolve }))
    void this.ctx.commands.run(
      'overlay.open',
      {
        overlay: {
          kind: 'panel',
          panel: EXTENSION_DIALOG_PANEL,
          // The panel's params are flat: the lines go as one text, a line each.
          params: {
            requestId,
            kind: params.kind,
            name: params.name,
            icon: params.icon,
            lines: params.lines.join('\n'),
          },
        },
      },
      { windowId },
    )
    return answer
  }

  private settle(requestId: string, yes: boolean): void {
    const asked = this.pending.get(requestId)
    if (!asked) return
    this.pending.delete(requestId)
    asked.resolve(yes)
  }

  private close(windowId: WindowId, requestId: string): void {
    if (!showing(this.ctx.store.state, windowId, requestId)) return
    void this.ctx.commands.run('overlay.close', {}, { windowId })
  }
}

function showing(state: OrbitState, windowId: WindowId, requestId: string): boolean {
  const overlay = state.windows[windowId]?.overlay
  return (
    overlay?.kind === 'panel' && overlay.panel === EXTENSION_DIALOG_PANEL && overlay.params?.requestId === requestId
  )
}
