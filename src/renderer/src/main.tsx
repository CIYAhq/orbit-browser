import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { perfMark } from './api'
import { installReducedMotion } from './motion/reduced'
import { bootSettingsLaneView, isSettingsLaneView } from './settings/boot'
import { installShortcutFallback } from './shortcuts'
import { initStore } from './store'
import './motion/motion.css'
import './styles/global.css'

async function boot(): Promise<void> {
  // Every view follows reduced motion (the OS setting or Orbit's, FL-28) from its first frame.
  installReducedMotion()
  // Settings (settings lane): a window of its own, without the browser shell's code.
  if (isSettingsLaneView(window.orbit.view)) return bootSettingsLaneView()
  const view = window.orbit.view
  // The import window (import lane, IM-01).
  if (view === 'import') return (await import('./import/boot')).bootImport()
  // The floating player's controls (media lane): a small view of its own, without the app's shortcuts.
  if (view === 'pip') {
    const app = import('./pip/PipApp')
    await initStore()
    document.documentElement.dataset.view = view
    document.documentElement.dataset.platform = window.orbit.platform
    const { PipApp } = await app
    createRoot(document.getElementById('root') as HTMLElement).render(
      <StrictMode>
        <PipApp />
      </StrictMode>,
    )
    return
  }
  // A page's dialog over that page (pages lane, NV-24): alert, confirm, prompt, leave-page, sign-in.
  if (view === 'dialog') {
    const app = import('./pages/DialogApp')
    await initStore()
    installShortcutFallback()
    document.documentElement.dataset.view = view
    document.documentElement.dataset.platform = window.orbit.platform
    const { DialogApp } = await app
    createRoot(document.getElementById('root') as HTMLElement).render(
      <StrictMode>
        <DialogApp />
      </StrictMode>,
    )
    return
  }
  // What a page's area shows when its page couldn't load or crashed (pages lane, NV-13, NV-14).
  if (view === 'screen') {
    const app = import('./pages/ScreenApp')
    await initStore()
    installShortcutFallback()
    document.documentElement.dataset.view = view
    document.documentElement.dataset.platform = window.orbit.platform
    const { ScreenApp } = await app
    createRoot(document.getElementById('root') as HTMLElement).render(
      <StrictMode>
        <ScreenApp />
      </StrictMode>,
    )
    return
  }
  // The print dialog over a page (pages lane, NV-07).
  if (view === 'print') {
    const app = import('./pages/PrintApp')
    await initStore()
    installShortcutFallback()
    document.documentElement.dataset.view = view
    document.documentElement.dataset.platform = window.orbit.platform
    const { PrintApp } = await app
    createRoot(document.getElementById('root') as HTMLElement).render(
      <StrictMode>
        <PrintApp />
      </StrictMode>,
    )
    return
  }
  // The arrow a two-finger swipe over a page slides in (pages lane, NV-02).
  if (view === 'swipe') {
    const app = import('./pages/SwipeApp')
    await initStore()
    document.documentElement.dataset.view = view
    const { SwipeApp } = await app
    createRoot(document.getElementById('root') as HTMLElement).render(
      <StrictMode>
        <SwipeApp />
      </StrictMode>,
    )
    return
  }
  // An internal page (DT-13): Orbit's UI in a normal tab. Keys go to it as to any page.
  if (view === 'internal') {
    const app = import('./internal/InternalApp')
    await initStore()
    document.documentElement.dataset.view = view
    document.documentElement.dataset.platform = window.orbit.platform
    const { InternalApp } = await app
    createRoot(document.getElementById('root') as HTMLElement).render(
      <StrictMode>
        <InternalApp />
      </StrictMode>,
    )
    return
  }
  // Load the view's code while the state snapshot arrives.
  const app =
    view === 'overlay'
      ? import('./overlay/OverlayApp')
      : view === 'mini'
        ? import('./mini/MiniApp')
        : view === 'library'
          ? import('./library/LibraryApp')
          : import('./shell/ShellApp')
  await initStore()
  installShortcutFallback()
  document.documentElement.dataset.view = view
  document.documentElement.dataset.platform = window.orbit.platform
  const root = createRoot(document.getElementById('root') as HTMLElement)
  if (view === 'overlay') {
    const { OverlayApp } = (await app) as typeof import('./overlay/OverlayApp')
    root.render(
      <StrictMode>
        <OverlayApp />
      </StrictMode>,
    )
  } else if (view === 'mini') {
    const { MiniApp } = (await app) as typeof import('./mini/MiniApp')
    root.render(
      <StrictMode>
        <MiniApp />
      </StrictMode>,
    )
  } else if (view === 'sidebar') {
    // The hidden sidebar's floating card (chrome lane, SB-12): a transparent view at the window's left edge.
    const { FloatingSidebarApp } = await import('./shell/chrome/FloatingSidebarApp')
    root.render(
      <StrictMode>
        <FloatingSidebarApp />
      </StrictMode>,
    )
  } else if (view === 'tools') {
    // The page tools over the active page's corner (chrome lane, NV-05, NV-06): find bar and zoom indicator.
    const { PageToolsApp } = await import('./overlay/find/PageToolsApp')
    root.render(
      <StrictMode>
        <PageToolsApp />
      </StrictMode>,
    )
  } else if (view === 'prompt') {
    // A site's permission prompt over the page's corner while the sidebar is hidden (chrome lane, NV-15).
    const { PromptViewApp } = await import('./shell/chrome/PromptViewApp')
    root.render(
      <StrictMode>
        <PromptViewApp />
      </StrictMode>,
    )
  } else if (view === 'loading') {
    // The page loading indicator at the top of the page card (chrome lane, SB-28).
    const { LoadingApp } = await import('./shell/chrome/LoadingApp')
    root.render(
      <StrictMode>
        <LoadingApp />
      </StrictMode>,
    )
  } else if (view === 'link') {
    // The link status pill at the bottom of the page card (chrome lane, SB-27).
    const { LinkPillApp } = await import('./shell/chrome/LinkPillApp')
    root.render(
      <StrictMode>
        <LinkPillApp />
      </StrictMode>,
    )
  } else if (view === 'library') {
    // The Library (archive lane, AR-02): its own view over the page area.
    const { LibraryApp } = (await app) as typeof import('./library/LibraryApp')
    root.render(
      <StrictMode>
        <LibraryApp />
      </StrictMode>,
    )
  } else if (view === 'strip') {
    // Split view pane strip (split lane, SV-12): a tiny transparent view over a pane's top edge.
    const { PaneStripApp } = await import('./shell/split/PaneStripApp')
    root.render(
      <StrictMode>
        <PaneStripApp />
      </StrictMode>,
    )
  } else {
    const { ShellApp } = (await app) as typeof import('./shell/ShellApp')
    root.render(
      <StrictMode>
        <ShellApp />
      </StrictMode>,
    )
    requestAnimationFrame(() => perfMark('shell:first-frame'))
  }
}

void boot()
