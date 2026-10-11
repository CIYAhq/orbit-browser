import type { TweakPatch } from '../../../shared/tweaks'
import { invoke } from '../api'

/** Sends an edit of a Tweak to main, which saves it and applies it to the page at once (BO-02). */
export function updateTweak(id: string, patch: TweakPatch): void {
  void invoke('tweaks.update', { id, patch })
}

/** Edits still waiting to be sent (typed code, BO-11), by whoever holds them. */
const waiting = new Set<() => void>()

/** Lets an editor's waiting edits be sent on demand; returns the way to stop. */
export function holdEdits(flush: () => void): () => void {
  waiting.add(flush)
  return () => waiting.delete(flush)
}

/**
 * Sends every edit still waiting, first: main handles the panel's messages in order, so the
 * close or the run that follows sees the code as typed.
 */
export function flushTweakEdits(): void {
  for (const flush of waiting) flush()
}
