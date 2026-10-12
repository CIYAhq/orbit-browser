/** The part of electron-builder's AfterPackContext the hook reads. */
export interface PackedApp {
  appOutDir: string
  electronPlatformName: string
  packager: { appInfo: { productFilename: string } }
}

export function chromiumLicencesIn(context: PackedApp): string
export default function afterPack(context: PackedApp): Promise<void>
