/**
 * KS-16: the keyboard moves only when the user asks.
 *
 * Electron hands a web contents the keyboard each time its page commits a navigation
 * (`focusOnNavigation`, on unless turned off). That holds for a page hidden behind another tab
 * and for one that never had the keyboard, so a slow page finishing its load took the keyboard
 * from the open command bar, from a field in the sidebar, or from the page being typed in, and
 * the keys after it went to that page. Every web contents Orbit makes for its windows (pages and
 * Orbit's own views) turns it off: Orbit gives a page the keyboard itself when the user selects,
 * opens or clicks it.
 */
export const KEEP_KEYBOARD = { focusOnNavigation: false } as const satisfies Electron.WebPreferences
