import { app, clipboard } from 'electron'
import { ACTIONS_BY_ID } from '../../shared/actions'
import { type BuildInfo, SETTINGS_ACTIONS } from '../../shared/commands/settings'
import { PROJECT_URL, RELEASES_URL } from '../../shared/project'
import type { WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { CallContext } from '../registry'
import { BUILD_DATE, BUILT_VERSION, bugReportUrl, buildInfoText } from './build-info'
import { creditsUrl } from './credits'
import { stubDefaultBrowser, systemDefaultBrowser } from './default-browser'
import { registerLinkSettings } from './links'
import { registerOnboarding } from './onboarding'
import { registerProfileSettings } from './profiles'
import { registerSearchSettings } from './search'
import { registerSystemSettings } from './system'
import { applySettingsPatch } from './validate'
import { SETTINGS_WINDOW_ID, SettingsWindow } from './window'

/**
 * Actions that open something new: pressed in Settings, they act in the browser window Settings
 * belongs to. Every other browser action (tabs, pages, the sidebar) has nothing to act on there.
 */
const FORWARDED = new Set(['tab.new', 'tab.reopenClosed', 'space.new'])

/** Settings feature (main process): the Settings window and its commands (ST-*). */
export function registerSettings(ctx: MainContext): void {
  const { store, commands, actions, windows } = ctx
  const settings = new SettingsWindow(ctx)

  commands.register('settings.open', (target, c) => settings.open(target ?? {}, c.windowId))
  commands.register('settings.close', () => settings.close())
  commands.register('settings.context', () => settings.reveal())
  commands.register('settings.update', (patch) => {
    let refused: string[] = []
    store.update((d) => {
      refused = applySettingsPatch(d.settings, patch, store.state)
    })
    if (refused.length) console.warn(`[settings] ignored settings.update keys: ${refused.join(', ')}`)
  })

  registerSearchSettings(ctx)
  registerProfileSettings(ctx)
  registerLinkSettings(ctx)
  registerSystemSettings(ctx)
  registerOnboarding(ctx)

  // A page opens in a new tab of the browser window it was asked from; from Settings, onboarding or
  // a Mini Window, in the one Settings belongs to (or the last used, or a new one).
  /** Opens a page in a new tab of the browser window Settings belongs to, and brings it forward. */
  const openInTab = async (url: string, c: CallContext) => {
    const from = c.windowId && store.state.windows[c.windowId]?.kind === 'main' ? c.windowId : undefined
    const windowId = (from && windows.get(from) ? from : undefined) ?? settings.browserWindow() ?? windows.open()
    await commands.run('tabs.create', { url }, { windowId })
    const win = windows.get(windowId)
    if (win && !win.isDestroyed()) win.focus()
  }
  commands.register('settings.openUrl', async ({ url }, c) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
    await openInTab(url, c)
  })
  // Licence and Open-source credits (ST-17, UP-07): the credits page that comes with Orbit (D43).
  commands.register('settings.openCredits', ({ at }, c) =>
    openInTab(creditsUrl(at === 'orbit' ? 'orbit' : undefined), c),
  )
  const openPage = (url: string, windowId: WindowId | undefined) =>
    commands.run('settings.openUrl', { url }, { windowId })
  // Default browser (ST-03). Test runs never change the OS setting.
  const defaultBrowser = ctx.e2e ? stubDefaultBrowser() : systemDefaultBrowser()
  commands.register('settings.defaultBrowser', () => defaultBrowser.status())
  commands.register('settings.setDefaultBrowser', () => defaultBrowser.set())

  // Import (IM-01) is the import lane's: offered when it registers `import.open`.
  commands.register('settings.capabilities', () => ({ importer: commands.has('import.open') }))
  commands.register('settings.openImport', async () => {
    if (!commands.has('import.open')) return false
    const windowId = settings.browserWindow() ?? windows.open()
    windows.get(windowId)?.focus()
    const run = commands.run.bind(commands) as unknown as (
      name: string,
      args: unknown,
      c: CallContext,
    ) => Promise<unknown>
    await run('import.open', {}, { windowId })
    return true
  })

  commands.register('settings.buildInfo', () => buildInfo())
  commands.register('settings.copyBuildInfo', () => {
    const text = buildInfoText(buildInfo())
    clipboard.writeText(text)
    return text
  })
  commands.register('settings.copyVersion', () => {
    const version = BUILT_VERSION ?? app.getVersion()
    clipboard.writeText(version)
    return version
  })

  // Help and feedback (OB-13), release notes (UP-06) and build info (UP-07): the project's public
  // pages in a tab. Orbit has no support server; a bug report is written on the issue tracker.
  actions.register('help.open', (c) => openPage(`${PROJECT_URL}#readme`, c.windowId))
  actions.register('help.reportBug', (c) => openPage(bugReportUrl(buildInfo()), c.windowId))
  actions.register('help.releaseNotes', (c) => openPage(RELEASES_URL, c.windowId))
  actions.register('help.copyBuildInfo', (c) => {
    clipboard.writeText(buildInfoText(buildInfo()))
    ctx.toast(c.windowId, 'Copied build info')
  })
  // Check for Updates… (UP-03): About, with the version, engine and the check's progress.
  actions.register('app.checkForUpdates', (c) => {
    settings.open({ section: 'about', item: 'check-updates' }, c.windowId ?? windows.focusedWindowId())
    if (commands.has('updates.check')) void commands.run('updates.check', {}, {})
  })

  // ⌘, (ST-01): replaces the core placeholder.
  actions.register('app.settings', (c) => settings.open({}, c.windowId ?? windows.focusedWindowId()))

  // Settings sections and settings as actions (ST-02). `from` is the window the action came from.
  const settingsActions = new Map<string, (from: WindowId | undefined) => void>()
  for (const def of SETTINGS_ACTIONS) settingsActions.set(def.id, (from) => settings.open(def.settings, from))
  settingsActions.set('settings.defaultBrowser', (from) => {
    settings.open({ section: 'general', item: 'default-browser' }, from)
    if (!defaultBrowser.status().isDefault) void defaultBrowser.set().then(() => settings.refresh())
  })
  for (const [id, run] of settingsActions) actions.register(id, (c) => run(c.windowId ?? windows.focusedWindowId()))

  // Shortcuts and menu items pressed while Settings has focus.
  actions.intercept((id, c) => {
    if (c.windowId !== SETTINGS_WINDOW_ID) return false
    if (id === 'tab.close' || id === 'window.close') settings.close()
    else if (id === 'app.settings') settings.focus()
    // Find (⌘F) searches Settings (ST-02).
    else if (id === 'page.find') settings.window?.webContents.send('orbit:settings.find')
    // A Settings action pressed in Settings stays there (ST-02).
    else if (settingsActions.has(id)) settingsActions.get(id)?.(SETTINGS_WINDOW_ID)
    else if (FORWARDED.has(id) || ACTIONS_BY_ID[id]?.category === 'Window' || ACTIONS_BY_ID[id]?.category === 'App') {
      const target = settings.browserWindow()
      const win = target ? windows.get(target) : undefined
      if (win && !win.isDestroyed()) win.focus()
      void actions.run(id, { windowId: target })
    }
    return true
  })
}

function buildInfo(): BuildInfo {
  const version = process.getSystemVersion()
  const os =
    process.platform === 'darwin'
      ? `macOS ${version}`
      : process.platform === 'win32'
        ? `Windows ${version}`
        : `${process.platform === 'linux' ? 'Linux' : process.platform} ${version}`
  return {
    version: BUILT_VERSION ?? app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    os,
    arch: process.arch,
    ...(BUILD_DATE ? { built: BUILD_DATE } : {}),
  }
}
