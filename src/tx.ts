import { iterate } from './cursor';
import { IdbError, request } from './errors';
import type { Events } from './events';
import { toKeyRange, type Key, type KeyRange } from './range';
import type { ChangeEntry, Cursor } from './types';

export type AnyQuery = { index?: string; range?: KeyRange<Key>; limit?: number; direction?: IDBCursorDirection };
export type Pending = { store: string; keys: Key[] | null; entries: ChangeEntry[] };

export type Ctx = { events?: Events };

export class TransactionImpl {
  readonly done: Promise<void>;
  private changes = new Map<string, Pending>();

  constructor(readonly raw: IDBTransaction, protected ctx: Ctx) {
    this.done = new Promise<void>((resolve, reject) => {
      raw.addEventListener('complete', () => {
        if (this.changes.size) ctx.events?.emit([...this.changes.values()]);
        resolve();
      });
      raw.addEventListener('abort', () =>
        reject(new IdbError('Transaction aborted', { cause: raw.error })),
      );
    });
    // Callers may never await `done`; avoid an unhandled rejection while still rejecting for those who do.
    this.done.catch(() => {});
  }

  abort(): void {
    this.raw.abort();
  }

  private store(name: string): IDBObjectStore;
  private store(name: string, index: string | undefined): IDBObjectStore | IDBIndex;
  private store(name: string, index?: string): IDBObjectStore | IDBIndex {
    let s: IDBObjectStore;
    try {
      s = this.raw.objectStore(name);
    } catch (cause) {
      throw new IdbError(`Store "${name}" not in transaction`, { cause, store: name });
    }
    return index ? s.index(index) : s;
  }

  get(store: string, key: Key): Promise<unknown> {
    return request(() => this.store(store).get(key), store, 'get');
  }

  getAll(store: string, opts: AnyQuery = {}): Promise<any[]> {
    return request(() => this.store(store, opts.index).getAll(toKeyRange(opts.range), opts.limit), store, 'getAll');
  }

  getAllKeys(store: string, opts: AnyQuery = {}): Promise<Key[]> {
    return request(() => this.store(store, opts.index).getAllKeys(toKeyRange(opts.range), opts.limit), store, 'getAllKeys');
  }

  count(store: string, opts: AnyQuery = {}): Promise<number> {
    return request(() => this.store(store, opts.index).count(toKeyRange(opts.range)), store, 'count');
  }

  iterate(store: string, opts: AnyQuery = {}): AsyncIterable<Cursor<unknown>> {
    return iterate(() => this.store(store, opts.index), toKeyRange(opts.range), opts.direction, opts.limit, store, {
      onUpdate: (pk, before, after) => this.record(store, pk, before, after),
      onDelete: (pk, before) => this.record(store, pk, before, undefined),
    });
  }

  async put(store: string, value: unknown): Promise<Key> {
    const s = this.store(store);
    const before = await this.readBefore(store, s, (value as Record<string, Key | undefined>)[s.keyPath as string]);
    const key = await request(() => s.put(value), store, 'put');
    this.record(store, key, before, value);
    return key;
  }

  async add(store: string, value: unknown): Promise<Key> {
    const key = await request(() => this.store(store).add(value), store, 'add');
    this.record(store, key, undefined, value);
    return key;
  }

  async delete(store: string, key: Key): Promise<void> {
    const s = this.store(store);
    const before = await this.readBefore(store, s, key);
    await request(() => s.delete(key), store, 'delete');
    this.record(store, key, before, undefined);
  }

  async clear(store: string): Promise<void> {
    await request(() => this.store(store).clear(), store, 'clear');
    this.changes.set(store, { store, keys: null, entries: [] });
  }

  /** Old value is read only when a range subscription on this store needs it. */
  private readBefore(store: string, s: IDBObjectStore, key: Key | undefined): Promise<unknown> {
    if (key === undefined || !this.ctx.events?.needsBefore(store)) return Promise.resolve(undefined);
    return request(s.get(key), store, 'get');
  }

  private record(store: string, key: Key, before: unknown, after: unknown): void {
    const events = this.ctx.events;
    if (!events) return;
    let change = this.changes.get(store);
    if (!change) this.changes.set(store, (change = { store, keys: [], entries: [] }));
    if (change.keys === null) return; // already "everything changed"
    const entry: ChangeEntry = { key };
    if (before !== undefined) entry.before = events.pick(store, before);
    if (after !== undefined) entry.after = events.pick(store, after);
    change.keys.push(key);
    change.entries.push(entry);
  }
}

export class UpgradeTransactionImpl extends TransactionImpl {
  constructor(raw: IDBTransaction, readonly oldVersion: number, readonly newVersion: number) {
    super(raw, {});
  }

  deleteStore(name: string): void {
    this.raw.db.deleteObjectStore(name);
  }
}
