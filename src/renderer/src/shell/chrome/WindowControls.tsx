import { invoke } from '../../api'

/**
 * Client-side window controls at the top-left of the sidebar on Linux and Windows, mirroring the
 * macOS traffic lights (SB-03, SB-26).
 */
export function WindowControls() {
  return (
    <div className="window-controls" data-testid="window-controls">
      <button
        type="button"
        aria-label="Close window"
        title="Close"
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
