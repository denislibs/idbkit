import { Events, type Filter } from './events';
import { IdbError, SchemaError } from './errors';
import type { Key } from './range';
import { compileSchema, type CompiledSchema, type StoresConfig } from './schema';
import { TransactionImpl, UpgradeTransactionImpl, type AnyQuery } from './tx';
import type { Cursor, Database, Listener, Migration, OpenOptions, Unsubscribe, UpgradeTransaction } from './types';

export async function openDB<S, C extends StoresConfig<S>>(name: string, opts: OpenOptions<S, C>): Promise<Database<S, C>> {
  validate(opts);
  const schema = compileSchema(opts.stores as unknown as Parameters<typeof compileSchema>[0]);
  const migrations = opts.migrations ?? {};
  return new Promise<Database<S, C>>((resolve, reject) => {
    const req = indexedDB.open(name, opts.version);
    let upgradeError: unknown;
    req.onblocked = () => opts.onBlocked?.();
    req.onupgradeneeded = (e) => {
      const tx = new UpgradeTransactionImpl(req.transaction!, e.oldVersion, e.newVersion ?? opts.version);
      upgrade(req.result, tx, schema, migrations).catch((err: unknown) => {
        upgradeError = err;
        try {
          req.transaction!.abort();
        } catch {
          /* already aborted */
        }
      });
    };
    req.onerror = () =>
      reject(upgradeError ?? new IdbError(req.error?.message ?? 'Failed to open database', { cause: req.error, op: 'open' }));
    req.onsuccess = () => {
      const raw = req.result;
      raw.onversionchange = () => opts.onVersionChange?.();
      resolve(new DatabaseImpl(raw, schema, opts.broadcast !== false) as unknown as Database<S, C>);
    };
  });
}

function validate(opts: { version: number; migrations?: Record<number, unknown> }): void {
  if (!Number.isInteger(opts.version) || opts.version < 1) {
    throw new SchemaError(`version must be a positive integer, got ${opts.version}`);
  }
  for (const v of Object.keys(opts.migrations ?? {})) {
    if (Number(v) > opts.version) throw new SchemaError(`migration ${v} targets a version above ${opts.version}`);
  }
}

/**
 * 1. Additive structure sync (create stores/indexes, recreate changed indexes).
 * 2. Data migrations for versions in (oldVersion, newVersion], ascending.
 * 3. Drop indexes missing from the schema. Stores outside the schema are kept and warned about.
 */
async function upgrade(
  db: IDBDatabase,
  tx: UpgradeTransactionImpl,
  schema: CompiledSchema,
  migrations: Record<number, Migration>,
): Promise<void> {
  for (const name in schema) {
    const s = schema[name];
    const store = db.objectStoreNames.contains(name)
      ? tx.raw.objectStore(name)
      : db.createObjectStore(name, { keyPath: s.key, autoIncrement: s.autoIncrement });
    for (const iname in s.indexes) {
      const i = s.indexes[iname];
      if (store.indexNames.contains(iname)) {
        const existing = store.index(iname);
        const same =
          JSON.stringify(existing.keyPath) === JSON.stringify(i.path) &&
          existing.unique === i.unique &&
          existing.multiEntry === i.multiEntry;
        if (same) continue;
        store.deleteIndex(iname);
      }
      store.createIndex(iname, i.path, { unique: i.unique, multiEntry: i.multiEntry });
    }
  }

  const versions = Object.keys(migrations)
    .map(Number)
    .filter((v) => v > tx.oldVersion && v <= tx.newVersion)
    .sort((a, b) => a - b);
  for (const v of versions) await migrations[v](tx as unknown as UpgradeTransaction);

  for (const name in schema) {
    if (!db.objectStoreNames.contains(name)) continue;
    const store = tx.raw.objectStore(name);
    for (const iname of Array.from(store.indexNames)) {
      if (!(iname in schema[name].indexes)) store.deleteIndex(iname);
    }
  }
  if (isDev()) {
    for (const name of Array.from(db.objectStoreNames)) {
      if (!(name in schema)) console.warn(`idbkit: store "${name}" exists in database "${db.name}" but is not in the schema`);
    }
  }
}

function isDev(): boolean {
  try {
    return process.env.NODE_ENV !== 'production';
  } catch {
    return true;
  }
}

export class DatabaseImpl {
  private events: Events;

  constructor(readonly raw: IDBDatabase, schema: CompiledSchema, broadcast: boolean) {
    this.events = new Events(schema, broadcast ? `idbkit:${raw.name}` : undefined);
  }

  get name(): string {
    return this.raw.name;
  }

  get version(): number {
    return this.raw.version;
  }

  transaction(stores: string | readonly string[], mode: IDBTransactionMode = 'readonly'): TransactionImpl {
    let raw: IDBTransaction;
    try {
      raw = this.raw.transaction(stores as string | string[], mode);
    } catch (cause) {
      throw new IdbError((cause as Error)?.message ?? 'Failed to start transaction', { cause, op: 'transaction' });
    }
    return new TransactionImpl(raw, { events: this.events });
  }

  get(store: string, key: Key): Promise<unknown> {
    return this.read(store, (tx) => tx.get(store, key));
  }

  getAll(store: string, opts?: AnyQuery): Promise<unknown[]> {
    return this.read(store, (tx) => tx.getAll(store, opts));
  }

  getAllKeys(store: string, opts?: AnyQuery): Promise<Key[]> {
    return this.read(store, (tx) => tx.getAllKeys(store, opts));
  }

  count(store: string, opts?: AnyQuery): Promise<number> {
    return this.read(store, (tx) => tx.count(store, opts));
  }

  /**
   * readwrite so cursor.update/delete work without an explicit transaction. Awaits `done` on every
   * exit path so change events have been delivered when the loop ends; on an abnormal exit the
   * abort rejection is swallowed so it cannot mask the consumer's own error.
   */
  async *iterate(store: string, opts?: AnyQuery): AsyncIterable<Cursor<unknown>> {
    const tx = this.transaction(store, 'readwrite');
    let completed = false;
    try {
      yield* tx.iterate(store, opts);
      completed = true;
    } finally {
      if (completed) await tx.done;
      else await tx.done.catch(() => {});
    }
  }

  put(store: string, value: unknown): Promise<Key> {
    return this.write(store, (tx) => tx.put(store, value));
  }

  add(store: string, value: unknown): Promise<Key> {
    return this.write(store, (tx) => tx.add(store, value));
  }

  delete(store: string, key: Key): Promise<void> {
    return this.write(store, (tx) => tx.delete(store, key));
  }

  clear(store: string): Promise<void> {
    return this.write(store, (tx) => tx.clear(store));
  }

  subscribe(store: string, a: Filter | Listener, b?: Listener): Unsubscribe {
    return typeof a === 'function' ? this.events.subscribe(store, undefined, a) : this.events.subscribe(store, a, b!);
  }

  close(): void {
    this.events.close();
    this.raw.close();
  }

  /** Single write operations resolve after commit, so change events have fired when the promise settles. */
  private async write<T>(store: string, fn: (tx: TransactionImpl) => Promise<T>): Promise<T> {
    const tx = this.transaction(store, 'readwrite');
    const result = await fn(tx);
    await tx.done;
    return result;
  }

  /** Routes a synchronous `transaction()` throw (e.g. after `close()`) through the returned promise instead of throwing. */
  private async read<T>(store: string, fn: (tx: TransactionImpl) => Promise<T>): Promise<T> {
    return fn(this.transaction(store));
  }
}
