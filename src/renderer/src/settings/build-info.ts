import { useEffect, useState } from 'react'
import type { BuildInfo } from '../../../shared/commands/settings'
import { invoke } from '../api'

/**
 * The build's details: version, build date, engine and system (ST-17, UP-07). They don't change
 * while Orbit runs, so Settings reads them once, before its first paint (boot.tsx): About and the
 * update line draw them in their first frame, with nothing filling in or moving a frame later.
 */
let info: BuildInfo | undefined
let reading: Promise<BuildInfo | undefined> | undefined

export function loadBuildInfo(): Promise<BuildInfo | undefined> {
  reading ??= invoke('settings.buildInfo', {}).then(
    (value) => {
      info = value
      return value
    },
    () => {
      // Asked again by the next page that needs them.
      reading = undefined
      return undefined
    },
  )
  return reading
}

/** The build's details: there from the first render once Settings has booted. */
export function useBuildInfo(): BuildInfo | undefined {
  const [value, setValue] = useState(info)
  useEffect(() => {
    if (value) return
    let live = true
    void loadBuildInfo().then((read) => {
      if (live && read) setValue(read)
    })
    return () => {
      live = false
    }
  }, [value])
  return value
}
