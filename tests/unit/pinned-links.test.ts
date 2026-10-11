import { describe, expect, it } from 'vitest'
import { decideLink, type LinkSettings, type LinkSource } from '../../src/shared/link-routing'

/** Links clicked inside pinned tabs and Favorites (PN-05): where each opens, with each setting. */

const on: LinkSettings = { peekExternalLinks: true, peekShiftClick: true, linkRules: [] }
const sources: Record<string, LinkSource> = {
  pinned: { kind: 'tab', section: 'pinned', url: 'https://mail.example.com/inbox' },
  favorite: { kind: 'tab', section: 'favorite', url: 'https://app.example.com/' },
}

describe('[PN-05] links in pinned tabs and Favorites', () => {
  for (const [name, source] of Object.entries(sources)) {
    it(`${name}: the same site navigates in it; another site opens a preview, or a Today tab with previews off`, () => {
      expect(decideLink('navigate', source, 'https://docs.example.com/page', on)).toEqual({ to: 'default' })
      expect(decideLink('navigate', source, 'https://other.org/page', on)).toEqual({ to: 'peek' })
      const off = { ...on, peekExternalLinks: false }
      expect(decideLink('navigate', source, 'https://other.org/page', off)).toEqual({ to: 'tab' })
      expect(decideLink('navigate', source, 'https://docs.example.com/page', off)).toEqual({ to: 'default' })
    })

    it(`${name}: Shift-click previews any link under its own setting, whatever the other`, () => {
      const previewsOff = { ...on, peekExternalLinks: false }
      expect(decideLink('shift', source, 'https://docs.example.com/page', previewsOff)).toEqual({ to: 'peek' })
      expect(decideLink('shift', source, 'https://other.org/page', previewsOff)).toEqual({ to: 'peek' })
      const shiftOff = { ...on, peekShiftClick: false }
      expect(decideLink('shift', source, 'https://docs.example.com/page', shiftOff)).toEqual({ to: 'default' })
      expect(decideLink('navigate', source, 'https://other.org/page', shiftOff)).toEqual({ to: 'peek' })
    })

    it(`${name}: a meeting link opens a new tab, never a preview`, () => {
      expect(decideLink('navigate', source, 'https://meet.google.com/abc-defg-hij', on)).toEqual({ to: 'tab' })
      expect(decideLink('shift', source, 'https://meet.google.com/abc-defg-hij', on)).toEqual({ to: 'tab' })
    })
  }
})
