/**
 * Orbit's project pages. Orbit has no servers or accounts of its own (OB-02, ST-12): Report a Bug
 * opens a draft issue on the project's GitHub repository, which the user sends themselves, and
 * Release notes and What's New open its releases. It is private for now, so these pages need access
 * to it. Help and the getting-started guide are Orbit's own pages, and the licence and open-source
 * credits come with the app too (credits.html, built by scripts/credits.ts; D43).
 */
export const PROJECT_URL = 'https://github.com/CIYAhq/orbit-browser'
export const RELEASES_URL = `${PROJECT_URL}/releases`
export const ISSUES_URL = `${PROJECT_URL}/issues`

/**
 * Orbit's own help (OB-10, OB-13): internal pages (DT-13) that come with the app, so they open
 * offline and send nothing anywhere. The first window has the guide and help in its "Orbit basics"
 * folder and the welcome page in Today (OB-09).
 */
export const HELP_URL = 'orbit://help/'
export const GUIDE_URL = 'orbit://guide/'
export const WELCOME_URL = 'orbit://welcome/'
