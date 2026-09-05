import { IdbError, SchemaError } from './errors';
import type { Key } from './range';
import { compileSchema, type CompiledSchema, type StoresConfig } from './schema';
import { TransactionImpl, UpgradeTransactionImpl, type AnyQuery } from './tx';
import type { Database, Listener, Migration, OpenOptions, Unsubscribe, UpgradeTransaction } from './types';

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
  constructor(readonly raw: IDBDatabase, protected schema: CompiledSchema, protected broadcast: boolean) {}

  get name(): string {
    return this.raw.name;
  }

  get version(): number {
    return this.raw.version;
  }

  transaction(stores: string | readonly string[], mode: IDBTransactionMode = 'readonly'): TransactionImpl {
    return new TransactionImpl(this.raw.transaction(stores as string | string[], mode), {});
  }

  get(store: string, key: Key): Promise<unknown> {
    return this.transaction(store).get(store, key);
  }

  getAll(store: string, opts?: AnyQuery): Promise<unknown[]> {
    return this.transaction(store).getAll(store, opts);
  }

  getAllKeys(store: string, opts?: AnyQuery): Promise<Key[]> {
    return this.transaction(store).getAllKeys(store, opts);
  }

  count(store: string, opts?: AnyQuery): Promise<number> {
    return this.transaction(store).count(store, opts);
  }

  /** readwrite so cursor.update/delete work without an explicit transaction. */
  iterate(store: string, opts?: AnyQuery) {
    return this.transaction(store, 'readwrite').iterate(store, opts);
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

  subscribe(_store: string, _a: unknown, _b?: Listener): Unsubscribe {
    throw new Error('not implemented');
  }

  close(): void {
    this.raw.close();
  }

  /** Single write operations resolve after commit, so change events have fired when the promise settles. */
  private async write<T>(store: string, fn: (tx: TransactionImpl) => Promise<T>): Promise<T> {
    const tx = this.transaction(store, 'readwrite');
    const result = await fn(tx);
    await tx.done;
    return result;
  }
}
