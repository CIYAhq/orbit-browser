import { test } from '@playwright/test'
import type { MainContext } from '../../src/main/context'
import { launchOrbit, run, startFixtures, tabPage } from './helpers'

// TEMPORARY diagnostic (core lane): quick HTML fullscreen exit on macOS without the settle mitigation.
type OrbitGlobal = { __orbit: { ctx: MainContext } }

test('diag: quick exit without settle, then settle', async () => {
  test.setTimeout(90_000)
  const fx = await startFixtures()
  const orbit = await launchOrbit()
  try {
    const tabId = (await run(orbit.app, 'tabs.create', { url: fx.url('/page/Video') })) as string
    await tabPage(orbit.app, '/page/Video')
    await new Promise((r) => setTimeout(r, 1000))
    const log = await orbit.app.evaluate(async (_e, id) => {
      const ctx = (globalThis as unknown as OrbitGlobal).__orbit.ctx
      const wm = ctx.windows as unknown as { settleHtmlFullscreen: (rec: unknown) => void }
      const settle = wm.settleHtmlFullscreen.bind(wm)
      wm.settleHtmlFullscreen = () => {}
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
          `view=${JSON.stringify(ctx.tabs.get(id)?.getBounds())}`,
        ])
      for (const ev of ['enter-full-screen', 'leave-full-screen'] as const)
        win.on(ev as 'enter-full-screen', () => mark(`win:${ev}`))
      contents.on('enter-html-full-screen', () => mark('wc:enter-html'))
      contents.on('leave-html-full-screen', () => mark('wc:leave-html'))
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const fsEl = () =>
        Promise.race([
          contents.executeJavaScript('String(!!document.fullscreenElement)'),
          sleep(2000).then(() => 'timeout'),
        ])
      let exited = 'pending'
      contents
        .executeJavaScript(
          'document.documentElement.requestFullscreen().then(() => document.exitFullscreen()).then(() => "out")',
          true,
        )
        .then((v) => {
          exited = String(v)
          mark(`quick exit resolved: ${v}`)
        })
        .catch((e) => mark(`quick exit rejected: ${e}`))
      await sleep(5000)
      mark(`+5s exited=${exited} fsElement=${await fsEl()}`)
      // Now the mitigation, by hand: what WindowManager does when a native transition ends.
      const records = (ctx.windows as unknown as { records: Map<string, unknown> }).records
      for (const rec of records.values()) settle(rec)
      await sleep(3000)
      mark(`after settle +3s exited=${exited} fsElement=${await fsEl()}`)
      return out
    }, tabId)
    for (const line of log) console.log('FSDIAG2', JSON.stringify(line))
  } finally {
    await orbit.app.close().catch(() => {})
    await fx.close()
  }
})
