import { describe, expect, it } from 'vitest'
import { crashScreen, errorScreen, hangDialog, isCertError, screenSite, timeoutScreen } from '../../src/shared/pages'

describe('[NV-13] error screens: the site', () => {
  it('names a web page by its host and port, a file by its name, a page’s source by its page', () => {
    expect(screenSite('http://nonexistent.invalid/')).toBe('nonexistent.invalid')
    expect(screenSite('https://localhost:3341/a?b#c')).toBe('localhost:3341')
    expect(screenSite('file:///home/me/My%20notes.html')).toBe('My notes.html')
    expect(screenSite('view-source:https://example.com/x')).toBe('example.com')
  })

  it('names nothing it can’t read', () => {
    for (const url of ['', undefined, 'not a url', 'about:blank']) expect(screenSite(url)).toBe('')
  })
})

describe('[NV-13] error screens: what went wrong', () => {
  it('says each failure in one plain sentence, with the site, the engine’s name for it and Try again', () => {
    expect(errorScreen(-105, 'net::ERR_NAME_NOT_RESOLVED', 'http://nonexistent.invalid/')).toEqual({
      kind: 'error',
      title: 'This site can’t be reached',
      message: 'Orbit couldn’t find the server at this address.',
      site: 'nonexistent.invalid',
      code: 'ERR_NAME_NOT_RESOLVED',
      action: 'retry',
      actionLabel: 'Try again',
    })
    expect(errorScreen(-102, 'ERR_CONNECTION_REFUSED', 'http://localhost:3360/').message).toBe(
      'The server refused to connect.',
    )
    expect(errorScreen(-324, 'ERR_EMPTY_RESPONSE', 'http://a.test/')).toMatchObject({
      title: 'This page isn’t working',
      message: 'The server closed the connection without sending anything.',
    })
  })

  it('has a screen of its own for being offline', () => {
    expect(errorScreen(-106, 'ERR_INTERNET_DISCONNECTED', 'https://a.test/')).toMatchObject({
      kind: 'offline',
      title: 'No internet',
      message: 'Your device isn’t connected to the internet.',
      action: 'retry',
    })
  })

  it('says Orbit’s own time limit as Chromium says a timeout', () => {
    expect(timeoutScreen('http://localhost:3360/never')).toMatchObject({
      kind: 'error',
      message: 'The server took too long to respond.',
      site: 'localhost:3360',
      code: 'ERR_TIMED_OUT',
      action: 'retry',
    })
  })

  it('names a code it doesn’t know by number, and still offers Try again', () => {
    expect(errorScreen(-999, 'something odd', 'https://a.test/')).toMatchObject({
      message: 'Something went wrong while loading it.',
      code: 'ERR_999',
      action: 'retry',
    })
  })
})

describe('[NV-13] certificate screens', () => {
  it('knows Chromium’s certificate errors', () => {
    expect(isCertError(-200)).toBe(true)
    expect(isCertError(-202)).toBe(true)
    expect(isCertError(-299)).toBe(true)
    expect(isCertError(-300)).toBe(false)
    expect(isCertError(-105)).toBe(false)
  })

  it('leads with Back to safety, and keeps Proceed behind Advanced', () => {
    expect(errorScreen(-202, 'net::ERR_CERT_AUTHORITY_INVALID', 'https://localhost:3365/x')).toEqual({
      kind: 'cert',
      title: 'Your connection is not private',
      message:
        'Someone might be trying to steal your information from this site, such as passwords, messages or card numbers.',
      site: 'localhost:3365',
      code: 'ERR_CERT_AUTHORITY_INVALID',
      action: 'back',
      actionLabel: 'Back to safety',
      advanced: {
        text: 'The server couldn’t prove that it’s localhost:3365: its security certificate isn’t trusted by your device.',
        proceedLabel: 'Proceed to localhost:3365 (unsafe)',
      },
    })
    expect(errorScreen(-201, 'ERR_CERT_DATE_INVALID', 'https://a.test/').advanced?.text).toBe(
      'The server couldn’t prove that it’s a.test: its security certificate has expired or isn’t valid yet.',
    )
  })

  it('offers no way on past a revoked certificate', () => {
    const revoked = errorScreen(-206, 'ERR_CERT_REVOKED', 'https://a.test/')
    expect(revoked.action).toBe('back')
    expect(revoked.advanced?.proceedLabel).toBeUndefined()
  })
})

describe('[NV-14] crash screens and hung pages', () => {
  it('says the page crashed, with Reload', () => {
    expect(crashScreen('crashed', 'https://a.test/x')).toEqual({
      kind: 'crash',
      title: 'This page crashed',
      message: 'Something went wrong while showing it.',
      site: 'a.test',
      code: 'CRASHED',
      action: 'reload',
      actionLabel: 'Reload',
    })
    expect(crashScreen('oom', 'https://a.test/')).toMatchObject({ message: 'It ran out of memory.', code: 'OOM' })
    expect(crashScreen('killed', 'https://a.test/')).toMatchObject({ title: 'This page crashed', code: 'KILLED' })
    expect(crashScreen('memory-eviction', 'https://a.test/').code).toBe('MEMORY_EVICTION')
  })

  it('says a page closed from “Page unresponsive” was closed', () => {
    expect(crashScreen('hung', 'https://a.test/')).toMatchObject({
      title: 'This page was closed',
      message: 'It stopped responding, so Orbit closed it.',
      action: 'reload',
    })
  })

  it('“Page unresponsive” offers Wait (Enter and Esc) or Close page', () => {
    expect(hangDialog('https://a.test/x')).toEqual({
      kind: 'hang',
      title: 'Page unresponsive',
      message: 'a.test isn’t responding. You can wait for it, or close the page.',
      okLabel: 'Wait',
      cancelLabel: 'Close page',
      escapeAccepts: true,
    })
    expect(hangDialog(undefined).message).toBe('This page isn’t responding. You can wait for it, or close the page.')
  })
})
