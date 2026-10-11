import { describe, expect, it } from 'vitest'
import { carriesLink, droppedLink } from '../../src/shared/link-drop'

describe('a link dropped onto a pane (SV-08)', () => {
  it('opens the first web address of the URI list', () => {
    expect(droppedLink('https://example.com/a')).toBe('https://example.com/a')
    expect(droppedLink('# a comment\r\nhttp://example.com/b\r\nhttps://example.com/c')).toBe('http://example.com/b')
    expect(droppedLink('  https://example.com/x y  ')).toBe('https://example.com/x%20y')
  })

  it('opens nothing for a local file, an internal page, a script or no address (D49, D53)', () => {
    expect(droppedLink('file:///etc/passwd')).toBeNull()
    expect(droppedLink('orbit://settings')).toBeNull()
    expect(droppedLink('javascript:alert(1)')).toBeNull()
    expect(droppedLink('data:text/html,hi')).toBeNull()
    expect(droppedLink('not a url')).toBeNull()
    expect(droppedLink('# only a comment')).toBeNull()
    expect(droppedLink('')).toBeNull()
  })

  it('treats a drag with a URI list as a link, unless it carries files', () => {
    expect(carriesLink(['text/uri-list', 'text/plain'])).toBe(true)
    expect(carriesLink(['text/plain'])).toBe(false)
    expect(carriesLink(['Files', 'text/uri-list'])).toBe(false)
  })
})
