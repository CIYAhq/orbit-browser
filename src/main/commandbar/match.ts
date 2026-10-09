/**
 * Text matching for the command bar. Inputs are pre-lowercased; everything here
 * runs per candidate per keystroke, so it avoids allocation and regexes.
 */

/** Match quality of one term in one field. */
export const PREFIX = 100
export const WORD = 70
export const INSIDE = 40

/** Characters that start a new "word" in titles and URLs. */
function isBoundary(code: number): boolean {
  return (
    code === 32 || // space
    code === 47 || // /
    code === 46 || // .
    code === 45 || // -
    code === 95 || // _
    code === 58 || // :
    code === 63 || // ?
    code === 61 || // =
    code === 38 || // &
    code === 35 || // #
    code === 40 || // (
    code === 91 || // [
    code === 44 || // ,
    code === 124 || // |
    code === 43 || // +
    code === 64 || // @
    code === 34 || // "
    code === 39 || // '
    code === 8211 || // – en dash
    code === 8212 // — em dash
  )
}

/** PREFIX if `text` starts with `term`, WORD if a word in it does, INSIDE if it contains it, else 0. */
export function fieldMatch(term: string, text: string): number {
  if (!text) return 0
  let i = text.indexOf(term)
  if (i < 0) return 0
  if (i === 0) return PREFIX
  while (i > 0) {
    if (isBoundary(text.charCodeAt(i - 1))) return WORD
    i = text.indexOf(term, i + 1)
  }
  return INSIDE
}

/** Lowercase whitespace-separated terms. */
export function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

export interface DocMatch {
  /** 0 (no match) … 100. */
  score: number
  /** The first term starts the title, a title word or the host: a "strong" match (CB-07). */
  strong: boolean
  /** The first term starts the URL key (host prefix). */
  hostPrefix: boolean
}

const NO_MATCH: DocMatch = { score: 0, strong: false, hostPrefix: false }

/**
 * Scores a page-like candidate (title + URL key). Every term must match in the
 * title or the URL; title matches weigh more than URL matches.
 */
export function matchDoc(ts: string[], titleLower: string, urlKey: string, altUrlKey?: string): DocMatch {
  if (ts.length === 0) return NO_MATCH
  let total = 0
  let strong = false
  let hostPrefix = false
  for (let k = 0; k < ts.length; k++) {
    const t = ts[k] as string
    let inTitle = fieldMatch(t, titleLower)
    let inUrl = fieldMatch(t, urlKey)
    if (altUrlKey) inUrl = Math.max(inUrl, fieldMatch(t, altUrlKey))
    // A single letter only counts at the start of a word; anywhere else it is noise.
    if (t.length === 1) {
      if (inTitle === INSIDE) inTitle = 0
      if (inUrl === INSIDE) inUrl = 0
    }
    if (inTitle === 0 && inUrl === 0) return NO_MATCH
    const s = Math.max(inTitle, inUrl === PREFIX ? 95 : inUrl === WORD ? 60 : inUrl === INSIDE ? 25 : 0)
    total += s
    if (k === 0) {
      hostPrefix = inUrl === PREFIX
      strong = inTitle >= WORD || hostPrefix
    }
  }
  return { score: total / ts.length, strong, hostPrefix }
}

/** Scores a short name (Space, action title or keyword) against the terms. */
export function matchName(ts: string[], nameLower: string, keywords?: readonly string[]): DocMatch {
  if (ts.length === 0) return NO_MATCH
  let total = 0
  let strong = false
  for (let k = 0; k < ts.length; k++) {
    const t = ts[k] as string
    let s = fieldMatch(t, nameLower)
    if (keywords) {
      for (const kw of keywords) {
        const m = fieldMatch(t, kw)
        // Keywords are synonyms: slightly below an equal title match.
        if (m) s = Math.max(s, m - 10)
      }
    }
    if (t.length === 1 && s <= INSIDE) return NO_MATCH
    if (s === 0) return NO_MATCH
    total += s
    if (k === 0) strong = s >= WORD - 10
  }
  return { score: total / ts.length, strong, hostPrefix: false }
}

/** Initials of the words in a name, e.g. "developer tools" → "dt". */
export function initials(nameLower: string): string {
  let out = ''
  let atStart = true
  for (let i = 0; i < nameLower.length; i++) {
    const code = nameLower.charCodeAt(i)
    if (isBoundary(code)) {
      atStart = true
    } else if (atStart) {
      out += nameLower[i]
      atStart = false
    }
  }
  return out
}
