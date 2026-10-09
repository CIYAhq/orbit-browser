/**
 * Milestone 1 tour (about 40 s): the sidebar with Favorites, pinned and Today tabs,
 * the command bar (switch to an open tab, reopen from history, run an action), pinning,
 * a two-finger swipe between themed Spaces, and a three-pane split view.
 */

const PERSONAL = { colors: ['#7c9cff', '#c7b6ff'], intensity: 0.85, grain: 0.15 }
const WORK = { colors: ['#ff9a62', '#ff6f91'], intensity: 0.85, grain: 0.15 }
const SIDE = { colors: ['#4cc38a', '#9be4c3'], intensity: 0.8, grain: 0.15 }

/**
 * A two-finger swipe over the sidebar: `count` wheel steps of `dx` px, 16 ms apart. They are sent from
 * inside the page and stamped with that cadence (`orbitTimeStamp`), so a busy machine that delivers
 * input late can't split one swipe into two (which would move two Spaces).
 */
async function swipe(t, dx, count) {
  await t.shell.evaluate(
    ([dx, count]) =>
      new Promise((resolve) => {
        const target = document.querySelector('[data-testid="sidebar-scroll"]')
        const t0 = performance.now()
        let i = 0
        const step = () => {
          const e = new WheelEvent('wheel', { deltaX: dx, deltaY: 0, bubbles: true, cancelable: true })
          Object.defineProperty(e, 'orbitTimeStamp', { value: t0 + i * 16 })
          target?.dispatchEvent(e)
          if (++i < count) setTimeout(step, 16)
          else resolve()
        }
        step()
      }),
    [dx, count],
  )
}

/** Opens each tab once so it has its title and icon, as in a browser that has been used. */
async function visit(t, tabIds) {
  for (const tabId of tabIds) {
    await t.run('tabs.activate', { tabId })
    await t.sleep(450)
  }
}

/**
 * Unrecorded: three themed Spaces with Favorites, pinned and Today tabs, and some history.
 * Every tab is visited once (titles and icons), and nothing typed later can become a web search.
 */
export async function setup(t) {
  const s0 = await t.state()
  const personal = s0.spaceOrder[0]
  const profileId = s0.spaces[personal].profileId
  await t.run('spaces.update', { spaceId: personal, name: 'Personal', theme: PERSONAL })
  const create = (name, args) => t.run('tabs.create', { url: t.fx.url(name), activate: false, ...args })

  const personalTabs = []
  for (const name of ['Mail', 'Calendar', 'Music', 'Photos']) {
    personalTabs.push(await create(name, { container: { kind: 'favorites', profileId } }))
  }
  for (const name of ['Reading list', 'Budget']) {
    personalTabs.push(await create(name, { container: { kind: 'pinned', spaceId: personal } }))
  }
  // Visited and closed: the command bar finds it again in the Archive and history.
  const weather = await create('Weather', { spaceId: personal })
  await visit(t, [weather])
  await t.run('tabs.close', { tabId: weather })
  for (const name of ['Recipes', 'News', 'Trip planning']) personalTabs.push(await create(name, { spaceId: personal }))
  await visit(t, personalTabs)

  const work = await t.run('spaces.create', { name: 'Work', theme: WORK, activate: false })
  const workTabs = [await create('Team wiki', { container: { kind: 'pinned', spaceId: work } })]
  for (const name of ['Metrics', 'Design review', 'Standup notes']) workTabs.push(await create(name, { spaceId: work }))
  const side = await t.run('spaces.create', { name: 'Side project', theme: SIDE, activate: false, afterSpaceId: work })
  const sideTabs = []
  for (const name of ['Changelog', 'Sketches']) sideTabs.push(await create(name, { spaceId: side }))

  await t.run('spaces.switch', { spaceId: side })
  await visit(t, sideTabs)
  await t.run('spaces.switch', { spaceId: work })
  await visit(t, workTabs)
  await t.run('spaces.switch', { spaceId: personal })
  await t.sleep(800)
}

export default async function milestone1(t) {
  const { shell } = t
  const row = (name) => shell.getByTestId('tab-row').filter({ hasText: name }).first()
  const favorite = (i) => shell.getByTestId('favorite-tile').nth(i)
  const bar = async (text, pause = 650) => {
    await t.key('Mod+T')
    const overlay = await t.overlay()
    await t.sleep(350)
    await t.type(overlay, text, 95)
    await t.sleep(pause)
    return overlay
  }

  await t.sleep(1800)
  await t.shot('sidebar')

  // Command bar: switch to an open tab by typing part of its name.
  let overlay = await bar('recip')
  await t.shot('commandbar-switch')
  await overlay.keyboard.press('Enter')
  await t.sleep(1300)

  // Command bar: a page from history comes back as a new tab.
  overlay = await bar('weath')
  await overlay.keyboard.press('Enter')
  await t.sleep(1400)

  // Pin it (⌘D / Ctrl+D): it moves up into the pinned section.
  await t.key('Mod+D')
  await t.sleep(1500)

  // Favorites and tabs by click.
  await t.point(favorite(1))
  await favorite(1).click()
  await t.sleep(1200)
  await t.point(row('News'))
  await row('News').click()
  await t.sleep(1300)

  // Two-finger swipe over the sidebar to the next Space: the theme blends as it slides.
  await t.point(row('Trip planning'))
  await t.sleep(300)
  await swipe(t, 13, 15)
  await t.sleep(1800)
  await t.shot('space-work')

  // Split view: a new pane with the command bar to fill it, twice.
  await t.action('split.add')
  overlay = await t.overlay()
  await t.sleep(500)
  await t.type(overlay, 'metr', 100)
  await t.sleep(600)
  await overlay.keyboard.press('Enter')
  await t.sleep(1600)
  await t.action('split.addBelow')
  overlay = await t.overlay()
  await t.sleep(500)
  await t.type(overlay, 'design', 100)
  await t.sleep(600)
  await overlay.keyboard.press('Enter')
  await t.sleep(1800)
  await t.shot('split-view')

  // Next Space by keyboard, then swipe back through Work to Personal.
  await t.key('Mod+Alt+ArrowRight')
  await t.sleep(1800)
  await t.shot('space-side-project')
  await t.point(shell.getByTestId('space-strip'))
  for (let pass = 0; pass < 2; pass++) {
    await swipe(t, -13, 15)
    await t.sleep(1500)
  }

  // Command bar: an action by name.
  overlay = await bar('new spa', 900)
  await t.shot('commandbar-action')
  await overlay.keyboard.press('Escape')
  await t.sleep(1500)
}
