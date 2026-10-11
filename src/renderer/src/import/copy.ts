/**
 * Words for people moving from a browser that isn't in the import's list, so Orbit can't read its
 * files (IM-12, OB-03): the help heading, its routes, and the default name of a pasted folder. They
 * describe the routes in general terms and name no browser: Orbit's UI never names the one the spec
 * has in mind here (the clean-room rule, D57).
 */
export const MOVING_HEADING = 'Browser not listed?'
export const PASTE_DEFAULT_NAME = 'Imported links'
export const MOVING_INTRO =
  'Bring your things over through what that browser lets you copy or export yourself. Orbit never reads its files:'

export const MOVING_ROUTES: { title: string; text: string }[] = [
  {
    title: 'Pinned tabs and folders',
    text: 'Copy the links of a folder or of the tabs you select there. Then choose Paste a list of links here, or click an empty part of Orbit’s pinned section and paste.',
  },
  {
    title: 'Bookmarks',
    text: 'Export them there as a bookmarks file (.html). Import it with From a file, or drop it on this window or on the sidebar.',
  },
  {
    title: 'Notes',
    text: 'Keep an export of your notes: Orbit’s notes can’t take them in yet.',
  },
  {
    title: 'Canvases',
    text: 'Keep them as images, or drop the images onto a page that takes pictures.',
  },
  {
    title: 'Site styles and scripts',
    text: 'Copy any CSS or JavaScript you added to sites, and keep it for when Orbit’s Tweaks can take it.',
  },
]
