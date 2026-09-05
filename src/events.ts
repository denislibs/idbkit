import { inRange, type Key, type KeyRange } from './range';
import type { CompiledSchema } from './schema';
import type { Pending } from './tx';
import type { Change, ChangeEntry, IndexValues, Listener, Unsubscribe } from './types';

export type Filter = { key: Key } | { index: string; range: KeyRange<Key> };
type Sub = { store: string; filter?: Filter; listener: Listener };

export class Events {
  private subs = new Set<Sub>();

  constructor(private schema: CompiledSchema, _channelName?: string) {}

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
  }

  close(): void {
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

  private narrow(c: Change, f: Filter | undefined): Change | undefined {
    if (!f || c.keys === null) return c;
    const entries = (c.entries ?? []).filter((e) =>
      'key' in f ? indexedDB.cmp(e.key, f.key) === 0 : this.matches(c.store, e, f, c.source),
    );
    if (!entries.length) return undefined;
    return { ...c, keys: entries.map((e) => e.key), entries };
  }

  /** Range matching is completed in the range-subscriptions task; for now every entry matches. */
  private matches(_store: string, _e: ChangeEntry, _f: { index: string; range: KeyRange<Key> }, _source: Change['source']): boolean {
    void inRange;
    return true;
  }
}
