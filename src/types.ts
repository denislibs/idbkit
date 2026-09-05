import type { Key, KeyRange } from './range';
import type {
  IndexKey, IndexName, IndexQuery, KeyOf, KeyQuery, PutValue, Rec, StoreName, StoresConfig, StoresDef,
} from './schema';

// ---------- change events ----------

/** Only the fields referenced by `key` and `indexes` of the store — never the full record. */
export type IndexValues = Record<string, unknown>;
export type ChangeEntry = { key: Key; before?: IndexValues; after?: IndexValues };
export type Change = {
  store: string;
  /** `null` means the whole store changed (clear). */
  keys: Key[] | null;
  entries?: ChangeEntry[];
  source: 'local' | 'remote';
};
export type Listener = (change: Change) => void;
export type Unsubscribe = () => void;

// ---------- cursors ----------

export interface Cursor<V, K = Key, PK = Key> {
  readonly key: K;
  readonly primaryKey: PK;
  readonly value: V;
  update(value: V): Promise<void>;
  delete(): Promise<void>;
}

// ---------- operations ----------

/**
 * Each read has two overloads: with `index` (range typed by the index key) and without
 * (range typed by the primary key). `I extends string` plus `& { index: I }` is deliberate:
 * it keeps the index literal from widening to the union of all index names.
 */
export interface Reads<S, C, Names extends StoreName<C>> {
  get<N extends Names>(store: N, key: KeyOf<S, C, N>): Promise<Rec<S, N> | undefined>;

  getAll<N extends Names, I extends string>(store: N, opts: IndexQuery<S, C, N, I & IndexName<C, N>> & { index: I }): Promise<Rec<S, N>[]>;
  getAll<N extends Names>(store: N, opts?: KeyQuery<S, C, N>): Promise<Rec<S, N>[]>;

  getAllKeys<N extends Names, I extends string>(store: N, opts: IndexQuery<S, C, N, I & IndexName<C, N>> & { index: I }): Promise<KeyOf<S, C, N>[]>;
  getAllKeys<N extends Names>(store: N, opts?: KeyQuery<S, C, N>): Promise<KeyOf<S, C, N>[]>;

  count<N extends Names, I extends string>(store: N, opts: IndexQuery<S, C, N, I & IndexName<C, N>> & { index: I }): Promise<number>;
  count<N extends Names>(store: N, opts?: KeyQuery<S, C, N>): Promise<number>;

  iterate<N extends Names, I extends string>(store: N, opts: IndexQuery<S, C, N, I & IndexName<C, N>> & { index: I }): AsyncIterable<Cursor<Rec<S, N>, IndexKey<S, C, N, I & IndexName<C, N>>, KeyOf<S, C, N>>>;
  iterate<N extends Names>(store: N, opts?: KeyQuery<S, C, N>): AsyncIterable<Cursor<Rec<S, N>, KeyOf<S, C, N>, KeyOf<S, C, N>>>;
}

export interface Writes<S, C, Names extends StoreName<C>> {
  put<N extends Names>(store: N, value: PutValue<S, C, N>): Promise<KeyOf<S, C, N>>;
  add<N extends Names>(store: N, value: PutValue<S, C, N>): Promise<KeyOf<S, C, N>>;
  delete<N extends Names>(store: N, key: KeyOf<S, C, N>): Promise<void>;
  clear<N extends Names>(store: N): Promise<void>;
}

export interface Transaction<S, C, Names extends StoreName<C> = StoreName<C>>
  extends Reads<S, C, Names>, Writes<S, C, Names> {
  readonly raw: IDBTransaction;
  /** Resolves on `complete`, rejects with IdbError on `abort`. */
  readonly done: Promise<void>;
  abort(): void;
}

export type AnySchema = Record<string, any>;
export type AnyConfig = Record<string, { readonly key: string; readonly autoIncrement?: boolean; readonly indexes?: Record<string, any> }>;

/** Untyped transaction available inside migrations. All `await`s inside must be on this transaction's own operations. */
export interface UpgradeTransaction extends Transaction<AnySchema, AnyConfig, string> {
  readonly oldVersion: number;
  readonly newVersion: number;
  deleteStore(name: string): void;
}

export type Migration = (tx: UpgradeTransaction) => void | Promise<void>;

// ---------- database ----------

export interface Database<S, C extends StoresConfig<S>> extends Reads<S, C, StoreName<C>>, Writes<S, C, StoreName<C>> {
  readonly raw: IDBDatabase;
  readonly name: string;
  readonly version: number;
  transaction<N extends StoreName<C>>(stores: N | readonly N[], mode?: IDBTransactionMode): Transaction<S, C, N>;
  subscribe<N extends StoreName<C>>(store: N, listener: Listener): Unsubscribe;
  subscribe<N extends StoreName<C>>(store: N, filter: { key: KeyOf<S, C, N> }, listener: Listener): Unsubscribe;
  subscribe<N extends StoreName<C>, I extends string>(
    store: N,
    filter: { index: I & IndexName<C, N>; range: KeyRange<IndexKey<S, C, N, I & IndexName<C, N>>> } & { index: I },
    listener: Listener,
  ): Unsubscribe;
  close(): void;
}

export type OpenOptions<S, C extends StoresConfig<S>> = {
  version: number;
  stores: StoresDef<S, C>;
  migrations?: Record<number, Migration>;
  /** Cross-tab change events through BroadcastChannel. Default true. */
  broadcast?: boolean;
  /** Another tab holds an older version open; `openDB` keeps waiting. */
  onBlocked?: () => void;
  /** Another tab opened a newer version; call `db.close()` to let it proceed. */
  onVersionChange?: () => void;
};
