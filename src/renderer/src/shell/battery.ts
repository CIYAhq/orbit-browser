import { useEffect } from 'react'
import { invoke } from '../api'

interface Battery extends EventTarget {
  level: number
  charging: boolean
}

/**
 * Tells main the battery's level and whether it charges, now and as they change: below 20 % on
 * battery power, the battery saver comes on (TB-16, `src/main/tabs/resources.ts`). Main has no
 * battery reading of its own; the page has the engine's.
 */
export function useBatteryReport(): void {
  useEffect(() => {
    const read = (navigator as Navigator & { getBattery?: () => Promise<Battery> }).getBattery
    if (!read) return
    let battery: Battery | undefined
    let gone = false
    const report = () => {
      if (battery) void invoke('tabs.battery', { level: battery.level, charging: battery.charging })
    }
    read
      .call(navigator)
      .then((b) => {
        if (gone) return
        battery = b
        b.addEventListener('levelchange', report)
        b.addEventListener('chargingchange', report)
        report()
      })
      .catch(() => {})
    return () => {
      gone = true
      battery?.removeEventListener('levelchange', report)
      battery?.removeEventListener('chargingchange', report)
    }
  }, [])
}
