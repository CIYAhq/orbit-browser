import type { InternalPage } from '../internal/registry'
import { sheetGroups } from '../keys/sheet'
import { useOrbit } from '../store'
import { HelpButton, K, Section, SettingsLink, useArchivePeriod, useLiveKeys } from './help-parts'

const CONTENTS: [string, string][] = [
  ['sidebar', 'The sidebar'],
  ['spaces', 'Spaces'],
  ['tabs', 'Pinned, Favorites and Today'],
  ['command-bar', 'The command bar'],
  ['split-view', 'Split view'],
  ['peek', 'Peek'],
  ['mini-window', 'Mini Window'],
  ['sites', 'Site controls'],
  ['shortcuts', 'Essential shortcuts'],
]

/** The essential shortcuts (OB-12's sheet) as a table, with the keys as they are now (KS-18). */
function ShortcutTable() {
  const lastTabOnCmd9 = useOrbit((s) => s.settings.lastTabOnCmd9)
  const groups = sheetGroups(window.orbit.platform, { lastTabOnCmd9 })
  return (
    <table className="help__shortcuts" data-testid="guide-shortcuts">
      {groups.map((group) => (
        <tbody key={group.title}>
          <tr>
            <th colSpan={2} scope="colgroup">
              {group.title}
            </th>
          </tr>
          {group.rows.map((row) => (
            <tr key={row.title} data-testid="guide-shortcut">
              <td>{row.title}</td>
              <td>
                {row.keys ? <kbd className="help__kbd">{row.keys}</kbd> : <span className="help__none">None</span>}
              </td>
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  )
}

/**
 * `orbit://guide/`, Getting Started (OB-10): a short guide to Orbit, written for it and coming with
 * it. It covers the sidebar, Spaces, pinning, Favorites, Today and the Archive; the command bar,
 * split view, Peek and the Mini Window; and site controls. It ends with the essential shortcuts.
 */
function GuidePage() {
  useLiveKeys()
  const period = useArchivePeriod()
  return (
    <article className="help" data-testid="guide">
      <h1 className="internal__title">Getting started with Orbit</h1>
      <p className="help__lead">A short tour of the parts of Orbit you’ll use every day.</p>
      <ul className="help__contents" aria-label="Contents">
        {CONTENTS.map(([id, title]) => (
          <li key={id}>
            <a className="internal__link" href={`#${id}`}>
              {title}
            </a>
          </li>
        ))}
      </ul>

      <Section id="sidebar" title="The sidebar">
        <p>
          Everything you have open lives in the sidebar on the left: your Favorites at the top, then the pinned tabs of
          the Space you’re in, and below the line its Today tabs. Click a row to show its page; drag rows to sort them,
          or into folders among your pinned tabs.
        </p>
        <p>
          Hide it to give the page the whole window: Toggle Sidebar
          <K a="sidebar.toggle" />. While it’s hidden, point at the window’s left edge and it slides back over the page.
        </p>
      </Section>

      <Section id="spaces" title="Spaces">
        <p>
          A Space is a sidebar of its own for one part of your life: work, home, a project. Each has its own name,
          colours, pinned tabs and Today tabs, and can use a profile of its own, with its own sign-ins and history.
        </p>
        <p>
          Switch with the icons at the bottom of the sidebar, or Next Space
          <K a="space.next" /> and Previous Space
          <K a="space.previous" />. Make one with the + beside them, or New Space in the command bar.
        </p>
      </Section>

      <Section id="tabs" title="Pinned, Favorites and Today">
        <ul>
          <li>
            <strong>Today.</strong> A tab you open lands at the top of Today, below the line. Today tabs you haven’t
            used for {period} move to the Archive on their own, so the sidebar tidies itself. Clear
            <K a="tabs.clearToday" /> sends them all there now.
          </li>
          <li>
            <strong>The Archive.</strong> Nothing archived is lost: find it with View Archive in the command bar, or
            search for it there, and restore it. How long Today tabs wait is in{' '}
            <SettingsLink to={{ section: 'profiles' }}>Settings → Profiles</SettingsLink>.
          </li>
          <li>
            <strong>Pinned tabs.</strong> Pin a tab to keep it: Pin / Unpin Tab
            <K a="tab.togglePin" />, or drag it above the line. Pinned tabs are never archived. Closing one only puts it
            to sleep, and it opens again at the page you pinned.
          </li>
          <li>
            <strong>Favorites.</strong> The icons at the top: up to twelve sites you use all the time, the same in every
            Space of a profile. Drag a tab up there, or choose Favorite This Tab.
          </li>
        </ul>
      </Section>

      <Section id="command-bar" title="The command bar">
        <p>
          New Tab
          <K a="tab.new" /> opens the command bar. Type to search the web, go to an address, switch to a tab you have
          open, find something in the Archive, or run any of Orbit’s actions by name: try “split” or “archive”.
        </p>
        <p>
          Edit URL
          <K a="url.edit" /> opens it on the page you’re on, to change its address.
        </p>
      </Section>

      <Section id="split-view" title="Split view">
        <p>
          Put two to four pages side by side in one tab: New Split View
          <K a="split.add" />, or drag a tab from the sidebar onto the page. Close Split Pane
          <K a="split.close" /> closes the pane you’re in; the split stays one row in the sidebar.
        </p>
      </Section>

      <Section id="peek" title="Peek">
        <p>
          A link from a pinned tab or a Favorite to another site opens in Peek: a card over the page you’re on, which
          stays where it was. Shift-click opens any link in Peek. Esc closes it, and Open Peek as Tab
          <K a="peek.expand" /> keeps it as a tab.
        </p>
      </Section>

      <Section id="mini-window" title="Mini Window">
        <p>
          A link you open from another app opens in a Mini Window: a small window of its own, so a quick look doesn’t
          land in a Space. Read it and close it, or move it into a Space as a tab with Open in….
        </p>
        <p>
          New Mini Window
          <K a="window.newMini" /> opens a blank one for a quick lookup.
        </p>
      </Section>

      <Section id="sites" title="Site controls">
        <p>
          The button at the right of a page’s address shows what that site may do and what you chose for it: camera,
          microphone, location and other permissions, the devices it may use, its zoom and Picture in Picture. It also
          clears that site’s cookies and data.{' '}
          <SettingsLink to={{ section: 'site-settings' }}>Settings → Site settings</SettingsLink> lists every site with
          a choice of its own.
        </p>
      </Section>

      <Section id="shortcuts" title="Essential shortcuts">
        <ShortcutTable />
        <div className="help__actions">
          <HelpButton id="help.shortcuts" testId="guide-sheet">
            Show the shortcut sheet
          </HelpButton>
          <SettingsLink to={{ section: 'shortcuts' }} testId="guide-settings-shortcuts">
            All shortcuts, and changing them: Settings → Shortcuts
          </SettingsLink>
        </div>
      </Section>
    </article>
  )
}

export const page: InternalPage = {
  name: 'guide',
  title: 'Getting Started',
  description: 'A short guide to Orbit, and its essential shortcuts.',
  component: GuidePage,
}
