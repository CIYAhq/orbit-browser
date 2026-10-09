import type { CommandArgs, CommandName, CommandResult } from '../../shared/rpc'

export const orbit = window.orbit
export const isMac = window.orbit.platform === 'darwin'

export function invoke<K extends CommandName>(name: K, args: CommandArgs<K>): Promise<CommandResult<K>> {
  return window.orbit.invoke(name, args)
}

export function runAction(id: string): void {
  void window.orbit.invoke('action.run', { id })
}

export function perfMark(name: string): void {
  window.orbit.send('perf.mark', { name, t: performance.now() })
}
