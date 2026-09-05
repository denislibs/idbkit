import type { KeyRange } from './range';

// ---------- schema configuration (what the user writes) ----------

type Field<R> = keyof R & string;
export type IndexPath<R> = Field<R> | readonly Field<R>[];
export type IndexConfig<R> =
  | IndexPath<R>
  | { readonly path: IndexPath<R>; readonly unique?: boolean; readonly multiEntry?: boolean };
export type StoreConfig<R> = {
  readonly key: Field<R>;
  readonly autoIncrement?: boolean;
  readonly indexes?: { readonly [name: string]: IndexConfig<R> };
};
export type StoresConfig<S> = { readonly [N in keyof S & string]: StoreConfig<S[N]> };

declare const SCHEMA: unique symbol;
/** Store config carrying the record types as a phantom, so `openDB` can infer both S and C. */
export type StoresDef<S, C extends StoresConfig<S>> = C & { readonly [SCHEMA]?: S };

/**
 * Two calls because TypeScript cannot infer C while S is given explicitly:
 * `defineStores<Schema>()({ users: { key: 'id' } })`.
 */
export function defineStores<S>() {
  return <const C extends StoresConfig<S>>(config: C): StoresDef<S, C> => config;
}

// ---------- derived types ----------

export type StoreName<C> = keyof C & string;
export type Rec<S, N> = S[N & keyof S];
type KeyField<C, N extends keyof C> = C[N] extends { readonly key: infer K extends string } ? K : never;
export type KeyOf<S, C, N extends StoreName<C>> = Exclude<Rec<S, N>[KeyField<C, N> & keyof Rec<S, N>], undefined>;
export type PutValue<S, C, N extends StoreName<C>> = C[N] extends { readonly autoIncrement: true }
  ? Omit<Rec<S, N>, KeyField<C, N>> & Partial<Pick<Rec<S, N>, KeyField<C, N> & keyof Rec<S, N>>>
  : Rec<S, N>;
export type IndexName<C, N extends StoreName<C>> = C[N] extends { readonly indexes: infer I } ? keyof I & string : never;
type PathOf<C, N extends StoreName<C>, I extends string> = C[N] extends { readonly indexes: infer Idx }
  ? I extends keyof Idx
    ? Idx[I] extends { readonly path: infer P } ? P : Idx[I]
    : never
  : never;
type ValueAt<R, P> = P extends readonly unknown[]
  ? { [K in keyof P]: P[K] extends keyof R ? R[P[K]] : never }
  : P extends keyof R ? R[P] : never;
export type IndexKey<S, C, N extends StoreName<C>, I extends IndexName<C, N>> = ValueAt<Rec<S, N>, PathOf<C, N, I>>;

// ---------- query options ----------

type QueryBase = { limit?: number; direction?: IDBCursorDirection };
export type IndexQuery<S, C, N extends StoreName<C>, I extends IndexName<C, N>> = QueryBase & {
  index: I;
  range?: KeyRange<IndexKey<S, C, N, I>>;
};
export type KeyQuery<S, C, N extends StoreName<C>> = QueryBase & {
  index?: undefined;
  range?: KeyRange<KeyOf<S, C, N>>;
};

// ---------- runtime: compiled schema ----------

export type CompiledIndex = { path: string | string[]; unique: boolean; multiEntry: boolean };
export type CompiledStore = { key: string; autoIncrement: boolean; indexes: Record<string, CompiledIndex>; fields: string[] };
export type CompiledSchema = Record<string, CompiledStore>;

/** `Array.isArray` alone does not narrow a `readonly T[]` union member out in negated form. */
function isPathArray(x: unknown): x is readonly string[] {
  return Array.isArray(x);
}

export function compileSchema(stores: Record<string, StoreConfig<Record<string, unknown>>>): CompiledSchema {
  const out: CompiledSchema = {};
  for (const name in stores) {
    const s = stores[name];
    const indexes: Record<string, CompiledIndex> = {};
    const fields = new Set<string>([s.key]);
    for (const iname in s.indexes ?? {}) {
      const cfg = s.indexes![iname];
      const o = typeof cfg === 'object' && !isPathArray(cfg) ? cfg : { path: cfg };
      const path = o.path as string | readonly string[];
      const list = typeof path === 'string' ? [path] : [...path];
      indexes[iname] = { path: typeof path === 'string' ? path : list, unique: !!o.unique, multiEntry: !!o.multiEntry };
      for (const f of list) fields.add(f);
    }
    out[name] = { key: s.key, autoIncrement: !!s.autoIncrement, indexes, fields: [...fields] };
  }
  return out;
}
