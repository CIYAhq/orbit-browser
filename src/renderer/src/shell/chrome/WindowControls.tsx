import { invoke } from '../../api'
import { useShortcutLabel } from '../../keys/live'

/**
 * Client-side window controls at the top-left of the sidebar on Linux and Windows, mirroring the
 * macOS traffic lights (SB-03, SB-26). Close names its key (OB-11, KS-18).
 */
export function WindowControls() {
  const closeKeys = useShortcutLabel('window.close')
  return (
    <div className="window-controls" data-testid="window-controls">
      <button
        type="button"
        aria-label="Close window"
        title={closeKeys ? `Close (${closeKeys})` : 'Close'}
        className="window-controls__btn window-controls__btn--close"
        onClick={() => void invoke('window.control', { op: 'close' })}
      />
      <button
        type="button"
        aria-label="Minimize window"
        title="Minimize"
        className="window-controls__btn window-controls__btn--min"
        onClick={() => void invoke('window.control', { op: 'minimize' })}
      />
      <button
        type="button"
        aria-label="Maximize window"
        title="Maximize"
        className="window-controls__btn window-controls__btn--max"
        onClick={() => void invoke('window.control', { op: 'maximize' })}
      />
    </div>
  )
}
