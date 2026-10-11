#!/usr/bin/env node
/**
 * Orbit performance harness: measures the budgets in docs/ARCHITECTURE.md §8
 * on the built app (run `npm run build` first). When Playwright's Chromium is
 * installed (`npx playwright install chromium`), it measures the comparable
 * scenarios in Chromium on the same machine.
 *
 * Linux: xvfb-run -a -s "-screen 0 1440x900x24" node scripts/perf/run.mjs [--runs 5] [--out perf-results/latest.json]
 *   [--port 3350] (the fixture server's first port; it takes the next free one up to 3399)
 *   [--cold-only] (Orbit's cold start alone: no interactive scenarios, no Chromium baseline)
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chromium, _electron as electron } from '@playwright/test'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const RUNS = Number(opt('runs', '5'))
const OUT = resolve(opt('out', 'perf-results/latest.json'))
const COLD_ONLY = args.includes('--cold-only')
const SKIP_CHROME = COLD_ONLY || args.includes('--no-chrome')
const FIRST_PORT = Number(opt('port', '3350'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : Number.NaN
}
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] : Number.NaN
}
const round = (x) => Math.round(x * 10) / 10
const log = (...m) => console.error(`[perf ${new Date().toISOString().slice(11, 19)}]`, ...m)

// ---------- fixtures (ports 3300–3399, no network) ----------
const PAGE = (n) => `<!doctype html><html><head><meta charset="utf-8"><title>Page ${n}</title>
<style>body{font:16px system-ui;margin:0;padding:32px;background:#f6f4ff}p{max-width:60ch;line-height:1.5}</style></head>
<body><h1>Page ${n}</h1>${'<p>Orbit performance fixture. The quick brown fox jumps over the lazy dog.</p>'.repeat(40)}</body></html>`

async function startFixtures() {
  const server = createServer((req, res) => {
    const n = (req.url ?? '/').split('/').pop() || '0'
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE(n))
  })
  let port = FIRST_PORT
  await new Promise((ok, fail) => {
    server.on('error', (err) =>
      err.code === 'EADDRINUSE' && port < 3399 ? server.listen(++port, '127.0.0.1') : fail(err),
    )
    server.listen(port, '127.0.0.1', ok)
  })
  return { url: (n) => `http://127.0.0.1:${port}/page/${n}`, close: () => new Promise((r) => server.close(r)) }
}

// ---------- process memory (RSS of a process tree, same method for Orbit and Chromium) ----------
function treeRssMb(rootPid) {
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
  const rows = out
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
  const children = new Map()
  for (const [pid, ppid] of rows) children.set(ppid, [...(children.get(ppid) ?? []), pid])
  const rss = new Map(rows.map(([pid, , kb]) => [pid, kb]))
  let total = 0
  const stack = [rootPid]
  while (stack.length) {
    const pid = stack.pop()
    total += rss.get(pid) ?? 0
    stack.push(...(children.get(pid) ?? []))
  }
  return total / 1024
}

// ---------- Orbit helpers ----------
const MAIN = resolve('out/main/index.js')
/**
 * Offline, as in the e2e tests (tests/e2e/helpers.ts): a dead local proxy, which loopback (the
 * fixture server) bypasses, and no host name resolves but localhost. Orbit and the Chromium baseline
 * both run with these.
 */
const OFFLINE = [
  '--proxy-server=http://127.0.0.1:9',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
]
async function launchOrbit(userData) {
  const app = await electron.launch({
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), ...OFFLINE, MAIN],
    env: { ...process.env, ORBIT_E2E: '1', ORBIT_USER_DATA: userData },
  })
  const deadline = Date.now() + 30_000
  let shell
  while (!shell && Date.now() < deadline) {
    shell = app.windows().find((p) => p.url().includes('view=shell'))
    if (!shell) await sleep(20)
  }
  if (!shell) throw new Error('shell window not found')
  return { app, shell }
}
/**
 * Quits Orbit as the e2e harness does (askQuit in tests/e2e/helpers.ts, PR #16): asked from a task of
 * its own, since Playwright's `app.close()` asks through the inspector, which can run the quit handlers
 * part-way through other main-process code. Playwright's own close then only cleans up.
 */
async function quitOrbit(app) {
  const exited = new Promise((resolve) => app.once('close', resolve))
  await app
    .evaluate(async ({ app: electronApp }) => {
      await new Promise((r) => setImmediate(r))
      electronApp.quit()
    })
    .catch(() => {})
  await Promise.race([exited, sleep(15_000)])
  await app.close()
}
const marks = (app) => app.evaluate(() => globalThis.__orbit.marks())
const orbitRun = (app, name, a) =>
  app.evaluate((_e, [n, x]) => globalThis.__orbit.run(n, x, globalThis.__orbit.windowIds()[0]), [name, a])
async function waitMark(app, name, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const found = (await marks(app)).find((m) => m.name === name)
    if (found) return found.t
    await sleep(10)
  }
  throw new Error(`mark ${name} not seen`)
}
async function waitTabsLoaded(app, ids, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const s = await app.evaluate(() => globalThis.__orbit.state())
    if (ids.every((id) => s.tabs[id] && !s.tabs[id].loading && !s.tabs[id].asleep)) return
    await sleep(50)
  }
  throw new Error('tabs did not finish loading')
}

async function orbitColdStart(fx) {
  const firstFrame = []
  const readyToShow = []
  const restoredPaint = []
  const restoredWall = []
  for (let i = 0; i < RUNS; i++) {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-perf-'))
    log(`cold start run ${i + 1}/${RUNS}`)
    let { app } = await launchOrbit(dir)
    firstFrame.push(await waitMark(app, 'shell:first-frame'))
    const m = await marks(app)
    const rts = m.find((x) => x.name.endsWith(':ready-to-show'))
    if (rts) readyToShow.push(rts.t)
    // Seed one tab, quit, relaunch: process start → restored tab finished loading.
    const tabId = await orbitRun(app, 'tabs.create', { url: fx.url(i), activate: true })
    await waitTabsLoaded(app, [tabId])
    await app.evaluate(() => globalThis.__orbit.flush())
    await quitOrbit(app)
    log('relaunch with restored tab')
    const w0 = Date.now()
    ;({ app } = await launchOrbit(dir))
    restoredPaint.push(await waitMark(app, `tab:${tabId}:loaded`))
    restoredWall.push(Date.now() - w0)
    await quitOrbit(app)
    rmSync(dir, { recursive: true, force: true })
  }
  return {
    processStartToShellFirstFrameMs: round(median(firstFrame)),
    processStartToReadyToShowMs: round(median(readyToShow)),
    processStartToRestoredTabLoadedMs: round(median(restoredPaint)),
    launchToRestoredTabLoadedWallMs: round(median(restoredWall)),
    samples: { firstFrame: firstFrame.map(round), restoredPaint: restoredPaint.map(round) },
  }
}

async function orbitInteractive(fx) {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-perf-'))
  const { app, shell } = await launchOrbit(dir)
  await waitMark(app, 'shell:first-frame')
  const result = {}

  log('memory')
  // Memory: 1 awake tab vs 10 awake tabs (RSS of the whole process tree).
  const pid = app.process().pid
  const tabs = []
  tabs.push(await orbitRun(app, 'tabs.create', { url: fx.url('m0'), activate: true }))
  await waitTabsLoaded(app, tabs)
  await sleep(1500)
  const rss1 = treeRssMb(pid)
  for (let i = 1; i < 10; i++) {
    const id = await orbitRun(app, 'tabs.create', { url: fx.url(`m${i}`), activate: true })
    tabs.push(id)
    await waitTabsLoaded(app, [id])
  }
  await sleep(1500)
  const rss10 = treeRssMb(pid)
  // Put every background tab to sleep and measure what is freed. Between tasks, as __orbit.run does:
  // the inspector could otherwise run this part-way through other main-process code.
  await app.evaluate(
    async (_e, ids) => {
      await new Promise((r) => setImmediate(r))
      for (const id of ids) globalThis.__orbit.ctx.tabs.sleep(id)
    },
    tabs.slice(0, -1),
  )
  await sleep(1500)
  const rssSlept = treeRssMb(pid)
  result.memory = {
    totalWith1TabMb: round(rss1),
    totalWith10TabsMb: round(rss10),
    perAwakeTabMb: round((rss10 - rss1) / 9),
    totalWith9AsleepMb: round(rssSlept),
    perSleepingTabMb: round((rssSlept - rss1) / 9),
  }

  log('tab switch')
  // Tab switch (all awake): main-side command time and time until the shell shows it.
  for (const id of tabs) await orbitRun(app, 'tabs.activate', { tabId: id })
  await waitTabsLoaded(app, tabs)
  const mainSide = []
  const shellSide = []
  for (let k = 0; k < 30; k++) {
    const target = tabs[k % tabs.length]
    const armed = shell.evaluate(
      (id) =>
        new Promise((done) => {
          const el = document.querySelector('[data-testid="content-frame"]')
          const check = () => el?.getAttribute('data-active-tab') === id
          const obs = new MutationObserver(() => {
            if (check()) {
              obs.disconnect()
              requestAnimationFrame(() => done(Date.now()))
            }
          })
          obs.observe(el, { attributes: true })
          setTimeout(() => done(null), 3000)
        }),
      target,
    )
    await sleep(30)
    const t0 = Date.now()
    const inMain = await app.evaluate(async (_e, id) => {
      const o = globalThis.__orbit
      // Start between tasks, as __orbit.run does, but time the command alone, not that hop.
      await new Promise((r) => setImmediate(r))
      const s = performance.now()
      await o.ctx.commands.run('tabs.activate', { tabId: id }, { windowId: o.windowIds()[0] })
      const visible = o.ctx.tabs.get(id)?.getVisible() ?? false
      return { ms: performance.now() - s, visible }
    }, target)
    mainSide.push(inMain.ms)
    const painted = await armed
    if (painted !== null) shellSide.push(painted - t0)
  }
  result.tabSwitch = {
    mainSideMedianMs: round(median(mainSide)),
    mainSideP95Ms: round(pct(mainSide, 95)),
    shellPaintedMedianMs: round(median(shellSide)),
    shellPaintedP95Ms: round(pct(shellSide, 95)),
  }

  log('command bar')
  // Command bar: shortcut → input painted (both marks on the main clock).
  const cbar = []
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  for (let k = 0; k < 10; k++) {
    const before = (await marks(app)).filter((x) => x.name === 'commandbar:open:painted').length
    await shell.keyboard.press(`${mod}+T`)
    const deadline = Date.now() + 5000
    let ms
    while (ms === undefined && Date.now() < deadline) {
      const m = await marks(app)
      const painted = m.filter((x) => x.name === 'commandbar:open:painted')
      const starts = m.filter((x) => x.name === 'commandbar:open:start')
      if (painted.length > before) ms = painted.at(-1).t - starts.at(-1).t
      else await sleep(10)
    }
    if (ms !== undefined) cbar.push(ms)
    await orbitRun(app, 'overlay.close', {})
    await sleep(100)
  }
  result.commandBarOpen = { medianMs: round(median(cbar)), p95Ms: round(pct(cbar, 95)) }

  log('space switch')
  // Space switch: command → new Space name painted in the shell.
  const spaceB = await orbitRun(app, 'spaces.create', { name: 'Perf B' })
  const s0 = await app.evaluate(() => globalThis.__orbit.state())
  const spaceA = s0.spaceOrder[0]
  const spaceTimes = []
  for (let k = 0; k < 10; k++) {
    const cur = await app.evaluate(() => {
      const st = globalThis.__orbit.state()
      return st.windows[globalThis.__orbit.windowIds()[0]].spaceId
    })
    const target = cur === spaceA ? spaceB : spaceA
    const name = (await app.evaluate(() => globalThis.__orbit.state())).spaces[target].name
    const armed = shell.evaluate(
      (want) =>
        new Promise((done) => {
          const obs = new MutationObserver(() => {
            const el = document.querySelector('[data-testid="space-name"]')
            if (el?.textContent?.includes(want)) {
              obs.disconnect()
              requestAnimationFrame(() => done(Date.now()))
            }
          })
          obs.observe(document.body, { subtree: true, childList: true, characterData: true })
          setTimeout(() => done(null), 3000)
        }),
      name,
    )
    await sleep(30)
    const t0 = Date.now()
    await orbitRun(app, 'spaces.switch', { spaceId: target })
    const painted = await armed
    if (painted !== null) spaceTimes.push(painted - t0)
    await sleep(100)
  }
  result.spaceSwitch = { medianMs: round(median(spaceTimes)), p95Ms: round(pct(spaceTimes, 95)) }

  log('sidebar scroll')
  // Sidebar scroll with 200 tabs (asleep; created without activation).
  await orbitRun(app, 'spaces.switch', { spaceId: spaceA })
  for (let i = 0; i < 200; i++) await orbitRun(app, 'tabs.create', { url: fx.url(`s${i}`), activate: false })
  await sleep(1000)
  result.sidebarScroll200 = await shell.evaluate(
    () =>
      new Promise((done) => {
        const el = document.querySelector('[data-testid="sidebar-scroll"]')
        const longTasks = []
        let obs
        try {
          obs = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) longTasks.push(e.duration)
          })
          obs.observe({ type: 'longtask', buffered: false })
        } catch {}
        const frames = []
        const max = el.scrollHeight - el.clientHeight
        let last = performance.now()
        let dir = 1
        const start = last
        const step = (now) => {
          frames.push(now - last)
          last = now
          el.scrollTop += dir * 24
          if (el.scrollTop >= max || el.scrollTop <= 0) dir *= -1
          if (now - start < 3000) requestAnimationFrame(step)
          else {
            obs?.disconnect()
            const sorted = frames.slice(1).sort((a, b) => a - b)
            const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length
            done({
              scrollableHeightPx: max,
              frames: sorted.length,
              avgFps: Math.round(1000 / avg),
              p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
              maxFrameMs: Math.round(sorted.at(-1) * 10) / 10,
              longTasks: longTasks.length,
            })
          }
        }
        requestAnimationFrame(step)
      }),
  )

  log('space switch and swipe, 200 tabs per Space')
  // §8 sidebar stress size on both sides of a switch (spaces lane review M5): Space A already
  // holds 200 tabs from the scroll test; give Space B 200 too.
  await orbitRun(app, 'spaces.switch', { spaceId: spaceB })
  for (let i = 0; i < 200; i++) await orbitRun(app, 'tabs.create', { url: fx.url(`b${i}`), activate: false })
  await sleep(1000)
  const bigTimes = []
  for (let k = 0; k < 8; k++) {
    const cur = await app.evaluate(() => {
      const st = globalThis.__orbit.state()
      return st.windows[globalThis.__orbit.windowIds()[0]].spaceId
    })
    const target = cur === spaceA ? spaceB : spaceA
    const name = (await app.evaluate(() => globalThis.__orbit.state())).spaces[target].name
    const armed = shell.evaluate(
      (want) =>
        new Promise((done) => {
          const obs = new MutationObserver(() => {
            const el = document.querySelector('[data-testid="space-name"]')
            if (el?.textContent?.includes(want)) {
              obs.disconnect()
              requestAnimationFrame(() => done(Date.now()))
            }
          })
          obs.observe(document.body, { subtree: true, childList: true, characterData: true })
          setTimeout(() => done(null), 3000)
        }),
      name,
    )
    await sleep(30)
    const t0 = Date.now()
    await orbitRun(app, 'spaces.switch', { spaceId: target })
    const painted = await armed
    if (painted !== null) bigTimes.push(painted - t0)
    await sleep(600)
  }
  // A slow two-finger swipe over the sidebar (wheel deltaX), frame times while it tracks.
  const strip = await shell.evaluate(() => {
    const r = document.querySelector('[data-testid="space-strip"]')?.getBoundingClientRect()
    return r ? { x: r.x + r.width / 2, y: r.y + Math.min(160, r.height / 2) } : null
  })
  let swipeFrames = []
  if (strip) {
    await shell.mouse.move(strip.x, strip.y)
    const frames = shell.evaluate(
      () =>
        new Promise((done) => {
          const out = []
          let last = performance.now()
          const t0 = last
          const tick = (now) => {
            out.push(now - last)
            last = now
            if (now - t0 < 900) requestAnimationFrame(tick)
            else done(out)
          }
          requestAnimationFrame(tick)
        }),
    )
    for (let i = 0; i < 40; i++) {
      await shell.mouse.wheel(3, 0)
      await sleep(16)
    }
    swipeFrames = (await frames).slice(2)
  }
  result.spaceSwitch200 = {
    medianMs: round(median(bigTimes)),
    p95Ms: round(pct(bigTimes, 95)),
    swipeMedianFrameMs: round(median(swipeFrames)),
    swipeP95FrameMs: round(pct(swipeFrames, 95)),
    samples: bigTimes,
  }

  await quitOrbit(app)
  rmSync(dir, { recursive: true, force: true })
  return result
}

// ---------- Chromium baseline (same machine, same fixtures) ----------
async function chromeBaseline(fx) {
  log('chromium baseline')
  const coldStart = []
  for (let i = 0; i < RUNS; i++) {
    const dir = mkdtempSync(join(tmpdir(), 'chrome-perf-'))
    const t0 = Date.now()
    const ctx = await chromium.launchPersistentContext(dir, { headless: false, args: OFFLINE })
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(fx.url(`c${i}`))
    coldStart.push(Date.now() - t0)
    await ctx.close()
    rmSync(dir, { recursive: true, force: true })
  }
  const server = await chromium.launchServer({ headless: false, args: OFFLINE })
  const pid = server.process().pid
  const browser = await chromium.connect(server.wsEndpoint())
  const ctx = await browser.newContext()
  const pages = [await ctx.newPage()]
  await pages[0].goto(fx.url('m0'))
  await sleep(1500)
  const rss1 = treeRssMb(pid)
  for (let i = 1; i < 10; i++) {
    const p = await ctx.newPage()
    await p.goto(fx.url(`m${i}`))
    pages.push(p)
  }
  await sleep(1500)
  const rss10 = treeRssMb(pid)
  const version = browser.version()
  await browser.close()
  await server.close()
  return {
    version,
    launchToFirstPageLoadedWallMs: round(median(coldStart)),
    memory: { totalWith1TabMb: round(rss1), totalWith10TabsMb: round(rss10), perTabMb: round((rss10 - rss1) / 9) },
    note: 'Playwright Chromium (Chrome for Testing build), headful under the same display. Cold start is wall clock from launch call to first page loaded, including Playwright launch overhead.',
  }
}

const fx = await startFixtures()
const report = { date: new Date().toISOString(), platform: process.platform, runs: RUNS }
try {
  report.orbit = { coldStart: await orbitColdStart(fx), ...(COLD_ONLY ? {} : await orbitInteractive(fx)) }
  if (!SKIP_CHROME) {
    try {
      report.chromium = await chromeBaseline(fx)
    } catch (err) {
      report.chromium = { error: String(err?.message ?? err).split('\n')[0] }
    }
  }
} finally {
  await fx.close()
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
