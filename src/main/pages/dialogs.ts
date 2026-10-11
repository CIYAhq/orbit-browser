import { type IpcMainEvent, ipcMain, type WebContents } from 'electron'
import { type PageDialogAnswer, type PageDialogContent, scriptAnswer, scriptDialog } from '../../shared/pages'
import type { Rect } from '../../shared/rpc'
import { PAGE_CHANNEL } from '../../shared/site'
import type { TabId } from '../../shared/state'
import type { MainContext } from '../context'
import { createCovers, type HostKind } from './covers'

interface Dialog {
  content: PageDialogContent
  resolve: (answer: PageDialogAnswer | null) => void
  /** The page's own alert, confirm or prompt: it goes when the page navigates. */
  script: boolean
}

export interface PageDialogInfo {
  id: number
  kind: PageDialogContent['kind']
  title: string
  message: string
  tabId: TabId | null
  /** Where it shows; null while the page has no window. */
  host: HostKind | null
  /** Its view is on screen over the page. */
  onScreen: boolean
  /** Its view has the keyboard. */
  focused: boolean
  bounds?: Rect
  /** Later dialogs of the same page, waiting their turn. */
  waiting: number
}

/** Which of a page's dialogs: its own alert, confirm and prompt, "Page unresponsive", or all. */
export type DialogsWhich = 'script' | 'hang' | 'all'

export interface PageDialogs$ {
  /** Shows a dialog over a page (once the page is on screen); resolves with the answer, or null if it went away. */
  open(page: WebContents, content: Omit<PageDialogContent, 'id'>, script?: boolean): Promise<PageDialogAnswer | null>
  /** Closes some of a page's dialogs, each as Cancel. */
  dismiss(page: WebContents, which: DialogsWhich): void
  /** Whether a page has a dialog open or waiting: its own alert, confirm or prompt (the page waits), or any. */
  pending(page: WebContents, which?: DialogsWhich): boolean
  /** Whether Orbit can show a dialog over a page: a tab's (a Peek's and a Mini Window's too) or a pop-up's. */
  hostable(page: WebContents): boolean
  /** Tests: every page's first dialog. */
  info(): PageDialogInfo[]
}

/**
 * Page dialogs (NV-24): a page's alert, confirm and prompt, the leave-page warning, HTTP sign-in and
 * "Page unresponsive", in Orbit's own small dialog over that page's area only. The rest of the
 * window stays usable: other tabs, the sidebar, the command bar. A dialog waits while its page is
 * off screen (another tab is selected, the window is closed to the Library) and shows again when
 * the page does. Each page's dialogs show one at a time in a transparent view over the page
 * (`createCovers`), which takes the keyboard (Enter, Esc and Tab go to the dialog first, KS-19) and
 * gives it back to the page when the last one closes (KS-16).
 */
export function registerDialogs(ctx: MainContext): PageDialogs$ {
  const { tabs, commands } = ctx
  /** Each page's dialogs, by its contents' id: the first shows, the rest wait their turn. */
  const queues = new Map<number, { page: WebContents; list: Dialog[] }>()
  let nextId = 1

  const covers = createCovers(ctx, { view: 'dialog', content: (page) => queues.get(page.id)?.list[0]?.content })

  const matches = (dialog: Dialog, which: DialogsWhich) =>
    which === 'all' || (which === 'script' ? dialog.script : dialog.content.kind === 'hang')

  const settle = (page: WebContents, dialog: Dialog, answer: PageDialogAnswer | null) => {
    const queue = queues.get(page.id)?.list
    const at = queue?.indexOf(dialog) ?? -1
    if (!queue || at < 0) return
    queue.splice(at, 1)
    if (queue.length === 0) queues.delete(page.id)
    dialog.resolve(answer)
    // The next dialog shows, or the view goes and the page gets the keyboard back (KS-16).
    if (at === 0) covers.update(page)
  }

  const service: PageDialogs$ = {
    open(page, content, script = false) {
      return new Promise((resolve) => {
        if (page.isDestroyed()) {
          resolve(null)
          return
        }
        let queue = queues.get(page.id)
        if (!queue) {
          const made = { page, list: [] as Dialog[] }
          queue = made
          queues.set(page.id, made)
          // A page that goes takes its dialogs with it.
          page.once('destroyed', () => {
            if (queues.get(page.id) !== made) return
            queues.delete(page.id)
            for (const dialog of made.list.splice(0)) dialog.resolve(null)
          })
        }
        queue.list.push({ content: { ...content, id: nextId++ }, resolve, script })
        if (queue.list.length === 1) covers.update(page)
      })
    },
    dismiss(page, which) {
      for (const dialog of [...(queues.get(page.id)?.list ?? [])])
        if (matches(dialog, which)) settle(page, dialog, null)
    },
    pending(page, which = 'all') {
      return (queues.get(page.id)?.list ?? []).some((dialog) => matches(dialog, which))
    },
    hostable: (page) => covers.hostable(page),
    info() {
      return [...queues.values()].flatMap(({ page, list: queue }) => {
        const first = queue[0]
        if (!first || page.isDestroyed()) return []
        const shown = covers.info(page)
        return [
          {
            id: first.content.id,
            kind: first.content.kind,
            title: first.content.title,
            message: first.content.message,
            tabId: tabs.tabIdFor(page) ?? null,
            host: shown.host,
            onScreen: shown.onScreen,
            focused: shown.focused,
            ...(shown.bounds ? { bounds: shown.bounds } : {}),
            waiting: queue.length - 1,
          },
        ]
      })
    },
  }

  commands.register('pages.dialogContent', (_args, c) => {
    if (!c.sender) return null
    return covers.shownBy(c.sender)?.content ?? null
  })

  commands.register('pages.dialogAnswer', (answer, c) => {
    const page = c.sender ? covers.shownBy(c.sender)?.page : undefined
    const first = page ? queues.get(page.id)?.list[0] : undefined
    if (!page || !first || first.content.id !== answer.id) return
    settle(page, first, {
      id: answer.id,
      ok: answer.ok === true,
      ...(typeof answer.value === 'string' ? { value: answer.value } : {}),
      ...(typeof answer.user === 'string' ? { user: answer.user } : {}),
      ...(typeof answer.password === 'string' ? { password: answer.password } : {}),
    })
  })

  // A page's alert, confirm or prompt (the page preload, NV-24): the page waits for the answer.
  ipcMain.on(PAGE_CHANNEL.dialog, (event: IpcMainEvent, kind: unknown, message: unknown, value: unknown) => {
    let replied = false
    const reply = (result: unknown) => {
      if (replied) return
      replied = true
      event.returnValue = result
    }
    try {
      const page = event.sender
      const frame = event.senderFrame
      if (kind !== 'alert' && kind !== 'confirm' && kind !== 'prompt') {
        reply(null)
        return
      }
      // Only a page's main frame has the preload (D40), and only a tab's or a pop-up's page has a
      // place for the dialog.
      if (!frame || frame.parent || page.isDestroyed() || !covers.hostable(page)) {
        reply(scriptAnswer(kind, null))
        return
      }
      const content = scriptDialog(kind, frame.url, String(message ?? ''), String(value ?? ''))
      service.open(page, content, true).then(
        (answer) => reply(scriptAnswer(kind, answer)),
        () => reply(scriptAnswer(kind, null)),
      )
    } catch (err) {
      console.error('[pages] page dialog', err)
      reply(null)
    }
  })

  return service
}
