import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { importPlaces, PLACES_ENV, parsePlaces, standardPlaces } from '../../src/main/import/places'

const HOME = '/home/someone'

describe('[IM-02] where Orbit looks for other browsers', () => {
  it('looks only at fixture places when a test sets them', () => {
    const refuse = vi.fn()
    const env = { [PLACES_ENV]: JSON.stringify([{ browser: 'chrome', dir: 'tests/fixtures/import/chrome' }]) }
    expect(importPlaces(true, env, 'linux', HOME, refuse)).toEqual([
      { browser: 'chrome', dir: resolve('tests/fixtures/import/chrome') },
    ])
    expect(importPlaces(true, { [PLACES_ENV]: '[]' }, 'linux', HOME, refuse)).toEqual([])
    expect(refuse).not.toHaveBeenCalled()
  })

  it('in a test run without fixture places, looks nowhere and reports the mistake', () => {
    const refuse = vi.fn()
    expect(importPlaces(true, {}, 'linux', HOME, refuse)).toEqual([])
    expect(refuse).toHaveBeenCalledOnce()
    expect(refuse.mock.calls[0]?.[0]).toContain(PLACES_ENV)
  })

  it('outside tests, lists each OS’s usual folders (paths only)', () => {
    const linux = importPlaces(false, {}, 'linux', HOME, vi.fn())
    expect(linux).toContainEqual({ browser: 'chrome', dir: '/home/someone/.config/google-chrome' })
    expect(linux).toContainEqual({ browser: 'firefox', dir: '/home/someone/.mozilla/firefox' })
    expect(linux.some((p) => p.browser === 'safari')).toBe(false)
    expect(standardPlaces('linux', HOME, { XDG_CONFIG_HOME: '/cfg' })).toContainEqual({
      browser: 'brave',
      dir: '/cfg/BraveSoftware/Brave-Browser',
    })
    const mac = standardPlaces('darwin', HOME, {})
    expect(mac).toContainEqual({ browser: 'safari', dir: '/home/someone/Library/Safari' })
    expect(mac).toContainEqual({ browser: 'chrome', dir: '/home/someone/Library/Application Support/Google/Chrome' })
    const win = standardPlaces('win32', HOME, { LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' })
    expect(win.map((p) => p.browser)).toEqual([
      'chrome',
      'chromium',
      'brave',
      'edge',
      'vivaldi',
      'opera',
      'opera-gx',
      'firefox',
    ])
  })

  it('reads fixture places strictly', () => {
    expect(() => parsePlaces('not json')).toThrow(PLACES_ENV)
    expect(() => parsePlaces('{}')).toThrow(PLACES_ENV)
    expect(parsePlaces(JSON.stringify([{ browser: 'netscape', dir: '/x' }, { browser: 'firefox' }, null]))).toEqual([])
  })
})
