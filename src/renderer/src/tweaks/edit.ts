import type { TweakPatch } from '../../../shared/tweaks'
import { invoke } from '../api'

/** Sends an edit of a Tweak to main, which saves it and applies it to the page at once (BO-02). */
export function updateTweak(id: string, patch: TweakPatch): void {
  void invoke('tweaks.update', { id, patch })
}
