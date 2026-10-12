import { readFile, stat } from 'node:fs/promises'
import { app, dialog, type OpenDialogOptions } from 'electron'
import {
  EXTENSIONS_PAGE,
  EXTENSIONS_URL,
  type ExtensionsPageInfo,
  type InstallResult,
} from '../../shared/commands/extensions'
import { DEFAULT_PROFILE_ID } from '../../shared/defaults'
import { storeConfig } from '../../shared/extension-store'
import { popupAnchorOf } from '../../shared/extensions'
import { isPrivateProfileId } from '../../shared/private'
import type { ProfileId, Tab, TabId, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import { internalPageName } from '../devtools/internal-urls'
import { isUnplacedImportTab } from '../import/unplaced'
import { withDialog } from '../media/dialog-watch'
import type { ActionContext, CallContext } from '../registry'
import { ExtensionDialogs } from './dialogs'
import { ExtensionPopups, type PopupInfo } from './popup'
import { ExtensionService } from './service'
import { registerStore } from './store'

/** A .crx file larger than this isn't read (EX-09). */
const MAX_FILE_BYTES = 256 * 1024 * 1024

/** Test-only handle (ORBIT_E2E=1): globalThis.__orbitExtensions. */
export interface ExtensionTestHooks {
  /** The IDs that run now in a profile's session. */
  loaded: (profileId: ProfileId) => string[]
  /** Installs a .crx file's bytes as the file picker would, answering the confirmation with `accept`. */
  installBytes: (profileId: ProfileId, bytes: Uint8Array, accept: boolean) => Promise<InstallResult>
  /** The window's extension popup (EX-05), if one is open. */
  popup: (windowId: WindowId) => PopupInfo | null
}

/**
 * Chrome extensions (EX-*): installed per profile, run in that profile's session, managed on the
 * extensions page (`orbit://extensions/`, EX-07), asked about in Orbit's own dialogs (EX-02, EX-08).
 *
 * The page runs only the `extensions.*` commands listed for it (INTERNAL_PAGE_COMMANDS, D53), each
 * on its own tab's profile, never one it names: a script that got into it can't reach another
 * profile's extensions. Orbit's UI (the overlay's dialog, a toast's Pin) names the profile.
 */
export function registerExtensions(ctx: MainContext): void {
  const { actions, commands, store, tabs, windows } = ctx
  const dialogs = new ExtensionDialogs(ctx)
  const service = new ExtensionService(ctx, dialogs)
  service.start()

  /** The profile of the calling window's Space (EX-09). */
  const windowProfile = (windowId: WindowId | undefined): ProfileId => {
    const { state } = store
    const spaceId = windowId ? state.windows[windowId]?.spaceId : undefined
    const profileId = spaceId ? state.spaces[spaceId]?.profileId : undefined
    return profileId && state.profiles[profileId] ? profileId : DEFAULT_PROFILE_ID
  }

  /** The extensions page that calls, and its tab's profile: from the tab, never from the page. */
  const pageProfile = (c: CallContext): ProfileId | undefined => {
    const page = c.sender
    if (!page || page.isDestroyed() || windows.isUi(page)) return undefined
    const tabId = tabs.tabIdFor(page)
    const profileId = tabId ? store.state.tabs[tabId]?.profileId : undefined
    if (!profileId || internalPageName(page.getURL()) !== EXTENSIONS_PAGE) throw new Error('Forbidden')
    return profileId
  }

  /** Whose extensions a command acts on: the page's own, else the one asked for, else the window's. */
  const profileFor = (c: CallContext, asked?: ProfileId): ProfileId => {
    const own = pageProfile(c)
    if (own) return own
    if (asked && store.state.profiles[asked]) return asked
    return windowProfile(c.windowId ?? windows.focusedWindowId())
  }

  /** A file or folder the user picks, over the window when there is one. */
  const pick = async (windowId: WindowId | undefined, options: OpenDialogOptions): Promise<string | undefined> => {
    const win = windowId ? windows.get(windowId) : undefined
    const picked = win
      ? await withDialog(win, dialog.showOpenDialog(win, options))
      : await dialog.showOpenDialog(options)
    return picked.canceled ? undefined : picked.filePaths[0]
  }

  /** Tells the window how an install went: "<name> added", with Pin (EX-01), or why it failed. */
  const report = (windowId: WindowId | undefined, profileId: ProfileId, result: InstallResult) => {
    if (result.ok) {
      ctx.toast(windowId, `${result.name} added`, {
        label: 'Pin',
        command: 'extensions.pin',
        args: { id: result.id, pinned: true, profileId },
      })
    } else if (result.error) {
      ctx.toast(windowId, `Couldn’t add the extension. ${result.error}`)
    }
  }

  const privateRefusal = (windowId: WindowId | undefined): InstallResult => {
    const error = 'Extensions can’t be added in a private window.'
    ctx.toast(windowId, error)
    return { ok: false, error }
  }

  /** Reads a .crx the user picked. */
  const readCrx = async (path: string): Promise<Uint8Array> => {
    if ((await stat(path)).size > MAX_FILE_BYTES) throw new Error('The file is too large.')
    return new Uint8Array(await readFile(path))
  }

  // ---- Where the extensions page shows (EX-07) ----

  /** The page shows in a main window: from a Mini Window or a private one, the latest main window. */
  const mainWindowFor = (c: ActionContext, profileId?: ProfileId): WindowId | undefined => {
    const { state } = store
    const isMain = (id: WindowId | undefined): id is WindowId => !!id && state.windows[id]?.kind === 'main'
    const asked = c.windowId ?? windows.focusedWindowId()
    if (isMain(asked) && (!profileId || windowProfile(asked) === profileId)) return asked
    const mains = windows.ids().filter(isMain)
    const same = profileId ? mains.filter((id) => windowProfile(id) === profileId) : mains
    const target = same[same.length - 1] ?? mains[mains.length - 1] ?? windows.open()
    windows.get(target)?.focus()
    return target
  }

  /** The extensions tab of the Space a window shows, the one used last. */
  const pageTabIn = (windowId: WindowId): TabId | undefined => {
    const { state } = store
    const spaceId = state.windows[windowId]?.spaceId
    let found: Tab | undefined
    for (const tab of Object.values(state.tabs)) {
      if (tab.spaceId !== spaceId || tab.floating || isUnplacedImportTab(tab.id)) continue
      if (internalPageName(tab.url) !== EXTENSIONS_PAGE) continue
      if (!found || tab.lastActiveAt > found.lastActiveAt) found = tab
    }
    return found?.id
  }

  // ---- Popups (EX-05): what an extension's icon or row opens ----

  const popups = new ExtensionPopups(ctx, service, (windowId, url) => {
    // A page it asks for opens as a tab, at the top of Today (EX-12).
    const profileId = windowProfile(windowId)
    const target = mainWindowFor({ windowId }, profileId)
    if (target) void commands.run('tabs.create', { url, activate: true }, { windowId: target }).catch(() => {})
  })

  // ---- The page's commands and Orbit's UI (EX-07, EX-08, EX-09) ----

  commands.register('extensions.pageInfo', (_args, c): ExtensionsPageInfo => {
    const profileId = pageProfile(c) ?? windowProfile(c.windowId)
    return { profileId, profileName: store.state.profiles[profileId]?.name ?? '' }
  })

  commands.register('extensions.setEnabled', ({ id, enabled, profileId }, c) =>
    service.setEnabled(profileFor(c, profileId), id, enabled === true),
  )

  commands.register('extensions.setAllowed', ({ id, what, allowed, profileId }, c) => {
    if (what !== 'private' && what !== 'files') return false
    return service.setAllowed(profileFor(c, profileId), id, what, allowed === true)
  })

  commands.register('extensions.pin', ({ id, pinned, profileId }, c) =>
    service.pin(profileFor(c, profileId), id, pinned === true),
  )

  commands.register('extensions.remove', ({ id, profileId }, c) =>
    service.confirmRemove(profileFor(c, profileId), id, c.windowId ?? windows.focusedWindowId()),
  )

  commands.register('extensions.reload', ({ id, profileId }, c) => {
    const owner = profileFor(c, profileId)
    popups.closeFor(owner, id)
    return service.reload(owner, id)
  })

  // A click on its pinned icon or its row (EX-03, EX-04): its popup (EX-05). Orbit's UI only.
  commands.register('extensions.run', ({ id, profileId, anchor, inspect }, c) => {
    const windowId = c.windowId ?? windows.focusedWindowId()
    const where = popupAnchorOf(anchor)
    if (!windowId || !where || typeof id !== 'string') return 'none'
    const ext = service.get(profileFor(c, profileId), id)
    if (!ext?.enabled) return 'none'
    if (!ext.popup) {
      // Its button would tell its service worker (chrome.action.onClicked), which the engine can't do yet.
      ctx.toast(windowId, `${ext.name} has no popup, and Orbit can’t run its button yet.`)
      return 'none'
    }
    const shown = popups.show(windowId, ext, where, inspect === true)
    if (shown === 'none') ctx.toast(windowId, `${ext.name} isn’t running.${ext.error ? ` ${ext.error}` : ''}`)
    return shown
  })

  commands.register('extensions.openOptions', async ({ id, profileId }, c) => {
    const owner = profileFor(c, profileId)
    const ext = service.get(owner, id)
    if (!ext?.options || !ext.enabled || !service.isLoaded(owner, id)) return false
    const windowId = mainWindowFor({ windowId: c.windowId }, owner)
    if (!windowId) return false
    await commands.run('tabs.create', { url: `chrome-extension://${id}/${ext.options}`, activate: true }, { windowId })
    return true
  })

  commands.register('extensions.setDevMode', ({ on }) => {
    store.update((d) => {
      d.settings.extensionsDevMode = on === true
    })
  })

  commands.register('extensions.installFile', async ({ profileId }, c): Promise<InstallResult> => {
    const target = profileFor(c, profileId)
    const windowId = c.windowId ?? windows.focusedWindowId()
    if (isPrivateProfileId(target)) return privateRefusal(windowId)
    const path = await pick(windowId, {
      title: 'Add Extension',
      buttonLabel: 'Add',
      properties: ['openFile'],
      filters: [
        { name: 'Extensions', extensions: ['crx'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (!path) return { ok: false, cancelled: true }
    let bytes: Uint8Array
    try {
      bytes = await readCrx(path)
    } catch {
      const result: InstallResult = { ok: false, error: 'The file couldn’t be read.' }
      report(windowId, target, result)
      return result
    }
    const result = await service.installCrx(target, bytes, (preview) =>
      dialogs.ask(windowId, { kind: 'install', name: preview.name, icon: preview.icon, lines: preview.lines }),
    )
    report(windowId, target, result)
    return result
  })

  commands.register('extensions.loadUnpacked', async ({ profileId }, c): Promise<InstallResult> => {
    const target = profileFor(c, profileId)
    const windowId = c.windowId ?? windows.focusedWindowId()
    if (isPrivateProfileId(target)) return privateRefusal(windowId)
    const dir = await pick(windowId, {
      title: 'Load Unpacked Extension',
      buttonLabel: 'Load',
      properties: ['openDirectory'],
    })
    if (!dir) return { ok: false, cancelled: true }
    const result = await service.installFolder(target, dir)
    if (result.ok) ctx.toast(windowId, `${result.name} loaded`)
    else report(windowId, target, result)
    return result
  })

  // ---- Actions: the command bar, menus and keys (EX-07, EX-09) ----

  actions.register('extension.manage', async (c) => {
    const windowId = mainWindowFor(c)
    if (!windowId) return
    await commands.run('library.close', {}, { windowId })
    const tabId = pageTabIn(windowId)
    if (tabId) await commands.run('tabs.activate', { tabId }, { windowId })
    else await commands.run('tabs.create', { url: EXTENSIONS_URL, activate: true }, { windowId })
  })

  actions.register('extension.installFile', async (c) => {
    await commands.run('extensions.installFile', {}, { windowId: c.windowId ?? windows.focusedWindowId() })
  })

  // ---- The extension store (EX-01) ----

  registerStore(ctx, storeConfig(process.env, app.isPackaged), {
    service,
    dialogs,
    report,
    privateRefusal,
    mainWindowFor: (c) => mainWindowFor(c),
  })

  if (ctx.e2e) {
    const hooks: ExtensionTestHooks = {
      loaded: (profileId) => {
        const ses = service.session(profileId)
        return ses ? ses.extensions.getAllExtensions().map((e) => e.id) : []
      },
      installBytes: (profileId, bytes, accept) =>
        service.installCrx(profileId, new Uint8Array(bytes), async () => accept),
      popup: (windowId) => popups.info(windowId),
    }
    ;(globalThis as unknown as { __orbitExtensions: ExtensionTestHooks }).__orbitExtensions = hooks
  }
}
