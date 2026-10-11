import type { CommandName } from './rpc'

/** A toast's button: it runs a command, e.g. "Show" after a Space was made with the sidebar hidden (SP-02). */
export interface ToastAction {
  label: string
  command: CommandName
  args?: unknown
}

/** What a window is told to show as a toast. */
export interface ToastPayload {
  message: string
  action?: ToastAction
}
