import { inRange, type Key, type KeyRange } from './range';
import type { CompiledSchema } from './schema';
import type { Pending } from './tx';
import type { Change, ChangeEntry, IndexValues, Listener, Unsubscribe } from './types';

export type Filter = { key: Key } | { index: string; range: KeyRange<Key> };
type Sub = { store: string; filter?: Filter; listener: Listener };

export class Events {
  private subs = new Set<Sub>();
  private channel?: BroadcastChannel;

  constructor(
    private schema: CompiledSchema,
    channelName?: string,
  ) {
    if (channelName && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(channelName);
      this.channel.onmessage = (e: MessageEvent<Pending[]>) => this.dispatch(e.data, 'remote');
    }
  }

  /** Only key + indexed fields, so events stay small and structured-cloneable. */
  pick(store: string, value: unknown): IndexValues {
    const out: IndexValues = {};
    const v = value as Record<string, unknown>;
    for (const f of this.schema[store].fields) out[f] = v[f];
    return out;
  }

  /** True when a range subscription on this store needs the old value to detect records leaving the range. */
  needsBefore(store: string): boolean {
    for (const s of this.subs) if (s.store === store && s.filter && 'index' in s.filter) return true;
    return false;
  }

  subscribe(store: string, filter: Filter | undefined, listener: Listener): Unsubscribe {
    const sub: Sub = { store, filter, listener };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  emit(changes: Pending[]): void {
    this.dispatch(changes, 'local');
    try {
      this.channel?.postMessage(changes);
    } catch (err) {
      console.error(err);
    }
  }

  close(): void {
    this.channel?.close();
    this.channel = undefined;
    this.subs.clear();
  }

  protected dispatch(changes: Pending[], source: Change['source']): void {
    for (const c of changes) {
      for (const s of [...this.subs]) {
        if (s.store !== c.store) continue;
        const change = this.narrow({ ...c, source }, s.filter);
        if (!change) continue;
        try {
          s.listener(change);
        } catch (err) {
          console.error(err);
        }
      }
    }
  }

  /**
   * An entry passes a range filter if its index key before or after the change falls in the range.
   * Without `before` we cannot tell whether the record left the range, so remote changes
   * (the other tab may not have read it) and entries with neither side are treated as relevant.
   */
  private narrow(c: Change, f: Filter | undefined): Change | undefined {
    if (!f || c.keys === null) return c;
    const matches = (e: ChangeEntry): boolean => {
      if ('key' in f) return indexedDB.cmp(e.key, f.key) === 0;
      if (!e.before && (c.source === 'remote' || !e.after)) return true;
      const path = this.schema[c.store]?.indexes[f.index]?.path;
      if (!path) return true;
      const keyOf = (v: IndexValues) => (typeof path === 'string' ? v[path] : path.map((p) => v[p])) as Key;
      return (!!e.before && inRange(keyOf(e.before), f.range)) || (!!e.after && inRange(keyOf(e.after), f.range));
    };
    const entries = (c.entries ?? []).filter(matches);
    if (!entries.length) return undefined;
    return { ...c, keys: entries.map((e) => e.key), entries };
  }
}
