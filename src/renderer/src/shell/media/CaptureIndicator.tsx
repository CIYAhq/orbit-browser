import { Mic, ScreenShare, Video } from 'lucide-react'
import type { TabMedia } from '../../../../shared/state'
import './media.css'

/**
 * A tab using the camera or microphone shows a pulsing red indicator on its row, and a tab sharing a
 * screen or window a blue one of its own (TB-15, MD-11). Media lane; drawn by the tab row next to
 * the speaker icon.
 */
export function CaptureIndicator({ media }: { media: TabMedia | undefined }) {
  const capture = !!media?.mic || !!media?.camera
  if (!media || (!capture && !media.screen)) return null
  const label =
    media.camera && media.mic ? 'Using camera and microphone' : media.camera ? 'Using camera' : 'Using microphone'
  return (
    <>
      {media.screen && (
        <span
          className="capture-indicator is-screen"
          data-testid="tab-screen-share"
          title="Sharing your screen"
          aria-label="Sharing your screen"
          role="img"
        >
          <ScreenShare size={12} strokeWidth={2.2} />
        </span>
      )}
      {capture && (
        <span className="capture-indicator" data-testid="tab-capture" title={label} aria-label={label} role="img">
          {media.camera ? <Video size={12} strokeWidth={2.2} /> : <Mic size={12} strokeWidth={2.2} />}
        </span>
      )}
    </>
  )
}
