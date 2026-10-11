import { describe, expect, it } from 'vitest'
import {
  authDialog,
  DIALOG_TEXT_MAX,
  dialogText,
  dialogTitle,
  leaveDialog,
  scriptAnswer,
  scriptDialog,
} from '../../src/shared/pages'

describe('[NV-24] page dialogs: who asks', () => {
  it('names a web page by its host and port', () => {
    expect(dialogTitle('http://localhost:3341/ask')).toBe('localhost:3341 says')
    expect(dialogTitle('https://example.com/a?b')).toBe('example.com says')
    expect(dialogTitle('https://[::1]:8443/')).toBe('[::1]:8443 says')
  })

  it('names a blob: page by the page that made it', () => {
    expect(dialogTitle('blob:https://example.com/5f0c0d2e-1111-2222-3333-444455556666')).toBe('example.com says')
  })

  it('says "This page says" for anything else', () => {
    for (const url of ['file:///home/me/a.html', 'data:text/html,hi', 'about:blank', '', undefined, 'not a url']) {
      expect(dialogTitle(url)).toBe('This page says')
    }
  })

  it('names the site of an origin: an about:blank page’s is its opener’s', () => {
    expect(dialogTitle('http://localhost:3341')).toBe('localhost:3341 says')
    expect(dialogTitle('https://example.com')).toBe('example.com says')
    // An opaque origin (a data: page, a sandboxed one) or a file's names no site.
    for (const origin of ['null', 'file://']) expect(dialogTitle(origin)).toBe('This page says')
  })
})

describe('[NV-24] page dialogs: the page’s alert, confirm and prompt', () => {
  it('alert has one button, confirm two, prompt a field with the page’s text', () => {
    expect(scriptDialog('alert', 'https://a.test/', 'Saved', '')).toEqual({
      kind: 'alert',
      title: 'a.test says',
      message: 'Saved',
      okLabel: 'OK',
      noCancel: true,
    })
    expect(scriptDialog('confirm', 'https://a.test/', 'Sure?', '')).toEqual({
      kind: 'confirm',
      title: 'a.test says',
      message: 'Sure?',
      okLabel: 'OK',
    })
    expect(scriptDialog('prompt', 'https://a.test/', 'Name', 'Ada')).toMatchObject({ kind: 'prompt', value: 'Ada' })
  })

  it('cuts a very long text', () => {
    const long = 'x'.repeat(DIALOG_TEXT_MAX + 5)
    expect(dialogText(long)).toBe(`${'x'.repeat(DIALOG_TEXT_MAX)}…`)
    expect(dialogText('short')).toBe('short')
    expect(scriptDialog('prompt', undefined, long, long).value?.length).toBe(DIALOG_TEXT_MAX + 1)
  })

  it('gives the page what Chromium’s calls return', () => {
    expect(scriptAnswer('alert', { id: 1, ok: true })).toBeUndefined()
    expect(scriptAnswer('alert', null)).toBeUndefined()
    expect(scriptAnswer('confirm', { id: 1, ok: true })).toBe(true)
    expect(scriptAnswer('confirm', { id: 1, ok: false })).toBe(false)
    // The dialog went away (its page navigated, the tab closed): Cancel.
    expect(scriptAnswer('confirm', null)).toBe(false)
    expect(scriptAnswer('prompt', { id: 1, ok: true, value: 'typed' })).toBe('typed')
    expect(scriptAnswer('prompt', { id: 1, ok: true })).toBe('')
    expect(scriptAnswer('prompt', { id: 1, ok: false, value: 'typed' })).toBeNull()
    expect(scriptAnswer('prompt', null)).toBeNull()
  })
})

describe('[NV-24] page dialogs: leaving and signing in', () => {
  it('"Leave site?" and, for a reload, "Reload site?"', () => {
    expect(leaveDialog(false)).toEqual({
      kind: 'leave',
      title: 'Leave site?',
      message: 'Changes you made may not be saved.',
      okLabel: 'Leave',
    })
    expect(leaveDialog(true)).toMatchObject({ kind: 'reload', title: 'Reload site?', okLabel: 'Reload' })
  })

  it('names the server or proxy asking, and says when the connection isn’t private', () => {
    const server = { isProxy: false, scheme: 'basic', host: 'intranet.test', port: 80, realm: 'Staff' }
    expect(authDialog(server, 'http://intranet.test/wiki')).toEqual({
      kind: 'auth',
      title: 'Sign in',
      message: 'http://intranet.test requires a username and password.',
      note: 'Your connection to this site is not private.',
      okLabel: 'Sign in',
    })
    const secure = authDialog({ ...server, port: 8443 }, 'https://intranet.test:8443/wiki')
    expect(secure.message).toBe('https://intranet.test:8443 requires a username and password.')
    expect(secure.note).toBeUndefined()
    const proxy = authDialog({ ...server, isProxy: true, host: 'proxy.test', port: 3128 }, 'http://site.test/')
    expect(proxy.message).toBe('The proxy proxy.test:3128 requires a username and password.')
    expect(proxy.note).toBeUndefined()
    // No address to go by: not private.
    expect(authDialog(server, undefined).note).toBe('Your connection to this site is not private.')
  })
})
