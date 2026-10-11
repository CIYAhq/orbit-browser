/**
 * The Mini Window button (MW-13): an icon in the macOS menu bar, or in the Windows or Linux tray,
 * that opens a blank Mini Window with its lookup bar (MW-06). Off by default; Settings > General
 * turns it on. Its menu has New Mini Window and Show/Hide All Mini Windows (MW-14): on Windows and
 * Linux, where the Mini Window shortcut works only inside Orbit (D23), it is the way in from other
 * apps.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, Menu, type NativeImage, nativeImage, Tray } from 'electron'
import type { MainContext } from '../context'
import { drawGlyph } from './tray-icon'

const isMac = process.platform === 'darwin'
/** The glyph's colour where the build has no icon file: Orbit's accent, which reads on light and dark bars. */
const ACCENT = [106, 92, 240] as const
const NEW_MINI = 'New Mini Window'
const TOGGLE_MINIS = 'Show/Hide All Mini Windows'

export interface TrayButtonActions {
  /** Opens a blank Mini Window with its lookup bar. */
  open(): void
  /** Shows or hides every Mini Window. */
  toggleAll(): void
}

/** Test-only handle (ORBIT_E2E=1): globalThis.__orbitTray. */
export interface TrayTestHooks {
  /** The button as the OS has it, or null while it is off. */
  info(): { menu: string[]; template: boolean; size: { width: number; height: number }; scales: number[] } | null
  /** A click on the button. */
  click(): void
  /** Picks an item of its menu. */
  pick(label: string): void
}

/** Shows the button while the setting is on. */
export function registerTrayButton(ctx: MainContext, actions: TrayButtonActions): void {
  let tray: Tray | undefined
  let image: NativeImage | undefined
  const menu = Menu.buildFromTemplate([
    { label: NEW_MINI, click: () => actions.open() },
    { label: TOGGLE_MINIS, click: () => actions.toggleAll() },
  ])
  const show = (): Tray => {
    image ??= trayImage()
    const button = new Tray(image)
    button.setToolTip(NEW_MINI)
    button.on('click', () => actions.open())
    // On macOS a click opens at once and the menu waits for a right-click. Elsewhere the tray shows
    // the menu itself (some Linux trays show only the menu: it starts with New Mini Window).
    if (isMac) button.on('right-click', () => button.popUpContextMenu(menu))
    else button.setContextMenu(menu)
    return button
  }
  const sync = () => {
    const on = ctx.store.state.settings.miniWindowTrayButton
    if (on && !tray) tray = show()
    else if (!on && tray) {
      tray.destroy()
      tray = undefined
    }
  }
  ctx.store.subscribe((next, prev) => {
    if (next.settings.miniWindowTrayButton !== prev.settings.miniWindowTrayButton) sync()
  })
  sync()

  if (ctx.e2e) {
    const hooks: TrayTestHooks = {
      info: () =>
        tray && !tray.isDestroyed() && image
          ? {
              menu: menu.items.map((item) => item.label),
              template: image.isTemplateImage(),
              size: image.getSize(),
              scales: image.getScaleFactors(),
            }
          : null,
      click: () => tray?.emit('click'),
      pick: (label) => menu.items.find((item) => item.label === label)?.click(),
    }
    ;(globalThis as unknown as { __orbitTray: TrayTestHooks }).__orbitTray = hooks
  }
}

/** The menu-bar glyph on macOS (a template the system tints); elsewhere the app's icon, else the glyph. */
function trayImage(): NativeImage {
  if (isMac) {
    const image = glyphImage([0, 0, 0])
    image.setTemplateImage(true)
    return image
  }
  return appIcon() ?? glyphImage(ACCENT)
}

/** 16 px, with a 32 px version for high-density screens. */
function glyphImage(color: readonly [number, number, number]): NativeImage {
  const image = nativeImage.createEmpty()
  for (const scaleFactor of [1, 2]) {
    const size = 16 * scaleFactor
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: drawGlyph(size, color) })
  }
  return image
}

/** The app's icon at tray size: shipped beside a Linux build (electron-builder.yml), or the source's own. */
function appIcon(): NativeImage | undefined {
  for (const path of [join(process.resourcesPath, 'icon.png'), join(app.getAppPath(), 'build', 'icon.png')]) {
    if (!existsSync(path)) continue
    const source = nativeImage.createFromPath(path)
    if (source.isEmpty()) continue
    const image = nativeImage.createEmpty()
    for (const scaleFactor of [1, 2]) {
      const size = 16 * scaleFactor
      const buffer = source.resize({ width: size, height: size, quality: 'best' }).toPNG()
      image.addRepresentation({ scaleFactor, buffer })
    }
    return image
  }
  return undefined
}
