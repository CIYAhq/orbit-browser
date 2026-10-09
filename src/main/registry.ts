import type { CommandArgs, CommandName, CommandResult, EventName, OrbitEvents } from '../shared/rpc'
import type { WindowId } from '../shared/state'

/** Who invoked a command: the window it came from (if any). */
export interface CallContext {
  windowId?: WindowId
}

type Handler<K extends CommandName> = (
  args: CommandArgs<K>,
  ctx: CallContext,
) => CommandResult<K> | Promise<CommandResult<K>>

/** Typed registry of RPC command handlers. Each feature registers its own. */
export class CommandRegistry {
  private handlers = new Map<string, Handler<CommandName>>()

  register<K extends CommandName>(name: K, handler: Handler<K>): void {
    if (this.handlers.has(name)) throw new Error(`Command already registered: ${name}`)
    this.handlers.set(name, handler as unknown as Handler<CommandName>)
  }

  has(name: string): boolean {
    return this.handlers.has(name)
  }

  async run<K extends CommandName>(name: K, args: CommandArgs<K>, ctx: CallContext = {}): Promise<CommandResult<K>> {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error(`Unknown command: ${name}`)
    return (await handler(args as CommandArgs<CommandName>, ctx)) as CommandResult<K>
  }
}

type EventHandler<K extends EventName> = (payload: OrbitEvents[K], ctx: CallContext) => void

export class EventRegistry {
  private handlers = new Map<string, EventHandler<EventName>[]>()

  on<K extends EventName>(name: K, handler: EventHandler<K>): void {
    const list = this.handlers.get(name) ?? []
    list.push(handler as unknown as EventHandler<EventName>)
    this.handlers.set(name, list)
  }

  emit<K extends EventName>(name: K, payload: OrbitEvents[K], ctx: CallContext): void {
    for (const handler of this.handlers.get(name) ?? []) handler(payload as OrbitEvents[EventName], ctx)
  }
}

export interface ActionContext {
  windowId?: WindowId
}

/** User-facing actions (shortcuts, menu, command bar) keyed by ActionDef id. */
export class ActionRegistry {
  private handlers = new Map<string, (ctx: ActionContext) => void | Promise<void>>()

  register(id: string, handler: (ctx: ActionContext) => void | Promise<void>): void {
    this.handlers.set(id, handler)
  }

  has(id: string): boolean {
    return this.handlers.has(id)
  }

  async run(id: string, ctx: ActionContext): Promise<void> {
    const handler = this.handlers.get(id)
    if (!handler) {
      console.warn(`[actions] no handler for ${id}`)
      return
    }
    await handler(ctx)
  }
}
