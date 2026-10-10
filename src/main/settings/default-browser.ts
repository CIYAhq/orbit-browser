import { app, shell } from 'electron'
import type { DefaultBrowserStatus } from '../../shared/commands/settings'

/** Orbit's registration as the OS default browser (ST-03, OB-07). */
export interface DefaultBrowser {
  status(): DefaultBrowserStatus
  /**
   * Asks the OS to make Orbit the default browser. macOS asks the user to confirm; Windows lets only
   * the user choose, so its default-apps settings open.
   */
  set(): Promise<DefaultBrowserStatus>
}

const SCHEMES = ['http', 'https'] as const

/** The real one. A development build never registers itself: that would make Electron the default browser. */
export function systemDefaultBrowser(): DefaultBrowser {
  const status = (): DefaultBrowserStatus => {
    if (!app.isPackaged) {
      return { isDefault: false, canSet: false, note: 'Only an installed copy of Orbit can be the default browser.' }
    }
    return { isDefault: SCHEMES.every((scheme) => app.isDefaultProtocolClient(scheme)), canSet: true }
  }
  return {
    status,
    async set() {
      if (!app.isPackaged) return status()
      for (const scheme of SCHEMES) app.setAsDefaultProtocolClient(scheme)
      if (process.platform === 'win32' && !status().isDefault) await shell.openExternal('ms-settings:defaultapps')
      return status()
    },
  }
}

/** For e2e runs (ORBIT_E2E=1): behaves like the real one and never touches the OS. */
export function stubDefaultBrowser(): DefaultBrowser {
  let isDefault = false
  return {
    status: () => ({ isDefault, canSet: true }),
    async set() {
      isDefault = true
      return { isDefault, canSet: true }
    },
  }
}
