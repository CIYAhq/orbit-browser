import type { InternalPage } from '../internal/registry'
import { HelpButton, K, Section, SettingsLink, useArchivePeriod, useLiveKeys } from './help-parts'

/**
 * `orbit://help/`, Orbit Help (OB-13): what Help opens (the Help menu, F1 on Windows and Linux, and
 * Help in the command bar). Orbit's own page, with the getting-started guide (OB-10), answers to
 * what puzzles people first, the shortcut sheet (OB-12), and Report a Bug: a draft on the project's
 * issue tracker with the build info filled in, which the user reads and sends themselves.
 */
function HelpPage() {
  useLiveKeys()
  const period = useArchivePeriod()
  return (
    <article className="help" data-testid="help">
      <h1 className="internal__title">Orbit Help</h1>
      <p className="help__lead">
        Orbit’s help comes with Orbit: these pages work offline, and nothing on them is sent anywhere.
      </p>

      <Section id="start" title="New to Orbit?">
        <p>
          <a className="internal__link" href="orbit://guide/" data-testid="help-guide">
            Getting started
          </a>{' '}
          walks through the sidebar, Spaces, the command bar, split view, Peek and the Mini Window, and ends with the
          shortcuts worth knowing.
        </p>
      </Section>

      <Section id="tabs" title="Where did my tabs go?">
        <p>
          Today tabs you haven’t used for {period} move to the Archive on their own. Find them there, or search for them
          in the command bar, and restore them. A tab you just closed comes back with Reopen Closed Tab
          <K a="tab.reopenClosed" />.
        </p>
        <div className="help__actions">
          <HelpButton id="app.archive" testId="help-archive">
            View Archive
          </HelpButton>
        </div>
      </Section>

      <Section id="sidebar" title="Where did the sidebar go?">
        <p>
          It’s hidden: Toggle Sidebar
          <K a="sidebar.toggle" /> brings it back. Point at the window’s left edge to see it for a moment.
        </p>
      </Section>

      <Section id="import" title="Can I bring my bookmarks along?">
        <p>
          Yes: bookmarks, history and more from the other browsers on this computer, or a bookmarks file.{' '}
          <SettingsLink to={{ section: 'general', item: 'import' }}>Settings → General → Import</SettingsLink>
        </p>
      </Section>

      <Section id="privacy" title="Does Orbit send what I do anywhere?">
        <p>
          No. Orbit has no account and no server of its own, and what you do in it stays on this computer.{' '}
          <SettingsLink to={{ section: 'privacy' }}>Settings → Privacy</SettingsLink> says what Orbit itself sends, and
          what you can turn on.
        </p>
      </Section>

      <Section id="updates" title="Is my Orbit up to date?">
        <p>
          <SettingsLink to={{ section: 'about' }}>Settings → About</SettingsLink> shows the version you have and checks
          for a newer one.
        </p>
      </Section>

      <Section id="keys" title="Keyboard shortcuts">
        <p>The essential ones on one sheet; all of them, and changing them, in Settings.</p>
        <div className="help__actions">
          <HelpButton id="help.shortcuts" testId="help-shortcuts">
            Show Keyboard Shortcuts
          </HelpButton>
          <SettingsLink to={{ section: 'shortcuts' }}>Settings → Shortcuts</SettingsLink>
        </div>
      </Section>

      <Section id="bug" title="Something wrong?">
        <p>
          Report a Bug opens a draft issue on Orbit’s issue tracker with this version’s details filled in. You say what
          happened, look it over, and send it yourself: nothing goes until you do.
        </p>
        <div className="help__actions">
          <HelpButton id="help.reportBug" testId="help-report-bug">
            Report a Bug
          </HelpButton>
          <HelpButton id="help.copyBuildInfo" testId="help-copy-build-info">
            Copy Build Info
          </HelpButton>
        </div>
        <p>
          <a className="internal__link" href="orbit://version/">
            The versions of Orbit, its engine and this computer’s system
          </a>
        </p>
      </Section>
    </article>
  )
}

export const page: InternalPage = {
  name: 'help',
  title: 'Orbit Help',
  description: 'Help with Orbit, the shortcut sheet, and reporting a bug.',
  component: HelpPage,
}
