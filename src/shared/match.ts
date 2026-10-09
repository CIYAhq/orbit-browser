/**
 * Scores how well `text` matches `query`: prefix > word start > substring >
 * in-order subsequence. Returns 0 for no match.
 */
export function matchScore(query: string, text: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (t === q) return 100
  if (t.startsWith(q)) return 80 - Math.min(20, t.length - q.length) * 0.2
  const idx = t.indexOf(q)
  if (idx > 0) {
    const atWord = /[\s/.\-_:]/.test(t[idx - 1] ?? '')
    return (atWord ? 60 : 40) - Math.min(20, idx) * 0.3
  }
  // Subsequence match ("gml" → "gmail").
  let ti = 0
  let gaps = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return 0
    gaps += found - ti
    ti = found + 1
  }
  return Math.max(1, 25 - gaps * 0.5)
}
