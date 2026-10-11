import { describe, expect, it } from 'vitest'
import { gnomeAccelerator, gnomeClashes, missionControlClashes } from '../../src/main/keys/system'

/**
 * Keys the operating system keeps (KS-03, ST-08): what Settings → Shortcuts reads from macOS's
 * Mission Control settings and GNOME's window manager keys.
 */

/** One entry as `defaults read com.apple.symbolichotkeys AppleSymbolicHotKeys` prints it. */
const entry = (id: number, enabled: number, key: number, mask: number) => `    ${id} =     {
        enabled = ${enabled};
        value =         {
            parameters =             (
                65535,
                ${key},
                ${mask}
            );
            type = standard;
        };
    };`

describe('[KS-03][ST-08] Mission Control desktop keys', () => {
  it('reads the Switch to Desktop keys that are turned on', () => {
    const plist = [
      '{',
      entry(32, 1, 126, 8650752), // Mission Control itself: not a desktop key
      entry(118, 1, 18, 262144), // Desktop 1: ⌃1
      entry(119, 1, 19, 262144), // Desktop 2: ⌃2
      entry(120, 0, 20, 262144), // Desktop 3: turned off
      entry(121, 1, 21, 262144 + 131072), // Desktop 4: ⌃⇧4
      entry(126, 1, 25, 524288), // Desktop 9: ⌥9
      '}',
    ].join('\n')
    expect(missionControlClashes(plist)).toEqual([
      { accel: 'Ctrl+1', owner: 'Mission Control: Switch to Desktop 1' },
      { accel: 'Ctrl+2', owner: 'Mission Control: Switch to Desktop 2' },
      { accel: 'Ctrl+Shift+4', owner: 'Mission Control: Switch to Desktop 4' },
      { accel: 'Alt+9', owner: 'Mission Control: Switch to Desktop 9' },
    ])
  })

  it('reads nothing from an empty or unreadable answer', () => {
    expect(missionControlClashes('')).toEqual([])
    expect(missionControlClashes('The domain/default pair does not exist')).toEqual([])
  })
})

describe('[KS-03][ST-08] GNOME workspace keys', () => {
  it('turns GNOME accelerators into bindings Orbit could have had', () => {
    expect(gnomeAccelerator('<Control><Alt>Left')).toBe('Ctrl+Alt+Left')
    expect(gnomeAccelerator('<Primary><Alt>Page_Down')).toBe('Ctrl+Alt+PageDown')
    expect(gnomeAccelerator('<Shift><Control><Alt>Right')).toBe('Ctrl+Alt+Shift+Right')
    // Super is a key Orbit never binds; a bare key isn't a shortcut.
    expect(gnomeAccelerator('<Super>Page_Up')).toBeUndefined()
    expect(gnomeAccelerator('Left')).toBeUndefined()
  })

  it('lists every workspace key gsettings reports, with what it does', () => {
    expect(
      gnomeClashes({
        'switch-to-workspace-left': "['<Super>Page_Up', '<Control><Alt>Left']\n",
        'switch-to-workspace-right': "['<Super>Page_Down', '<Control><Alt>Right']\n",
        'move-to-workspace-left': '@as []\n',
      }),
    ).toEqual([
      { accel: 'Ctrl+Alt+Left', owner: 'GNOME: Switch to workspace on the left' },
      { accel: 'Ctrl+Alt+Right', owner: 'GNOME: Switch to workspace on the right' },
    ])
  })
})
