import { describe, expect, it } from 'vitest'
import { carriesLink, droppedLink, sidebarDropUrl } from '../../src/shared/link-drop'
import { searchUrl } from '../../src/shared/url'

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

describe('what a drag from a page opens on the sidebar (D87)', () => {
  const search = (text: string) => searchUrl('google', text)

  it('a web address, as its link or its text, wherever it is dropped', () => {
    for (const place of ['list', 'folder', 'favorites'] as const) {
      expect(sidebarDropUrl('https://example.com/a', 'other words', 'google', place)).toBe('https://example.com/a')
      expect(sidebarDropUrl('', 'http://example.com/b', 'google', place)).toBe('http://example.com/b')
      expect(sidebarDropUrl('', 'example.com', 'google', place)).toBe('https://example.com/')
    }
  })

  it('text that is no address: a search on the list or in a folder, nothing on the Favorites', () => {
    expect(sidebarDropUrl('', 'dropped words', 'google', 'list')).toBe(search('dropped words'))
    expect(sidebarDropUrl('', '  dropped words  ', 'google', 'folder')).toBe(search('dropped words'))
    expect(sidebarDropUrl('', 'dropped words', 'google', 'favorites')).toBeNull()
    expect(sidebarDropUrl('', '   ', 'google', 'list')).toBeNull()
  })

  it('any other address opens nothing, as a link or as text, wherever it is dropped (D49, D53)', () => {
    const others = [
      'data:text/html,<h1>hi</h1>',
      'data:text/plain,two words',
      'view-source:https://example.com/',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'about:blank',
      'javascript:alert(1)',
      'javascript: alert(document.cookie)',
      'file:///etc/passwd',
      'orbit://settings',
      'blob:https://example.com/0f0e',
    ]
    for (const place of ['list', 'folder', 'favorites'] as const) {
      for (const address of others) {
        expect(sidebarDropUrl(address, address, 'google', place), `${address} as a link`).toBeNull()
        expect(sidebarDropUrl('', address, 'google', place), `${address} as text`).toBeNull()
      }
    }
  })

  it('a link list that names another scheme opens nothing, whatever text comes with it', () => {
    expect(sidebarDropUrl('data:text/html,hi', 'https://example.com/', 'google', 'list')).toBeNull()
    expect(sidebarDropUrl('# a comment\nfile:///etc/passwd', 'words', 'google', 'list')).toBeNull()
  })
})
