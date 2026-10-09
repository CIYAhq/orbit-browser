// Renders build/icon.svg to build/icon.png (1024x1024) using Electron's offscreen renderer.
// Usage: xvfb-run -s '-screen 0 1600x1600x24' npx electron --no-sandbox scripts/render-icon.mjs
// (the screen must be larger than 1024px or the window is clamped)
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

const root = join(import.meta.dirname, '..')
const svg = readFileSync(join(root, 'build/icon.svg'), 'utf8')
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: true },
  })
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 300))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  writeFileSync(join(root, 'build/icon.png'), image.toPNG())
  console.log('wrote build/icon.png', image.getSize())
  app.quit()
})
