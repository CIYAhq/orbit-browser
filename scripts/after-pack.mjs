import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * electron-builder's afterPack hook (electron-builder.yml): a packaged Orbit must have Chromium's
 * licences, which its credits page links to (ST-17). electron-builder only logs a missing
 * extraResources source, so a Mac build whose Electron lacks the file (installed with
 * --ignore-scripts, say) would otherwise ship without it.
 */

/** Where a packaged Orbit keeps LICENSES.chromium.html: in Resources on a Mac, beside the program elsewhere. */
export function chromiumLicencesIn({ appOutDir, electronPlatformName, packager }) {
  return electronPlatformName === 'darwin' || electronPlatformName === 'mas'
    ? join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'LICENSES.chromium.html')
    : join(appOutDir, 'LICENSES.chromium.html')
}

export default async function afterPack(context) {
  const file = chromiumLicencesIn(context)
  if (!existsSync(file))
    throw new Error(`The packaged app has no ${file}: Orbit's credits page links to Chromium's licences there (ST-17).`)
}
