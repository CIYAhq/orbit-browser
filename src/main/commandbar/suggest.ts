/**
 * Search-engine suggestion responses (OpenSearch JSON: `[query, [suggestion, …]]`),
 * which every engine in SEARCH_ENGINES uses. Pure, unit-tested.
 */
export function parseSuggestions(json: unknown, query: string): string[] {
  if (!Array.isArray(json) || !Array.isArray(json[1])) return []
  const typed = query.trim().toLowerCase()
  const seen = new Set<string>([typed])
  const out: string[] = []
  for (const item of json[1] as unknown[]) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    const key = text.toLowerCase()
    if (!text || text.length > 200 || seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= 8) break
  }
  return out
}
