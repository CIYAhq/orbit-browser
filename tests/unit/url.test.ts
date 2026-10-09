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
    expect(parsed.url).toBe(`https://duckduckgo.com/?q=${encodeURIComponent(q)}`)
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
  it('finds the registrable site', () => {
    expect(siteOf('https://mail.google.com/a')).toBe('google.com')
    expect(siteOf('https://news.bbc.co.uk/')).toBe('bbc.co.uk')
    expect(siteOf('http://localhost:3000')).toBe('localhost')
  })
})
