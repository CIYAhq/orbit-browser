import type { SpaceId, TabId } from '../state'

export type SearchResultKind = 'tab' | 'history' | 'suggestion' | 'url' | 'search' | 'action' | 'space'

export interface SearchResult {
  id: string
  kind: SearchResultKind
  title: string
  subtitle?: string
  url?: string
  favicon?: string
  tabId?: TabId
  spaceId?: SpaceId
  actionId?: string
  /** Higher is better. */
  score: number
}

/** Owned by the command bar lane. */
export interface CommandBarCommands {
  'search.query': { args: { query: string; mode: 'new-tab' | 'edit-url' | 'search-tabs' }; result: SearchResult[] }
  'search.open': {
    args: {
      result: SearchResult
      mode: 'new-tab' | 'edit-url' | 'search-tabs'
      disposition?: 'current' | 'new-tab' | 'split'
    }
    result: void
  }
}
