/** Minimal typed event bus. `on` returns an unsubscribe function. */
export class EventBus<Events extends object> {
  private readonly handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(type: K, handler: (payload: Events[K]) => void): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler as (payload: never) => void);
    this.handlers.set(type, set);
    return () => set.delete(handler as (payload: never) => void);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const handler of [...set]) (handler as (payload: Events[K]) => void)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
