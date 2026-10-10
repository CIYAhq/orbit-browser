import { describe, expect, it } from 'vitest'
import { displayHost, parseInput, siteOf } from '../../src/shared/url'

describe('parseInput', () => {
  it.each([
    ['https://example.com/a?b=c', 'https://example.com/a?b=c'],
    ['example.com', 'https://example.com/'],
    ['www.wikipedia.org/wiki/Orbit', 'https://www.wikipedia.org/wiki/Orbit'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['localhost', 'http://localhost/'],
    ['127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'],
    ['192.168.1.1', 'http://192.168.1.1/'],
    ['about:blank', 'about:blank'],
    ['file:///tmp/a.html', 'file:///tmp/a.html'],
  ])('treats %s as a URL', (input, url) => {
    expect(parseInput(input)).toEqual({ kind: 'url', url })
  })

  it.each(['hello world', 'what is orbit', 'react hooks', 'foo', 'c++ tutorial'])('treats "%s" as a search', (q) => {
    const parsed = parseInput(q, 'duckduckgo')
    expect(parsed.kind).toBe('search')
    expect(parsed.url).toBe(`https://duckduckgo.com/?q=${encodeURIComponent(q).replace(/%20/g, '+')}`)
  })

  it('rejects unknown schemes as URLs', () => {
    expect(parseInput('javascript:alert(1)').kind).toBe('search')
  })
})

describe('displayHost / siteOf', () => {
  it('strips www and shows host', () => {
    expect(displayHost('https://www.github.com/orbit')).toBe('github.com')
    expect(displayHost('http://localhost:3000/x')).toBe('localhost:3000')
  })
  it('says what an address without a host is (review A-F2)', () => {
    expect(displayHost('view-source:http://localhost:3000/page/X')).toBe('view-source:localhost:3000')
    expect(displayHost('view-source:https://www.github.com/orbit')).toBe('view-source:github.com')
    expect(displayHost('blob:https://www.example.com/0b6c1d2e-5f00-4c1b-9a2e-3d4e5f607182')).toBe('example.com')
    expect(displayHost('data:text/html;charset=utf-8,<p>Hello</p>')).toBe('data:text/html')
    expect(displayHost('data:IMAGE/PNG;base64,iVBORw0KGgo=')).toBe('data:image/png')
    expect(displayHost('data:,Hello')).toBe('data:text/plain')
    expect(displayHost('about:blank')).toBe('about:blank')
    expect(displayHost('file:///tmp/a%20b.html')).toBe('a b.html')
    expect(displayHost('mailto:someone@example.com')).toBe('mailto:someone@example.com')
    expect(displayHost(`mailto:${'a'.repeat(60)}@example.com`)).toBe(`mailto:${'a'.repeat(32)}…`)
  })
  it('finds the registrable site', () => {
    expect(siteOf('https://mail.google.com/a')).toBe('google.com')
    expect(siteOf('https://news.bbc.co.uk/')).toBe('bbc.co.uk')
    expect(siteOf('http://localhost:3000')).toBe('localhost')
  })
})
