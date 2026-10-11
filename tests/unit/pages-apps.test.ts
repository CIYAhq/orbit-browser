import { describe, expect, it } from 'vitest'
import { appDialog, appName, appScheme, launchableUrl, noAppMessage } from '../../src/shared/pages'

describe('[NV-19] links that open other apps', () => {
  it('knows a link to another app by its scheme', () => {
    expect(appScheme('mailto:someone@example.com')).toBe('mailto')
    expect(appScheme('MAILTO:someone@example.com')).toBe('mailto')
    expect(appScheme('tel:+15550100')).toBe('tel')
    expect(appScheme('zoommtg://join?confno=123')).toBe('zoommtg')
    expect(appScheme('ms-teams:/l/meetup-join')).toBe('ms-teams')
  })

  it('never hands the OS a web address, a local file, a script or a scheme Chromium refuses', () => {
    for (const url of [
      'https://example.com/',
      'http://localhost:3341/',
      'file:///etc/hosts',
      'about:blank',
      'data:text/html,hi',
      'blob:https://example.com/x',
      'javascript:alert(1)',
      'view-source:https://example.com/',
      'orbit://history',
      'chrome://gpu',
      'devtools://devtools/bundled/inspector.html',
      'shell:startup',
      'vbscript:msgbox',
      'ms-msdt:/id',
      'search-ms:query=x',
      'hcp://system',
      '',
      'not a link',
    ]) {
      expect(appScheme(url), url).toBe('')
    }
    expect(appScheme(undefined)).toBe('')
  })

  it('names a Linux desktop entry as its app, and leaves other systems’ names as they are', () => {
    expect(appName('thunderbird.desktop', 'linux')).toBe('Thunderbird')
    expect(appName('org.gnome.Evolution.desktop', 'linux')).toBe('Evolution')
    expect(appName('mozilla-thunderbird.desktop', 'linux')).toBe('Mozilla Thunderbird')
    expect(appName('org.kde.kmail2.desktop', 'linux')).toBe('Kmail2')
    expect(appName('Zoom.desktop', 'linux')).toBe('Zoom')
    expect(appName('', 'linux')).toBe('')
    expect(appName('zoom.us', 'darwin')).toBe('zoom.us')
    expect(appName(' Mail ', 'win32')).toBe('Mail')
  })

  it('escapes what an app’s handler could take for more than one argument, as Chromium does', () => {
    expect(launchableUrl('mailto:a@b.c?subject=Hi there"x"')).toBe('mailto:a@b.c?subject=Hi%20there%22x%22')
    expect(launchableUrl('app:<a>\\b^c`d{e|f}g')).toBe('app:%3Ca%3E%5Cb%5Ec%60d%7Be%7Cf%7Dg')
    expect(launchableUrl('tel:+1\n555\t0100')).toBe('tel:+1%0A555%090100')
    expect(launchableUrl('mailto:a@b.c?subject=Hello%20there')).toBe('mailto:a@b.c?subject=Hello%20there')
  })

  it('asks “Open Mail?” naming the site, with its icon and Always allow; Cancel is the default', () => {
    expect(appDialog({ name: 'Mail', icon: 'data:image/png;base64,AA==' }, 'https://example.com')).toEqual({
      kind: 'app',
      title: 'Open Mail?',
      message: 'example.com wants to open this application.',
      icon: 'data:image/png;base64,AA==',
      check: 'Always allow example.com to open links of this type in the associated app',
      okLabel: 'Open Mail',
      defaultCancel: true,
    })
    expect(appDialog({ name: 'Zoom' }, 'http://localhost:3341').check).toBe(
      'Always allow localhost:3341 to open links of this type in the associated app',
    )
  })

  it('names no app the OS can’t name', () => {
    expect(appDialog(undefined, 'https://example.com')).toMatchObject({
      title: 'Open this link in another app?',
      message: 'example.com wants to open a link in another app.',
      okLabel: 'Open link',
    })
  })

  it('offers Always allow to a web site only', () => {
    const file = appDialog({ name: 'Mail' }, 'file://')
    expect(file.message).toBe('This file wants to open this application.')
    expect(file.check).toBeUndefined()
    const unnamed = appDialog({ name: 'Mail' }, null)
    expect(unnamed.message).toBe('A website wants to open this application.')
    expect(unnamed.check).toBeUndefined()
  })

  it('says so when no app opens a kind of link', () => {
    expect(noAppMessage('zoommtg')).toBe('No app on this device opens zoommtg: links')
  })
})
