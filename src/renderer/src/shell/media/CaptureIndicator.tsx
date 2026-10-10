import { Mic, Video } from 'lucide-react'
import type { TabMedia } from '../../../../shared/state'
import './media.css'

/**
 * A tab using the camera or microphone shows a pulsing red indicator on its row (TB-15, MD-11).
 * Media lane; drawn by the tab row next to the speaker icon.
 */
export function CaptureIndicator({ media }: { media: TabMedia | undefined }) {
  if (!media?.mic && !media?.camera) return null
  const label =
    media.camera && media.mic ? 'Using camera and microphone' : media.camera ? 'Using camera' : 'Using microphone'
  return (
    <span className="capture-indicator" data-testid="tab-capture" title={label} aria-label={label} role="img">
      {media.camera ? <Video size={12} strokeWidth={2.2} /> : <Mic size={12} strokeWidth={2.2} />}
    </span>
  )
}
