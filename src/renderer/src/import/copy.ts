/**
 * Words the import spec (IM-12, OB-03) asks for by name, for people moving from one browser that has
 * no export of its own: the help heading and the default name of a pasted folder. They are kept here,
 * in one place, and nothing in Orbit reads that browser's files.
 */
export const MOVING_HEADING = 'Coming from Arc?'
export const PASTE_DEFAULT_NAME = 'Imported from Arc'
export const MOVING_INTRO =
  'Orbit never reads Arc’s own files. Your things come over through what you copy or export there yourself:'

export const MOVING_ROUTES: { title: string; text: string }[] = [
  {
    title: 'Pinned tabs and folders',
    text: 'In Arc, right-click a folder and choose Copy all links, or select tabs and press ⇧⌘C. Then choose Paste a list of links here, or click an empty part of Orbit’s pinned section and paste.',
  },
  {
    title: 'Bookmarks',
    text: 'Arc’s bookmarks page can export a bookmarks file (.html). Import it with From a file, or drop it on this window or on the sidebar.',
  },
  {
    title: 'Notes',
    text: 'Arc’s Export notes makes a zip of pages. Keep it: Orbit’s notes can’t take them in yet.',
  },
  {
    title: 'Canvases',
    text: 'Arc exports them only as images. Keep the images, or drop them onto a page that takes pictures.',
  },
  {
    title: 'Site styles and scripts',
    text: 'Copy the CSS or JavaScript from Arc’s code editor and keep it for when Orbit’s Tweaks can take it.',
  },
]
