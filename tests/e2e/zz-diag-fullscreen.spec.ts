import { test } from '@playwright/test'
import type { MainContext } from '../../src/main/context'
import { launchOrbit, run, startFixtures, tabPage } from './helpers'

// TEMPORARY diagnostic (core lane): records what macOS does with HTML and window fullscreen.
type OrbitGlobal = { __orbit: { ctx: MainContext } }

test('diag: fullscreen timeline', async () => {
  test.setTimeout(90_000)
  const fx = await startFixtures()
  const orbit = await launchOrbit()
  try {
    const tabId = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Video') })) as string
    await tabPage(orbit.app, '/page/Video')
    await new Promise((r) => setTimeout(r, 1000))
    const log = await orbit.app.evaluate(async ({ screen, app }, id) => {
      const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
      const win = ctx.windows.get(ctx.windows.ids()[0] as string)
      const contents = ctx.tabs.get(id)?.webContents
      if (!win || !contents) return ['no window or contents']
      const t0 = Date.now()
      const out: unknown[] = []
      const mark = (what: string) =>
        out.push([
          Date.now() - t0,
          what,
          `fs=${win.isFullScreen()}`,
          `content=${win.getContentSize().join('x')}`,
          `view=${JSON.stringify(ctx.tabs.get(id)?.getBounds())}`,
        ])
      for (const ev of ['enter-full-screen', 'leave-full-screen', 'resize'] as const) {
        win.on(ev as 'resize', () => mark(`win:${ev}`))
      }
      contents.on('enter-html-full-screen', () => mark('wc:enter-html'))
      contents.on('leave-html-full-screen', () => mark('wc:leave-html'))
      const race = (p: Promise<unknown>, ms: number) =>
        Promise.race([
          p.then((v) => `resolved:${String(v)}`).catch((e) => `rejected:${String(e)}`),
          new Promise((r) => setTimeout(() => r('timeout'), ms)),
        ])
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      mark(
        `start display=${JSON.stringify(screen.getPrimaryDisplay().bounds)} fullscreenable=${win.isFullScreenable()} visible=${win.isVisible()} focused=${win.isFocused()} appHidden=${app.isHidden?.()}`,
      )
      mark(
        `request -> ${await race(contents.executeJavaScript('document.documentElement.requestFullscreen().then(() => "ok")', true), 8000)}`,
      )
      await sleep(3000)
      mark(`+3s fsElement=${await race(contents.executeJavaScript('String(!!document.fullscreenElement)'), 2000)}`)
      mark(
        `exit -> ${await race(contents.executeJavaScript('document.exitFullscreen().then(() => "ok")', true), 8000)}`,
      )
      await sleep(3000)
      mark(`+3s fsElement=${await race(contents.executeJavaScript('String(!!document.fullscreenElement)'), 2000)}`)
      win.setFullScreen(true)
      await sleep(3000)
      mark('setFullScreen(true) +3s')
      win.setFullScreen(false)
      await sleep(3000)
      mark('setFullScreen(false) +3s')
      return out
    }, tabId)
    console.log(`FSDIAG ${process.platform}`)
    for (const line of log) console.log('FSDIAG', JSON.stringify(line))
  } finally {
    await orbit.app.close().catch(() => {})
    await fx.close()
  }
})
