import { describe, expect, it } from 'vitest'
import { connectionOf, LINK_PILL_MAX_URL, linkPillText } from '../../src/shared/nav'

describe('connectionOf (SB-04)', () => {
  it('treats https as secure: no padlock, no warning', () => {
    expect(connectionOf('https://example.com/a?b=1')).toBe('secure')
    expect(connectionOf('wss://example.com/socket')).toBe('secure')
  })

  it('warns for plain http to another machine', () => {
    expect(connectionOf('http://example.com/')).toBe('insecure')
    expect(connectionOf('http://192.168.1.20:8080/')).toBe('insecure')
    expect(connectionOf('http://insecure.test:3340/page/A')).toBe('insecure')
    expect(connectionOf('http://localhost.example.com/')).toBe('insecure')
  })

  it('does not warn for http to this machine', () => {
    expect(connectionOf('http://localhost:3300/')).toBe('local')
    expect(connectionOf('http://LOCALHOST/')).toBe('local')
    expect(connectionOf('http://app.localhost:5173/')).toBe('local')
    expect(connectionOf('http://127.0.0.1:8080/x')).toBe('local')
    expect(connectionOf('http://127.10.0.3/')).toBe('local')
    expect(connectionOf('http://[::1]:3000/')).toBe('local')
  })

  it('reads through view-source to the page underneath', () => {
    expect(connectionOf('view-source:https://example.com/')).toBe('secure')
    expect(connectionOf('view-source:http://example.com/')).toBe('insecure')
  })

  it('classifies files, internal pages and nothing', () => {
    expect(connectionOf('file:///home/me/notes.html')).toBe('file')
    expect(connectionOf('about:blank')).toBe('internal')
    expect(connectionOf('data:text/html,hi')).toBe('internal')
    expect(connectionOf('chrome://gpu')).toBe('internal')
    expect(connectionOf('')).toBe('none')
    expect(connectionOf(undefined)).toBe('none')
    expect(connectionOf('not a url')).toBe('none')
  })
})

describe('linkPillText (SB-27)', () => {
  it('shows a web link without its scheme, and the whole URL once expanded', () => {
    expect(linkPillText('https://example.com/docs/page?q=1#top', false)).toBe('example.com/docs/page?q=1#top')
    expect(linkPillText('http://localhost:3330/page/A', false)).toBe('localhost:3330/page/A')
    expect(linkPillText('https://example.com/docs/page?q=1#top', true)).toBe('https://example.com/docs/page?q=1#top')
  })

  it('drops the lone slash of a bare host', () => {
    expect(linkPillText('https://example.com/', false)).toBe('example.com')
    expect(linkPillText('https://example.com/?q=1', false)).toBe('example.com/?q=1')
  })

  it('leaves other schemes, escapes and punycode as they are', () => {
    expect(linkPillText('mailto:someone@example.com', false)).toBe('mailto:someone@example.com')
    expect(linkPillText('javascript:void(0)', false)).toBe('javascript:void(0)')
    expect(linkPillText('https://xn--bcher-kva.example/%E2%80%AE', false)).toBe('xn--bcher-kva.example/%E2%80%AE')
    // Credentials in a link are not shown in the short form.
    expect(linkPillText('https://user:secret@example.com/a', false)).toBe('example.com/a')
  })

  it('cuts very long addresses short', () => {
    const long = `data:text/plain,${'x'.repeat(LINK_PILL_MAX_URL * 2)}`
    expect(linkPillText(long, true)).toHaveLength(LINK_PILL_MAX_URL + 1)
    expect(linkPillText(long, false).endsWith('…')).toBe(true)
  })
})
