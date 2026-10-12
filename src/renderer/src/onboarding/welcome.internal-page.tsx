import type { ReactNode } from 'react'
import type { InternalPage } from '../internal/registry'
import { HelpButton, K, useArchivePeriod, useLiveKeys } from './help-parts'

function Tip({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="help__tip" data-testid="welcome-tip">
      <strong>{title}</strong>
      {children}
    </li>
  )
}

/**
 * `orbit://welcome/` (OB-09): the first window's one Today tab. A handful of tips with the user's
 * keys (KS-18), then the way to the guide (OB-10), Help (OB-13) and the shortcut sheet (OB-12).
 */
function WelcomePage() {
  useLiveKeys()
  const period = useArchivePeriod()
  return (
    <article className="help" data-testid="welcome">
      <h1 className="internal__title">Welcome to Orbit</h1>
      <p className="help__lead">A few things worth knowing on your first day.</p>
      <ul className="help__tips">
        <Tip title="Start anything from the command bar">
          New Tab
          <K a="tab.new" /> opens it: type an address or a search, the name of a tab you have open, or an action like
          “split” or “archive”.
        </Tip>
        <Tip title="Pin what you keep">
          Pin / Unpin Tab
          <K a="tab.togglePin" /> keeps a tab in the sidebar for good. Today tabs you leave for {period} move to the
          Archive, where nothing is lost.
        </Tip>
        <Tip title="A Space for each part of your life">
          Work, home, a project: each Space has its own tabs and colours. Make one with the + at the bottom of the
          sidebar, and switch with Next Space
          <K a="space.next" />.
        </Tip>
        <Tip title="Two pages side by side">
          New Split View
          <K a="split.add" />, or drag a tab from the sidebar onto the page.
        </Tip>
        <Tip title="Room for the page">
          Toggle Sidebar
          <K a="sidebar.toggle" /> hides the sidebar. Point at the window’s left edge to see it again.
        </Tip>
      </ul>
      <p>
        The guide and Help are also in the <strong>Orbit basics</strong> folder at the top of your sidebar.
      </p>
      <div className="help__more">
        <a className="internal__link" href="orbit://guide/" data-testid="welcome-guide">
          Getting started
        </a>
        <a className="internal__link" href="orbit://help/" data-testid="welcome-help">
          Orbit Help
        </a>
        <HelpButton id="help.shortcuts" testId="welcome-shortcuts">
          Show Keyboard Shortcuts
        </HelpButton>
      </div>
    </article>
  )
}

export const page: InternalPage = {
  name: 'welcome',
  title: 'Welcome to Orbit',
  description: 'The first window’s tips, and the way to the guide and Help.',
  component: WelcomePage,
}
