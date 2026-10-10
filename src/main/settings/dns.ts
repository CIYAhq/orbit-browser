import type { ClearDataRange } from '../../shared/commands/settings'
import type { SecureDnsChoice } from '../../shared/state'

/**
 * DNS-over-HTTPS servers Settings offers (ST-12), as RFC 8484 templates. Orbit only talks to one
 * after the user picks it.
 */
export const DOH_SERVERS: Record<Exclude<SecureDnsChoice, 'automatic' | 'off'>, string> = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/dns-query{?dns}',
  quad9: 'https://dns.quad9.net/dns-query',
}

/** The host resolver options for a Secure DNS choice (`app.configureHostResolver`). */
export function hostResolverConfig(
  choice: SecureDnsChoice,
  platform: NodeJS.Platform,
): Electron.ConfigureHostResolverOptions {
  // The engine's own default for the built-in resolver: on for macOS only.
  const base = { enableBuiltInResolver: platform === 'darwin' }
  if (choice === 'off') return { ...base, secureDnsMode: 'off' }
  if (choice === 'automatic') return { ...base, secureDnsMode: 'automatic' }
  return { ...base, secureDnsMode: 'secure', secureDnsServers: [DOH_SERVERS[choice]] }
}

const HOUR = 60 * 60 * 1000
const RANGE_MS: Record<Exclude<ClearDataRange, 'all'>, number> = {
  hour: HOUR,
  day: 24 * HOUR,
  week: 7 * 24 * HOUR,
  month: 28 * 24 * HOUR,
}

/** Where a Clear browsing data range starts; undefined for all time (or an unknown range). */
export function clearRangeStart(range: ClearDataRange, now: number): number | undefined {
  return range !== 'all' && Object.hasOwn(RANGE_MS, range) ? now - RANGE_MS[range] : undefined
}

export function isClearRange(value: unknown): value is ClearDataRange {
  return value === 'all' || (typeof value === 'string' && Object.hasOwn(RANGE_MS, value))
}
