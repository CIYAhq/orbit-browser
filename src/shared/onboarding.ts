/**
 * First-run onboarding (OB-*), shared by main and the onboarding view: its steps, and the web apps
 * it offers as Favorites. Every step can be skipped; none asks for an account (OB-02).
 */

import { MAX_FAVORITES } from './defaults'

/** The steps, in order. Import shows a placeholder until the import lane provides `import.open`. */
export const ONBOARDING_STEPS = ['welcome', 'import', 'theme', 'favorites', 'browser', 'done'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(value)
}

/** A web app the Favorites step offers (OB-05). Tiles show its initial, not its logo. */
export interface StarterApp {
  id: string
  name: string
  url: string
}

/** Popular web apps, in the order the grid shows them. Nothing is picked for the user. */
export const STARTER_APPS: readonly StarterApp[] = [
  { id: 'gmail', name: 'Gmail', url: 'https://mail.google.com/' },
  { id: 'calendar', name: 'Google Calendar', url: 'https://calendar.google.com/' },
  { id: 'drive', name: 'Google Drive', url: 'https://drive.google.com/' },
  { id: 'outlook', name: 'Outlook', url: 'https://outlook.live.com/' },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/' },
  { id: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/' },
  { id: 'notion', name: 'Notion', url: 'https://www.notion.so/' },
  { id: 'figma', name: 'Figma', url: 'https://www.figma.com/' },
  { id: 'github', name: 'GitHub', url: 'https://github.com/' },
  { id: 'linear', name: 'Linear', url: 'https://linear.app/' },
  { id: 'slack', name: 'Slack', url: 'https://app.slack.com/' },
  { id: 'discord', name: 'Discord', url: 'https://discord.com/app' },
  { id: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com/' },
  { id: 'x', name: 'X', url: 'https://x.com/' },
  { id: 'reddit', name: 'Reddit', url: 'https://www.reddit.com/' },
  { id: 'wikipedia', name: 'Wikipedia', url: 'https://www.wikipedia.org/' },
]

/** The apps to add as Favorites for a list of STARTER_APPS ids: known ones, once each, at most MAX_FAVORITES. */
export function chosenApps(ids: unknown): StarterApp[] {
  if (!Array.isArray(ids)) return []
  const picked: StarterApp[] = []
  for (const id of ids) {
    const found = STARTER_APPS.find((a) => a.id === id)
    if (found && !picked.includes(found)) picked.push(found)
    if (picked.length === MAX_FAVORITES) break
  }
  return picked
}

/** What the onboarding view needs to start (OB-01, OB-14). */
export interface OnboardingInfo {
  /** The step to show: where a quit left off, else the welcome. */
  step: OnboardingStep
  /** The Space whose theme the theme step sets: the first one. */
  spaceId: string | undefined
  /** Whether the import lane's flow exists (`import.open`). */
  importer: boolean
  /** A browser window is open already (Reset onboarding): finishing returns to it. */
  returning: boolean
}
