# idbkit Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `idbkit` core: a ≤3 KB gzip, zero-dependency, typed IndexedDB wrapper with declarative schema, data migrations, transactions, async cursors, and change events with cross-tab broadcast.

**Architecture:** Public API is a set of TypeScript interfaces (`Database`, `Transaction`, `Cursor`) with heavy generic typing; runtime classes (`DatabaseImpl`, `TransactionImpl`) are loosely typed and cast at the boundary in `openDB`. Change events are collected per transaction and emitted after `complete` to local subscribers and a `BroadcastChannel`. Old values are read before writes only when a range subscription exists on that store.

**Tech Stack:** TypeScript 5.9 (strict), tsup (ESM build + d.ts), Vitest 5 (runtime tests + `--typecheck` for `*.test-d.ts`), fake-indexeddb 6, size-limit. Package manager: pnpm.

Spec: `docs/superpowers/specs/2026-09-05-idbkit-core-design.md`.

## Global Constraints

- Core entry `dist/index.js` ≤ **3 KB** gzip (size-limit, preset-small-lib).
- **Zero** runtime dependencies. ESM only.
- Target ES2022; assume native Promise, async iterators, `BroadcastChannel`. No polyfills.
- All promise rejections from the library are `IdbError` or `SchemaError`.
- Change events never carry full records — only fields referenced by `key` and `indexes`.
- Stores present in the database but absent from the schema are never deleted automatically.
- Every task: run `pnpm typecheck` and `pnpm test` before committing. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Type tests live in `test/*.test-d.ts` and run through `vitest run` (typecheck enabled in config). An unused `// @ts-expect-error` is a test failure.

## File Map

| File | Responsibility |
|---|---|
| `src/errors.ts` | `IdbError`, `SchemaError`, `request()` promisify, `run()` sync-throw wrapper |
| `src/range.ts` | `Key`, `KeyRange` types; `toKeyRange()`, `inRange()` |
| `src/schema.ts` | Schema config types, `defineStores()`, derived key/index types, query option types, `compileSchema()` |
| `src/types.ts` | Public interfaces: `Cursor`, `Reads`, `Writes`, `Transaction`, `UpgradeTransaction`, `Database`, `OpenOptions`, `Change`, `Listener` |
| `src/cursor.ts` | `iterate()` async generator over `IDBCursorWithValue` |
| `src/tx.ts` | `TransactionImpl`, `UpgradeTransactionImpl`: operations + change collection |
| `src/events.ts` | `Events`: subscriptions, filtering, `BroadcastChannel` |
| `src/open.ts` | `openDB()`, validation, upgrade algorithm, `DatabaseImpl` |
| `src/index.ts` | Public re-exports |
| `test/setup.ts` | `import 'fake-indexeddb/auto'` |
| `test/helpers.ts` | `resetIndexedDB()`, `openRaw()` |

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.gitignore`, `test/setup.ts`, `test/helpers.ts`, `test/smoke.test.ts`, `src/index.ts`

**Interfaces:**
- Produces: `resetIndexedDB(): void` and `openRaw(name, setup): Promise<IDBDatabase>` in `test/helpers.ts`, used by every later test.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "idbkit",
  "version": "0.0.0",
  "description": "Tiny typed IndexedDB toolkit: schema, migrations, transactions, change events",
  "license": "MIT",
  "type": "module",
  "sideEffects": false,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "size": "size-limit",
    "check": "pnpm typecheck && pnpm test && pnpm build && pnpm size"
  },
  "devDependencies": {
    "@size-limit/preset-small-lib": "^13.0.3",
    "@types/node": "^24.0.0",
    "fake-indexeddb": "^6.2.5",
    "size-limit": "^13.0.3",
    "tsup": "^8.5.1",
    "typescript": "^5.9.3",
    "vitest": "^5.0.0"
  },
  "size-limit": [
    { "path": "dist/index.js", "limit": "3 KB" }
  ]
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.AsyncIterable"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "test", "vitest.config.ts", "tsup.config.ts"]
}
```

- [ ] **Step 3: Write tsup.config.ts, vitest.config.ts, .gitignore**

`tsup.config.ts`:
```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  target: 'es2022',
  clean: true,
  sourcemap: true,
  treeshake: true,
});
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    typecheck: { enabled: true, include: ['test/**/*.test-d.ts'] },
  },
});
```

`.gitignore`:
```
node_modules
dist
```

- [ ] **Step 4: Write test setup and helpers**

`test/setup.ts`:
```ts
import 'fake-indexeddb/auto';
```

`test/helpers.ts`:
```ts
import { IDBFactory } from 'fake-indexeddb';

/** Fresh, empty IndexedDB for each test. */
export function resetIndexedDB(): void {
  globalThis.indexedDB = new IDBFactory() as unknown as typeof globalThis.indexedDB;
}

/** Open a raw IDBDatabase at version 1, running `setup` inside upgradeneeded. */
export function openRaw(name: string, setup: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => setup(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolve after `ms` milliseconds. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
```

- [ ] **Step 5: Write a smoke test and a placeholder entry**

`src/index.ts`:
```ts
export {};
```

`test/smoke.test.ts`:
```ts
import { beforeEach, expect, it } from 'vitest';
import { openRaw, resetIndexedDB } from './helpers';

beforeEach(resetIndexedDB);

it('fake-indexeddb is wired up', async () => {
  const db = await openRaw('smoke', (d) => d.createObjectStore('s', { keyPath: 'id' }));
  expect(Array.from(db.objectStoreNames)).toEqual(['s']);
  db.close();
});
```

- [ ] **Step 6: Install and run**

Run: `pnpm install && pnpm typecheck && pnpm test`
Expected: install succeeds; typecheck clean; 1 test passes.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold idbkit with tsup, vitest, size-limit"
```

---

### Task 2: Errors and request promisify

**Files:**
- Create: `src/errors.ts`, `test/errors.test.ts`

**Interfaces:**
- Produces:
  - `class IdbError extends Error { readonly store?: string; readonly op?: string; cause: unknown }` — constructor `(message: string, info?: { cause?: unknown; store?: string; op?: string })`
  - `class SchemaError extends Error`
  - `request<T>(req: IDBRequest<T>, store?: string, op?: string): Promise<T>` — resolves on success, rejects with `IdbError` on error. Re-attachable: calling it again on the same request replaces handlers (used by cursors).
  - `run<T>(fn: () => IDBRequest<T>, store?: string, op?: string): Promise<T>` — like `request` but also converts a synchronous throw from `fn` into an `IdbError` rejection.

- [ ] **Step 1: Write the failing test**

`test/errors.test.ts`:
```ts
import { beforeEach, expect, it } from 'vitest';
import { IdbError, SchemaError, request, run } from '../src/errors';
import { openRaw, resetIndexedDB } from './helpers';

beforeEach(resetIndexedDB);

it('request resolves with the request result', async () => {
  const db = await openRaw('e1', (d) => d.createObjectStore('s', { keyPath: 'id' }));
  const store = db.transaction('s', 'readwrite').objectStore('s');
  expect(await request(store.put({ id: 7 }))).toBe(7);
  db.close();
});

it('request rejects with IdbError carrying cause, store and op', async () => {
  const db = await openRaw('e2', (d) => d.createObjectStore('s', { keyPath: 'id' }));
  const store = db.transaction('s', 'readwrite').objectStore('s');
  await request(store.add({ id: 1 }));
  const err = await request(store.add({ id: 1 }), 's', 'add').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(IdbError);
  expect(err).toBeInstanceOf(Error);
  expect((err as IdbError).name).toBe('IdbError');
  expect((err as IdbError).store).toBe('s');
  expect((err as IdbError).op).toBe('add');
  expect(((err as IdbError).cause as DOMException).name).toBe('ConstraintError');
  db.close();
});

it('run converts a synchronous throw into an IdbError rejection', async () => {
  const db = await openRaw('e3', (d) => d.createObjectStore('s', { keyPath: 'id' }));
  const store = db.transaction('s', 'readonly').objectStore('s');
  const err = await run(() => store.put({ id: 1 }), 's', 'put').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(IdbError);
  expect((err as IdbError).op).toBe('put');
  expect(((err as IdbError).cause as DOMException).name).toBe('ReadOnlyError');
  db.close();
});

it('SchemaError is an Error with its own name', () => {
  const e = new SchemaError('bad');
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe('SchemaError');
  expect(e.message).toBe('bad');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/errors.test.ts`
Expected: FAIL — cannot resolve `../src/errors`.

- [ ] **Step 3: Write the implementation**

`src/errors.ts`:
```ts
export type ErrorInfo = { cause?: unknown; store?: string; op?: string };

export class IdbError extends Error {
  readonly store?: string;
  readonly op?: string;

  constructor(message: string, info: ErrorInfo = {}) {
    super(message, { cause: info.cause });
    this.name = 'IdbError';
    this.store = info.store;
    this.op = info.op;
  }
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

/** Promisify an IDBRequest. Handlers are replaced on each call, so it is safe to re-await a cursor request. */
export function request<T>(req: IDBRequest<T>, store?: string, op?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(new IdbError(req.error?.message ?? 'IndexedDB request failed', { cause: req.error, store, op }));
  });
}

/** Like `request`, but a synchronous throw from `fn` (e.g. ReadOnlyError) becomes an IdbError rejection. */
export function run<T>(fn: () => IDBRequest<T>, store?: string, op?: string): Promise<T> {
  let req: IDBRequest<T>;
  try {
    req = fn();
  } catch (cause) {
    if (cause instanceof IdbError) return Promise.reject(cause);
    return Promise.reject(new IdbError((cause as Error)?.message ?? 'IndexedDB call failed', { cause, store, op }));
  }
  return request(req, store, op);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm vitest run test/errors.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts test/errors.test.ts
git commit -m "feat: IdbError, SchemaError and request promisify"
```

---

### Task 3: Key ranges

**Files:**
- Create: `src/range.ts`, `test/range.test.ts`

**Interfaces:**
- Produces:
  - `type Key = IDBValidKey`
  - `type Bounds<K> = { gt?: K; gte?: K; lt?: K; lte?: K }`
  - `type KeyRange<K> = K | Bounds<K>`
  - `toKeyRange(r: KeyRange<Key> | undefined): IDBKeyRange | undefined` — value → `only`, bounds → bound/lowerBound/upperBound, `undefined` or `{}` → `undefined`.
  - `inRange(key: Key, r: KeyRange<Key>): boolean` — membership test using `indexedDB.cmp`; returns `false` if comparison throws (invalid key).

- [ ] **Step 1: Write the failing test**

`test/range.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { inRange, toKeyRange } from '../src/range';

describe('toKeyRange', () => {
  it('returns undefined for undefined or empty bounds', () => {
    expect(toKeyRange(undefined)).toBeUndefined();
    expect(toKeyRange({})).toBeUndefined();
  });

  it('treats plain values, arrays and dates as equality', () => {
    expect(toKeyRange(5)).toMatchObject({ lower: 5, upper: 5, lowerOpen: false, upperOpen: false });
    expect(toKeyRange(['a', 1])).toMatchObject({ lower: ['a', 1], upper: ['a', 1] });
    const d = new Date(0);
    expect(toKeyRange(d)!.lower).toEqual(d);
  });

  it('builds bounds with correct openness', () => {
    expect(toKeyRange({ gte: 1, lt: 5 })).toMatchObject({ lower: 1, upper: 5, lowerOpen: false, upperOpen: true });
    expect(toKeyRange({ gt: 1, lte: 5 })).toMatchObject({ lower: 1, upper: 5, lowerOpen: true, upperOpen: false });
    const lower = toKeyRange({ gt: 0 })!;
    expect(lower.lower).toBe(0);
    expect(lower.lowerOpen).toBe(true);
    expect(lower.upper).toBeUndefined();
    const upper = toKeyRange({ lte: 'z' })!;
    expect(upper.upper).toBe('z');
    expect(upper.upperOpen).toBe(false);
    expect(upper.lower).toBeUndefined();
  });

  it('treats 0 and empty string as real bounds', () => {
    expect(toKeyRange({ gte: 0 })!.lower).toBe(0);
    expect(toKeyRange({ lte: '' })!.upper).toBe('');
  });
});

describe('inRange', () => {
  it('equality', () => {
    expect(inRange(5, 5)).toBe(true);
    expect(inRange(5, 6)).toBe(false);
    expect(inRange(['a', 1], ['a', 1])).toBe(true);
  });

  it('bounds', () => {
    expect(inRange(18, { gte: 18 })).toBe(true);
    expect(inRange(18, { gt: 18 })).toBe(false);
    expect(inRange(5, { gte: 1, lt: 5 })).toBe(false);
    expect(inRange(4, { gte: 1, lt: 5 })).toBe(true);
    expect(inRange('m', { lte: 'm' })).toBe(true);
    expect(inRange('n', { lte: 'm' })).toBe(false);
    expect(inRange(1, {})).toBe(true);
  });

  it('returns false for invalid keys instead of throwing', () => {
    expect(inRange(undefined as unknown as IDBValidKey, { gte: 1 })).toBe(false);
    expect(inRange([undefined] as unknown as IDBValidKey, ['a'])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/range.test.ts`
Expected: FAIL — cannot resolve `../src/range`.

- [ ] **Step 3: Write the implementation**

`src/range.ts`:
```ts
export type Key = IDBValidKey;
export type Bounds<K> = { gt?: K; gte?: K; lt?: K; lte?: K };
export type KeyRange<K> = K | Bounds<K>;

function isBounds(r: unknown): r is Bounds<Key> {
  return (
    typeof r === 'object' &&
    r !== null &&
    !Array.isArray(r) &&
    !(r instanceof Date) &&
    !(r instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(r)
  );
}

export function toKeyRange(r: KeyRange<Key> | undefined): IDBKeyRange | undefined {
  if (r === undefined) return undefined;
  if (!isBounds(r)) return IDBKeyRange.only(r);
  const lower = r.gte ?? r.gt;
  const upper = r.lte ?? r.lt;
  const lowerOpen = r.gte === undefined;
  const upperOpen = r.lte === undefined;
  if (lower === undefined && upper === undefined) return undefined;
  if (upper === undefined) return IDBKeyRange.lowerBound(lower, lowerOpen);
  if (lower === undefined) return IDBKeyRange.upperBound(upper, upperOpen);
  return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
}

export function inRange(key: Key, r: KeyRange<Key>): boolean {
  try {
    if (!isBounds(r)) return indexedDB.cmp(key, r) === 0;
    const lower = r.gte ?? r.gt;
    const upper = r.lte ?? r.lt;
    if (lower !== undefined) {
      const c = indexedDB.cmp(key, lower);
      if (c < 0 || (c === 0 && r.gte === undefined)) return false;
    }
    if (upper !== undefined) {
      const c = indexedDB.cmp(key, upper);
      if (c > 0 || (c === 0 && r.lte === undefined)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm vitest run test/range.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/range.ts test/range.test.ts
git commit -m "feat: key range conversion and membership"
```

---

### Task 4: Schema types, defineStores, compileSchema, public interfaces

**Files:**
- Create: `src/schema.ts`, `src/types.ts`, `test/schema.test.ts`, `test/schema.test-d.ts`

**Interfaces:**
- Produces (runtime): `defineStores<S>()(config)` identity function; `compileSchema(stores): CompiledSchema` where
  `CompiledStore = { key: string; autoIncrement: boolean; indexes: Record<string, { path: string | string[]; unique: boolean; multiEntry: boolean }>; fields: string[] }` and `CompiledSchema = Record<string, CompiledStore>`. `fields` = key field plus every index field, deduplicated, key first.
- Produces (types): everything in the two files below, verbatim. Later tasks import from these files and must not change the signatures.

- [ ] **Step 1: Write the failing runtime test**

`test/schema.test.ts`:
```ts
import { expect, it } from 'vitest';
import { compileSchema, defineStores } from '../src/schema';

it('defineStores returns the config unchanged', () => {
  const cfg = { users: { key: 'id' } } as const;
  expect(defineStores<{ users: { id: string } }>()(cfg)).toBe(cfg);
});

it('compileSchema normalizes indexes and collects fields', () => {
  const compiled = compileSchema({
    users: { key: 'id', indexes: { byEmail: { path: 'email', unique: true }, byAge: 'age' } },
    posts: { key: 'id', autoIncrement: true, indexes: { byAuthorDate: ['authorId', 'createdAt'], byAuthor: 'authorId' } },
    tags: { key: 'name' },
  });
  expect(compiled.users).toEqual({
    key: 'id',
    autoIncrement: false,
    indexes: {
      byEmail: { path: 'email', unique: true, multiEntry: false },
      byAge: { path: 'age', unique: false, multiEntry: false },
    },
    fields: ['id', 'email', 'age'],
  });
  expect(compiled.posts).toEqual({
    key: 'id',
    autoIncrement: true,
    indexes: {
      byAuthorDate: { path: ['authorId', 'createdAt'], unique: false, multiEntry: false },
      byAuthor: { path: 'authorId', unique: false, multiEntry: false },
    },
    fields: ['id', 'authorId', 'createdAt'],
  });
  expect(compiled.tags).toEqual({ key: 'name', autoIncrement: false, indexes: {}, fields: ['name'] });
});
```

- [ ] **Step 2: Write the failing type test**

`test/schema.test-d.ts`:
```ts
import { expectTypeOf, test } from 'vitest';
import { defineStores, type IndexKey, type IndexName, type KeyOf, type PutValue } from '../src/schema';

type User = { id: string; email: string; age: number };
type Post = { id: number; authorId: string; createdAt: number; title: string };
type Schema = { users: User; posts: Post };

test('derived schema types', () => {
  const stores = defineStores<Schema>()({
    users: { key: 'id', indexes: { byEmail: { path: 'email', unique: true }, byAge: 'age' } },
    posts: { key: 'id', autoIncrement: true, indexes: { byAuthorDate: ['authorId', 'createdAt'] } },
  });
  type C = typeof stores;

  expectTypeOf<KeyOf<Schema, C, 'users'>>().toEqualTypeOf<string>();
  expectTypeOf<KeyOf<Schema, C, 'posts'>>().toEqualTypeOf<number>();
  expectTypeOf<IndexName<C, 'users'>>().toEqualTypeOf<'byEmail' | 'byAge'>();
  expectTypeOf<IndexName<C, 'posts'>>().toEqualTypeOf<'byAuthorDate'>();
  expectTypeOf<IndexKey<Schema, C, 'users', 'byAge'>>().toEqualTypeOf<number>();
  expectTypeOf<IndexKey<Schema, C, 'users', 'byEmail'>>().toEqualTypeOf<string>();
  expectTypeOf<IndexKey<Schema, C, 'posts', 'byAuthorDate'>>().toEqualTypeOf<readonly [string, number]>();
  expectTypeOf<PutValue<Schema, C, 'users'>>().toEqualTypeOf<User>();
  expectTypeOf<PutValue<Schema, C, 'posts'>>().toMatchTypeOf<{ id?: number; authorId: string; createdAt: number; title: string }>();
});

test('field names are checked', () => {
  defineStores<Schema>()({
    users: { key: 'id', indexes: {
      // @ts-expect-error typo in field name
      byEmail: 'emial',
    } },
    posts: { key: 'id' },
  });
  defineStores<Schema>()({
    // @ts-expect-error key must be a field of User
    users: { key: 'nope' },
    posts: { key: 'id' },
  });
  defineStores<Schema>()({
    users: { key: 'id', indexes: {
      // @ts-expect-error composite index with unknown field
      byX: ['email', 'nope'],
    } },
    posts: { key: 'id' },
  });
  // @ts-expect-error every store in Schema must be configured
  defineStores<Schema>()({ users: { key: 'id' } });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run test/schema.test.ts test/schema.test-d.ts`
Expected: FAIL — cannot resolve `../src/schema`.

- [ ] **Step 4: Write src/schema.ts**

```ts
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

export function compileSchema(stores: Record<string, StoreConfig<Record<string, unknown>>>): CompiledSchema {
  const out: CompiledSchema = {};
  for (const name in stores) {
    const s = stores[name];
    const indexes: Record<string, CompiledIndex> = {};
    const fields = new Set<string>([s.key]);
    for (const iname in s.indexes ?? {}) {
      const cfg = s.indexes![iname];
      const o = typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : { path: cfg };
      const path = o.path as string | readonly string[];
      const list = typeof path === 'string' ? [path] : [...path];
      indexes[iname] = { path: typeof path === 'string' ? path : list, unique: !!o.unique, multiEntry: !!o.multiEntry };
      for (const f of list) fields.add(f);
    }
    out[name] = { key: s.key, autoIncrement: !!s.autoIncrement, indexes, fields: [...fields] };
  }
  return out;
}
```

- [ ] **Step 5: Write src/types.ts (public interfaces, no runtime)**

```ts
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
```

- [ ] **Step 6: Run tests**

Run: `pnpm typecheck && pnpm vitest run test/schema.test.ts test/schema.test-d.ts`
Expected: PASS for both files. If a `@ts-expect-error` is reported as unused, the corresponding type check is broken — fix the type, do not delete the directive.

- [ ] **Step 7: Commit**

```bash
git add src/schema.ts src/types.ts test/schema.test.ts test/schema.test-d.ts
git commit -m "feat: schema config types, defineStores, compileSchema, public interfaces"
```

---

### Task 5: Cursor iterator and transaction operations

**Files:**
- Create: `src/cursor.ts`, `src/tx.ts`, `test/tx.test.ts`

**Interfaces:**
- Consumes: `request`, `run`, `IdbError` (Task 2); `toKeyRange`, `Key`, `KeyRange` (Task 3); `Cursor`, `ChangeEntry` (Task 4).
- Produces:
  - `iterate<V>(source: IDBObjectStore | IDBIndex, range: IDBKeyRange | undefined, direction: IDBCursorDirection | undefined, limit: number | undefined, store: string, hooks?: CursorHooks): AsyncGenerator<Cursor<V>>` with `CursorHooks = { onUpdate(pk: Key, before: unknown, after: unknown): void; onDelete(pk: Key, before: unknown): void }`.
  - `type Ctx = { events?: Events }` — `Events` is defined in Task 8; until then the type import is to a file that does not exist, so **in this task declare a minimal local interface** `EventsLike = { needsBefore(store: string): boolean; pick(store: string, value: unknown): IndexValues; emit(changes: Pending[]): void }` in `src/tx.ts` and use it as `Ctx = { events?: EventsLike }`. Task 8 replaces it with the real import.
  - `type AnyQuery = { index?: string; range?: KeyRange<Key>; limit?: number; direction?: IDBCursorDirection }`
  - `type Pending = { store: string; keys: Key[] | null; entries: ChangeEntry[] }`
  - `class TransactionImpl` — constructor `(raw: IDBTransaction, ctx: Ctx)`; members `raw`, `done`, `abort()`, `get`, `getAll`, `getAllKeys`, `count`, `iterate`, `put`, `add`, `delete`, `clear`, all loosely typed (`store: string`, values `unknown`).
  - `class UpgradeTransactionImpl extends TransactionImpl` — constructor `(raw, oldVersion: number, newVersion: number)`, adds `deleteStore(name)`.

- [ ] **Step 1: Write the failing test**

`test/tx.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { IdbError } from '../src/errors';
import { TransactionImpl, UpgradeTransactionImpl } from '../src/tx';
import { openRaw, resetIndexedDB } from './helpers';

type User = { id: string; name: string; age: number };

let db: IDBDatabase;
beforeEach(async () => {
  resetIndexedDB();
  db = await openRaw('tx', (d) => {
    const users = d.createObjectStore('users', { keyPath: 'id' });
    users.createIndex('byAge', 'age');
    d.createObjectStore('posts', { keyPath: 'id', autoIncrement: true });
  });
});

const rw = (...stores: string[]) => new TransactionImpl(db.transaction(stores, 'readwrite'), {});
const ro = (...stores: string[]) => new TransactionImpl(db.transaction(stores, 'readonly'), {});

async function seed() {
  const tx = rw('users');
  await tx.put('users', { id: 'a', name: 'Ann', age: 30 });
  await tx.put('users', { id: 'b', name: 'Bob', age: 20 });
  await tx.put('users', { id: 'c', name: 'Cid', age: 40 });
  await tx.done;
}

describe('writes', () => {
  it('put returns the key and done resolves after commit', async () => {
    const tx = rw('users');
    expect(await tx.put('users', { id: 'a', name: 'Ann', age: 1 })).toBe('a');
    await tx.done;
    expect(await ro('users').get('users', 'a')).toEqual({ id: 'a', name: 'Ann', age: 1 });
  });

  it('add returns a generated key and rejects on duplicate', async () => {
    const tx = rw('posts');
    expect(await tx.add('posts', { title: 'x' })).toBe(1);
    await tx.done;
    const tx2 = rw('posts');
    await expect(tx2.add('posts', { id: 1, title: 'dup' })).rejects.toBeInstanceOf(IdbError);
  });

  it('delete and clear', async () => {
    await seed();
    const tx = rw('users');
    await tx.delete('users', 'a');
    await tx.done;
    expect(await ro('users').count('users')).toBe(2);
    const tx2 = rw('users');
    await tx2.clear('users');
    await tx2.done;
    expect(await ro('users').count('users')).toBe(0);
  });

  it('write in a readonly transaction rejects with IdbError', async () => {
    await expect(ro('users').put('users', { id: 'z', name: '', age: 0 })).rejects.toBeInstanceOf(IdbError);
  });
});

describe('reads', () => {
  beforeEach(seed);

  it('get returns undefined for a missing key', async () => {
    expect(await ro('users').get('users', 'nope')).toBeUndefined();
  });

  it('getAll by primary key range and by index range with limit', async () => {
    expect((await ro('users').getAll('users')).map((u: User) => u.id)).toEqual(['a', 'b', 'c']);
    expect((await ro('users').getAll('users', { range: { gte: 'b' } })).map((u: User) => u.id)).toEqual(['b', 'c']);
    expect((await ro('users').getAll('users', { index: 'byAge', range: { gte: 30 } })).map((u: User) => u.id)).toEqual(['a', 'c']);
    expect((await ro('users').getAll('users', { index: 'byAge', limit: 2 })).map((u: User) => u.id)).toEqual(['b', 'a']);
  });

  it('getAllKeys and count', async () => {
    expect(await ro('users').getAllKeys('users', { index: 'byAge' })).toEqual(['b', 'a', 'c']);
    expect(await ro('users').count('users', { index: 'byAge', range: { lt: 40 } })).toBe(2);
  });

  it('unknown store throws IdbError with the store name', async () => {
    await expect(ro('users').get('posts', 1)).rejects.toMatchObject({ name: 'IdbError', store: 'posts' });
  });
});

describe('done and abort', () => {
  it('abort rejects done and discards writes', async () => {
    const tx = rw('users');
    await tx.put('users', { id: 'x', name: 'X', age: 1 });
    tx.abort();
    await expect(tx.done).rejects.toBeInstanceOf(IdbError);
    expect(await ro('users').count('users')).toBe(0);
  });

  it('a failed request aborts the transaction and rejects done', async () => {
    const tx = rw('posts');
    await tx.add('posts', { id: 1 });
    await tx.add('posts', { id: 1 }).catch(() => {});
    await expect(tx.done).rejects.toBeInstanceOf(IdbError);
  });
});

describe('iterate', () => {
  beforeEach(seed);

  it('walks an index in reverse with a range', async () => {
    const seen: [unknown, unknown][] = [];
    for await (const cur of ro('users').iterate('users', { index: 'byAge', range: { lte: 30 }, direction: 'prev' })) {
      seen.push([cur.key, cur.primaryKey]);
    }
    expect(seen).toEqual([[30, 'a'], [20, 'b']]);
  });

  it('honours limit and break', async () => {
    const limited: unknown[] = [];
    for await (const cur of ro('users').iterate('users', { limit: 2 })) limited.push(cur.primaryKey);
    expect(limited).toEqual(['a', 'b']);
    const tx = ro('users');
    for await (const cur of tx.iterate('users')) { limited.push(cur.primaryKey); break; }
    await tx.done;
    expect(limited).toEqual(['a', 'b', 'a']);
  });

  it('update and delete through the cursor', async () => {
    const tx = rw('users');
    // Update a non-indexed field so the index cursor does not revisit the record.
    for await (const cur of tx.iterate('users', { index: 'byAge' })) {
      if (cur.primaryKey === 'b') await cur.delete();
      else await cur.update({ ...(cur.value as User), name: (cur.value as User).name.toUpperCase() });
    }
    await tx.done;
    expect(await ro('users').getAll('users')).toEqual([
      { id: 'a', name: 'ANN', age: 30 },
      { id: 'c', name: 'CID', age: 40 },
    ]);
  });
});

describe('UpgradeTransactionImpl', () => {
  it('exposes versions and can delete a store', async () => {
    db.close();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('tx', 2);
      req.onupgradeneeded = (e) => {
        const tx = new UpgradeTransactionImpl(req.transaction!, e.oldVersion, e.newVersion!);
        expect(tx.oldVersion).toBe(1);
        expect(tx.newVersion).toBe(2);
        tx.deleteStore('posts');
      };
      req.onsuccess = () => {
        expect(Array.from(req.result.objectStoreNames)).toEqual(['users']);
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/tx.test.ts`
Expected: FAIL — cannot resolve `../src/tx`.

- [ ] **Step 3: Write src/cursor.ts**

```ts
import { request } from './errors';
import type { Key } from './range';
import type { Cursor } from './types';

export type CursorHooks = {
  onUpdate(primaryKey: Key, before: unknown, after: unknown): void;
  onDelete(primaryKey: Key, before: unknown): void;
};

/**
 * Async iteration over an IndexedDB cursor. Awaiting only IndexedDB requests inside the loop keeps
 * the transaction alive; awaiting anything else (fetch, timers) closes it and the next `continue()` throws.
 */
export async function* iterate<V>(
  source: IDBObjectStore | IDBIndex,
  range: IDBKeyRange | undefined,
  direction: IDBCursorDirection | undefined,
  limit: number | undefined,
  store: string,
  hooks?: CursorHooks,
): AsyncGenerator<Cursor<V>, void, undefined> {
  const req = source.openCursor(range, direction);
  let cur = await request(req, store, 'iterate');
  let n = 0;
  while (cur) {
    const c = cur;
    const before = c.value as V;
    yield {
      key: c.key,
      primaryKey: c.primaryKey,
      value: before,
      async update(value) {
        await request(c.update(value), store, 'update');
        hooks?.onUpdate(c.primaryKey, before, value);
      },
      async delete() {
        await request(c.delete(), store, 'delete');
        hooks?.onDelete(c.primaryKey, before);
      },
    };
    if (limit !== undefined && ++n >= limit) return;
    c.continue();
    cur = await request(req, store, 'iterate');
  }
}
```

- [ ] **Step 4: Write src/tx.ts**

```ts
import { iterate } from './cursor';
import { IdbError, request, run } from './errors';
import { toKeyRange, type Key, type KeyRange } from './range';
import type { ChangeEntry, Cursor, IndexValues } from './types';

export type AnyQuery = { index?: string; range?: KeyRange<Key>; limit?: number; direction?: IDBCursorDirection };
export type Pending = { store: string; keys: Key[] | null; entries: ChangeEntry[] };

/** Replaced by the real `Events` import in the events task. */
export type EventsLike = {
  needsBefore(store: string): boolean;
  pick(store: string, value: unknown): IndexValues;
  emit(changes: Pending[]): void;
};
export type Ctx = { events?: EventsLike };

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

  private store(name: string): IDBObjectStore {
    try {
      return this.raw.objectStore(name);
    } catch (cause) {
      throw new IdbError(`Store "${name}" is not part of this transaction`, { cause, store: name });
    }
  }

  private source(name: string, index?: string): IDBObjectStore | IDBIndex {
    const s = this.store(name);
    return index ? s.index(index) : s;
  }

  get(store: string, key: Key): Promise<unknown> {
    return run(() => this.store(store).get(key), store, 'get');
  }

  getAll(store: string, opts: AnyQuery = {}): Promise<unknown[]> {
    return run(() => this.source(store, opts.index).getAll(toKeyRange(opts.range), opts.limit), store, 'getAll');
  }

  getAllKeys(store: string, opts: AnyQuery = {}): Promise<Key[]> {
    return run(() => this.source(store, opts.index).getAllKeys(toKeyRange(opts.range), opts.limit), store, 'getAllKeys');
  }

  count(store: string, opts: AnyQuery = {}): Promise<number> {
    return run(() => this.source(store, opts.index).count(toKeyRange(opts.range)), store, 'count');
  }

  iterate(store: string, opts: AnyQuery = {}): AsyncIterable<Cursor<unknown>> {
    return iterate(this.source(store, opts.index), toKeyRange(opts.range), opts.direction, opts.limit, store, {
      onUpdate: (pk, before, after) => this.record(store, pk, before, after),
      onDelete: (pk, before) => this.record(store, pk, before, undefined),
    });
  }

  async put(store: string, value: unknown): Promise<Key> {
    const s = this.store(store);
    const before = await this.readBefore(store, s, (value as Record<string, Key | undefined>)[s.keyPath as string]);
    const key = await run(() => s.put(value), store, 'put');
    this.record(store, key, before, value);
    return key;
  }

  async add(store: string, value: unknown): Promise<Key> {
    const key = await run(() => this.store(store).add(value), store, 'add');
    this.record(store, key, undefined, value);
    return key;
  }

  async delete(store: string, key: Key): Promise<void> {
    const s = this.store(store);
    const before = await this.readBefore(store, s, key);
    await run(() => s.delete(key), store, 'delete');
    this.record(store, key, before, undefined);
  }

  async clear(store: string): Promise<void> {
    await run(() => this.store(store).clear(), store, 'clear');
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
```

- [ ] **Step 5: Run tests**

Run: `pnpm typecheck && pnpm vitest run test/tx.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cursor.ts src/tx.ts test/tx.test.ts
git commit -m "feat: transaction operations and async cursor iteration"
```

---

### Task 6: openDB, structure sync, Database

**Files:**
- Create: `src/open.ts`, `test/open.test.ts`, `test/api.test-d.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `TransactionImpl`, `UpgradeTransactionImpl`, `AnyQuery`, `Ctx` (Task 5); `compileSchema`, `CompiledSchema` (Task 4); `SchemaError`, `IdbError` (Task 2); `Database`, `OpenOptions`, `Migration` (Task 4).
- Produces:
  - `openDB<S, C extends StoresConfig<S>>(name: string, opts: OpenOptions<S, C>): Promise<Database<S, C>>`
  - `class DatabaseImpl` (not exported from index) — constructor `(raw: IDBDatabase, schema: CompiledSchema, broadcast: boolean)`. In this task it has **no** events: `transaction()` passes `{}` as ctx and `subscribe()` throws `new Error('not implemented')`. Task 8 wires `Events`.
  - Migrations run in this task (the algorithm is complete); Task 7 only adds tests for them.

- [ ] **Step 1: Write the failing runtime test**

`test/open.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { IdbError, SchemaError, defineStores, openDB } from '../src';
import { resetIndexedDB } from './helpers';

type User = { id: string; email: string; age: number };
type Post = { id: number; authorId: string; createdAt: number; title: string };
type Schema = { users: User; posts: Post };

const stores = defineStores<Schema>()({
  users: { key: 'id', indexes: { byEmail: { path: 'email', unique: true }, byAge: 'age' } },
  posts: { key: 'id', autoIncrement: true, indexes: { byAuthorDate: ['authorId', 'createdAt'] } },
});

beforeEach(resetIndexedDB);

describe('openDB', () => {
  it('creates stores and indexes from the schema', async () => {
    const db = await openDB('app', { version: 1, stores, broadcast: false });
    expect(db.name).toBe('app');
    expect(db.version).toBe(1);
    expect(Array.from(db.raw.objectStoreNames)).toEqual(['posts', 'users']);
    const tx = db.raw.transaction(['users', 'posts']);
    const users = tx.objectStore('users');
    expect(Array.from(users.indexNames)).toEqual(['byAge', 'byEmail']);
    expect(users.index('byEmail').unique).toBe(true);
    expect(users.keyPath).toBe('id');
    const posts = tx.objectStore('posts');
    expect(posts.autoIncrement).toBe(true);
    expect(posts.index('byAuthorDate').keyPath).toEqual(['authorId', 'createdAt']);
    db.close();
  });

  it('rejects with SchemaError for a bad version or migration key', async () => {
    await expect(openDB('bad', { version: 0, stores })).rejects.toBeInstanceOf(SchemaError);
    await expect(openDB('bad', { version: 1.5, stores })).rejects.toBeInstanceOf(SchemaError);
    await expect(openDB('bad', { version: 1, stores, migrations: { 2: () => {} } })).rejects.toBeInstanceOf(SchemaError);
  });

  it('rejects with IdbError when opening an older version than exists', async () => {
    (await openDB('v', { version: 2, stores, broadcast: false })).close();
    await expect(openDB('v', { version: 1, stores, broadcast: false })).rejects.toBeInstanceOf(IdbError);
  });
});

describe('Database operations', () => {
  it('single operations and explicit transactions', async () => {
    const db = await openDB('ops', { version: 1, stores, broadcast: false });
    expect(await db.put('users', { id: 'a', email: 'a@x', age: 30 })).toBe('a');
    expect(await db.add('posts', { authorId: 'a', createdAt: 1, title: 't' })).toBe(1);
    expect(await db.get('users', 'a')).toEqual({ id: 'a', email: 'a@x', age: 30 });
    expect(await db.getAll('users', { index: 'byAge', range: { gte: 18 } })).toHaveLength(1);
    expect(await db.getAllKeys('posts', { index: 'byAuthorDate', range: { gte: ['a', 0] } })).toEqual([1]);
    expect(await db.count('users')).toBe(1);

    const tx = db.transaction(['users', 'posts'], 'readwrite');
    await tx.put('users', { id: 'b', email: 'b@x', age: 20 });
    await tx.put('posts', { id: 1, authorId: 'b', createdAt: 2, title: 'u' });
    await tx.done;
    expect(await db.count('users')).toBe(2);
    expect((await db.get('posts', 1))!.authorId).toBe('b');

    await db.delete('users', 'a');
    expect(await db.get('users', 'a')).toBeUndefined();
    await db.clear('users');
    expect(await db.count('users')).toBe(0);
    db.close();
  });

  it('db.iterate supports update without an explicit transaction', async () => {
    const db = await openDB('it', { version: 1, stores, broadcast: false });
    await db.put('users', { id: 'a', email: 'a@x', age: 30 });
    for await (const cur of db.iterate('users')) await cur.update({ ...cur.value, age: 31 });
    expect((await db.get('users', 'a'))!.age).toBe(31);
    db.close();
  });

  it('close releases the connection so a newer version can open', async () => {
    const db = await openDB('close', { version: 1, stores, broadcast: false });
    db.close();
    const db2 = await openDB('close', { version: 2, stores, broadcast: false });
    expect(db2.version).toBe(2);
    db2.close();
  });
});
```

- [ ] **Step 2: Write the failing type test**

`test/api.test-d.ts`:
```ts
import { expectTypeOf, test } from 'vitest';
import { defineStores, openDB } from '../src';

type User = { id: string; email: string; age: number };
type Post = { id: number; authorId: string; createdAt: number; title: string };
type Schema = { users: User; posts: Post };

const stores = defineStores<Schema>()({
  users: { key: 'id', indexes: { byEmail: { path: 'email', unique: true }, byAge: 'age' } },
  posts: { key: 'id', autoIncrement: true, indexes: { byAuthorDate: ['authorId', 'createdAt'] } },
});

test('database API is typed by the schema', async () => {
  const db = await openDB('app', { version: 1, stores });

  expectTypeOf(await db.get('users', 'u1')).toEqualTypeOf<User | undefined>();
  expectTypeOf(await db.put('posts', { authorId: 'a', createdAt: 1, title: 't' })).toEqualTypeOf<number>();
  expectTypeOf(await db.getAll('users', { index: 'byAge', range: { gte: 18 }, limit: 5 })).toEqualTypeOf<User[]>();
  expectTypeOf(await db.getAllKeys('users')).toEqualTypeOf<string[]>();
  await db.getAll('posts', { index: 'byAuthorDate', range: { gte: ['a', 0] } });
  await db.getAll('users', { range: 'u1' });
  await db.put('users', { id: 'u', email: 'e', age: 1 });

  // @ts-expect-error wrong key type
  db.get('users', 1);
  // @ts-expect-error unknown store
  db.get('nope', 1);
  // @ts-expect-error missing field
  await db.put('users', { id: 'u', email: 'e' });
  // @ts-expect-error wrong range type for index
  await db.getAll('users', { index: 'byAge', range: 'x' });
  // @ts-expect-error unknown index
  await db.getAll('users', { index: 'nope' });
  // @ts-expect-error primary key is string
  await db.getAll('users', { range: 5 });
  // @ts-expect-error wrong tuple order
  await db.getAll('posts', { index: 'byAuthorDate', range: { gte: [0, 'a'] } });

  for await (const cur of db.iterate('users', { index: 'byAge' })) {
    expectTypeOf(cur.key).toEqualTypeOf<number>();
    expectTypeOf(cur.primaryKey).toEqualTypeOf<string>();
    expectTypeOf(cur.value).toEqualTypeOf<User>();
    await cur.update({ ...cur.value, age: 1 });
  }

  const tx = db.transaction(['users', 'posts'], 'readwrite');
  await tx.put('users', { id: 'u', email: 'e', age: 1 });
  const tx2 = db.transaction('users');
  // @ts-expect-error posts is not part of this transaction
  await tx2.get('posts', 1);

  db.subscribe('users', () => {});
  db.subscribe('users', { key: 'u1' }, () => {});
  db.subscribe('users', { index: 'byAge', range: { gte: 18 } }, () => {});
  db.subscribe('posts', { index: 'byAuthorDate', range: { gte: ['a', 0] } }, () => {});
  // @ts-expect-error wrong key type
  db.subscribe('users', { key: 1 }, () => {});
  // @ts-expect-error wrong range type
  db.subscribe('users', { index: 'byAge', range: 'x' }, () => {});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run test/open.test.ts test/api.test-d.ts`
Expected: FAIL — `openDB` is not exported from `../src`.

- [ ] **Step 4: Write src/open.ts**

```ts
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
```

- [ ] **Step 5: Write src/index.ts**

```ts
export { openDB } from './open';
export { defineStores } from './schema';
export { IdbError, SchemaError } from './errors';
export type { Bounds, Key, KeyRange } from './range';
export type {
  IndexConfig, IndexKey, IndexName, IndexPath, IndexQuery, KeyOf, KeyQuery, PutValue, Rec,
  StoreConfig, StoreName, StoresConfig, StoresDef,
} from './schema';
export type {
  Change, ChangeEntry, Cursor, Database, IndexValues, Listener, Migration, OpenOptions,
  Reads, Transaction, Unsubscribe, UpgradeTransaction, Writes,
} from './types';
```

- [ ] **Step 6: Run tests**

Run: `pnpm typecheck && pnpm vitest run`
Expected: all runtime tests PASS; both `.test-d.ts` files PASS. The `subscribe` calls in `api.test-d.ts` only need to type-check; they are not executed.

- [ ] **Step 7: Commit**

```bash
git add src/open.ts src/index.ts test/open.test.ts test/api.test-d.ts
git commit -m "feat: openDB with schema sync and Database operations"
```

---

### Task 7: Migration behaviour tests

**Files:**
- Create: `test/migrations.test.ts`
- Modify: `src/open.ts` only if a test exposes a bug.

**Interfaces:**
- Consumes: `openDB`, `defineStores` (Task 6); `UpgradeTransaction` type.

- [ ] **Step 1: Write the tests**

`test/migrations.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdbError, defineStores, openDB, type UpgradeTransaction } from '../src';
import { openRaw, resetIndexedDB } from './helpers';

type V1User = { id: string; name: string };
type V3User = { id: string; first: string; last: string; email: string };

beforeEach(resetIndexedDB);

describe('upgrade', () => {
  it('runs migrations in order with correct versions and lets them use new stores and old indexes', async () => {
    const v1 = defineStores<{ users: V1User }>()({ users: { key: 'id', indexes: { byName: 'name' } } });
    const db1 = await openDB('m', { version: 1, stores: v1, broadcast: false });
    await db1.put('users', { id: 'a', name: 'Ann Lee' });
    db1.close();

    const calls: Array<[number, number, number]> = [];
    const v3 = defineStores<{ users: V3User; audit: { id: number; note: string } }>()({
      users: { key: 'id', indexes: { byEmail: 'email' } },
      audit: { key: 'id', autoIncrement: true },
    });
    const db3 = await openDB('m', {
      version: 3,
      stores: v3,
      broadcast: false,
      migrations: {
        3: async (tx: UpgradeTransaction) => {
          calls.push([3, tx.oldVersion, tx.newVersion]);
          // the new store already exists...
          await tx.add('audit', { note: 'migrated' });
          // ...and the old index is still there until after migrations
          expect(Array.from(tx.raw.objectStore('users').indexNames)).toContain('byName');
        },
        2: async (tx: UpgradeTransaction) => {
          calls.push([2, tx.oldVersion, tx.newVersion]);
          for await (const cur of tx.iterate('users')) {
            const { id, name } = cur.value as V1User;
            const [first, last] = name.split(' ');
            await cur.update({ id, first, last, email: `${first.toLowerCase()}@x` });
          }
        },
      },
    });
    expect(calls).toEqual([[2, 1, 3], [3, 1, 3]]);
    expect(await db3.get('users', 'a')).toEqual({ id: 'a', first: 'Ann', last: 'Lee', email: 'ann@x' });
    expect(await db3.getAll('audit')).toEqual([{ id: 1, note: 'migrated' }]);
    expect(Array.from(db3.raw.transaction('users').objectStore('users').indexNames)).toEqual(['byEmail']);
    db3.close();
  });

  it('skips migrations outside (oldVersion, newVersion]', async () => {
    const stores = defineStores<{ s: { id: number } }>()({ s: { key: 'id' } });
    (await openDB('skip', { version: 2, stores, broadcast: false })).close();
    const ran: number[] = [];
    const db = await openDB('skip', {
      version: 4,
      stores,
      broadcast: false,
      migrations: { 1: () => { ran.push(1); }, 2: () => { ran.push(2); }, 3: () => { ran.push(3); }, 4: () => { ran.push(4); } },
    });
    expect(ran).toEqual([3, 4]);
    db.close();
  });

  it('recreates an index whose definition changed', async () => {
    const a = defineStores<{ s: { id: number; tag: string } }>()({ s: { key: 'id', indexes: { byTag: 'tag' } } });
    (await openDB('idx', { version: 1, stores: a, broadcast: false })).close();
    const b = defineStores<{ s: { id: number; tag: string } }>()({ s: { key: 'id', indexes: { byTag: { path: 'tag', unique: true } } } });
    const db = await openDB('idx', { version: 2, stores: b, broadcast: false });
    expect(db.raw.transaction('s').objectStore('s').index('byTag').unique).toBe(true);
    db.close();
  });

  it('keeps stores outside the schema and warns, deleteStore removes them', async () => {
    const raw = await openRaw('extra', (d) => {
      d.createObjectStore('legacy', { keyPath: 'id' });
      d.createObjectStore('s', { keyPath: 'id' });
    });
    raw.close();
    const stores = defineStores<{ s: { id: number } }>()({ s: { key: 'id' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = await openDB('extra', { version: 2, stores, broadcast: false });
    expect(Array.from(db.raw.objectStoreNames)).toEqual(['legacy', 's']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"legacy"'));
    db.close();
    const db3 = await openDB('extra', { version: 3, stores, broadcast: false, migrations: { 3: (tx) => tx.deleteStore('legacy') } });
    expect(Array.from(db3.raw.objectStoreNames)).toEqual(['s']);
    db3.close();
    warn.mockRestore();
  });

  it('a throwing migration aborts the upgrade and rejects openDB with that error', async () => {
    const stores = defineStores<{ s: { id: number } }>()({ s: { key: 'id' } });
    const boom = new Error('boom');
    await expect(openDB('fail', { version: 1, stores, broadcast: false, migrations: { 1: () => { throw boom; } } })).rejects.toBe(boom);
    // nothing was created
    await new Promise<void>((resolve) => {
      const req = indexedDB.open('fail');
      req.onsuccess = () => { expect(req.result.version).toBe(1); expect(req.result.objectStoreNames.length).toBe(0); req.result.close(); resolve(); };
    });
  });

  it('a failed request inside a migration rejects openDB with IdbError', async () => {
    const stores = defineStores<{ s: { id: number } }>()({ s: { key: 'id' } });
    await expect(openDB('fail2', {
      version: 1, stores, broadcast: false,
      migrations: { 1: async (tx) => { await tx.add('s', { id: 1 }); await tx.add('s', { id: 1 }); } },
    })).rejects.toBeInstanceOf(IdbError);
  });

  it('onVersionChange fires on the old connection when a newer version opens', async () => {
    const stores = defineStores<{ s: { id: number } }>()({ s: { key: 'id' } });
    const onVersionChange = vi.fn();
    const db1 = await openDB('vc', { version: 1, stores, broadcast: false, onVersionChange });
    const onBlocked = vi.fn();
    const opening = openDB('vc', { version: 2, stores, broadcast: false, onBlocked });
    await vi.waitFor(() => expect(onVersionChange).toHaveBeenCalled());
    db1.close();
    const db2 = await opening;
    expect(db2.version).toBe(2);
    db2.close();
  });
});
```

Note on the last test: whether `onBlocked` fires depends on timing (`blocked` is only dispatched if the old connection has not closed by the time the request is processed). Assert only on `onVersionChange`; do not assert on `onBlocked`.

Note on the "nothing was created" check: after an aborted upgrade the database may not exist; `indexedDB.open('fail')` then creates it at version 1 with no stores, which satisfies the assertions either way.

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run test/migrations.test.ts`
Expected: PASS. If the migration-order test fails because `byName` is missing inside migration 3, the removal step in `upgrade()` is running too early — it must run after all migrations.

- [ ] **Step 3: Commit**

```bash
git add test/migrations.test.ts src/open.ts
git commit -m "test: migration ordering, index recreation, stores outside schema, version change"
```

---

### Task 8: Change events — store and key subscriptions

**Files:**
- Create: `src/events.ts`, `test/events.test.ts`
- Modify: `src/tx.ts` (replace `EventsLike` with the real `Events` type), `src/open.ts` (wire `Events` into `DatabaseImpl`)

**Interfaces:**
- Consumes: `Pending` (Task 5); `inRange`, `KeyRange`, `Key` (Task 3); `CompiledSchema` (Task 4); `Change`, `ChangeEntry`, `IndexValues`, `Listener`, `Unsubscribe` (Task 4).
- Produces:
  - `type Filter = { key: Key } | { index: string; range: KeyRange<Key> }`
  - `class Events` — constructor `(schema: CompiledSchema, channelName?: string)`; methods `pick(store, value): IndexValues`, `needsBefore(store): boolean`, `subscribe(store, filter | undefined, listener): Unsubscribe`, `emit(changes: Pending[]): void`, `close(): void`. In this task `channelName` is accepted but ignored; Task 10 adds the channel. Range filtering (`'index' in filter`) is implemented in Task 9; in this task treat an index filter like a whole-store subscription.

- [ ] **Step 1: Write the failing test**

`test/events.test.ts`:
```ts
import { beforeEach, expect, it } from 'vitest';
import { IdbError, defineStores, openDB, type Change, type Database } from '../src';
import { resetIndexedDB } from './helpers';

type User = { id: string; email: string; age: number };
const stores = defineStores<{ users: User }>()({ users: { key: 'id', indexes: { byAge: 'age' } } });

let db: Database<{ users: User }, typeof stores>;
let seen: Change[];
beforeEach(async () => {
  resetIndexedDB();
  db = await openDB('ev', { version: 1, stores, broadcast: false });
  seen = [];
});

it('store subscription receives keys and indexed fields only, after commit', async () => {
  db.subscribe('users', (c) => seen.push(c));
  await db.put('users', { id: 'a', email: 'a@x', age: 1 });
  expect(seen).toEqual([{ store: 'users', keys: ['a'], entries: [{ key: 'a', after: { id: 'a', age: 1 } }], source: 'local' }]);
});

it('groups all changes of a transaction into one event per store', async () => {
  db.subscribe('users', (c) => seen.push(c));
  const tx = db.transaction('users', 'readwrite');
  await tx.put('users', { id: 'a', email: 'a@x', age: 1 });
  await tx.add('users', { id: 'b', email: 'b@x', age: 2 });
  await tx.delete('users', 'a');
  expect(seen).toEqual([]); // nothing before commit
  await tx.done;
  expect(seen).toHaveLength(1);
  expect(seen[0].keys).toEqual(['a', 'b', 'a']);
  expect(seen[0].entries).toEqual([
    { key: 'a', after: { id: 'a', age: 1 } },
    { key: 'b', after: { id: 'b', age: 2 } },
    { key: 'a' }, // delete without range subscriptions: no old value read
  ]);
});

it('does not emit on abort', async () => {
  db.subscribe('users', (c) => seen.push(c));
  const tx = db.transaction('users', 'readwrite');
  await tx.put('users', { id: 'a', email: 'a@x', age: 1 });
  tx.abort();
  await expect(tx.done).rejects.toBeInstanceOf(IdbError);
  expect(seen).toEqual([]);
});

it('clear emits keys: null', async () => {
  db.subscribe('users', (c) => seen.push(c));
  await db.clear('users');
  expect(seen).toEqual([{ store: 'users', keys: null, entries: [], source: 'local' }]);
});

it('key subscription only sees its key', async () => {
  db.subscribe('users', { key: 'b' }, (c) => seen.push(c));
  await db.put('users', { id: 'a', email: 'a@x', age: 1 });
  expect(seen).toEqual([]);
  const tx = db.transaction('users', 'readwrite');
  await tx.put('users', { id: 'a', email: 'a@x', age: 3 });
  await tx.put('users', { id: 'b', email: 'b@x', age: 2 });
  await tx.done;
  expect(seen).toHaveLength(1);
  expect(seen[0].keys).toEqual(['b']);
  expect(seen[0].entries).toEqual([{ key: 'b', after: { id: 'b', age: 2 } }]);
  await db.clear('users');
  expect(seen[1].keys).toBeNull();
});

it('cursor update and delete are recorded', async () => {
  await db.put('users', { id: 'a', email: 'a@x', age: 1 });
  await db.put('users', { id: 'b', email: 'b@x', age: 2 });
  db.subscribe('users', (c) => seen.push(c));
  for await (const cur of db.iterate('users')) {
    if (cur.primaryKey === 'a') await cur.update({ ...cur.value, age: 10 });
    else await cur.delete();
  }
  expect(seen).toHaveLength(1);
  expect(seen[0].entries).toEqual([
    { key: 'a', before: { id: 'a', age: 1 }, after: { id: 'a', age: 10 } },
    { key: 'b', before: { id: 'b', age: 2 } },
  ]);
});

it('unsubscribe stops delivery and a throwing listener does not break others', async () => {
  const off = db.subscribe('users', () => { throw new Error('listener boom'); });
  db.subscribe('users', (c) => seen.push(c));
  await db.put('users', { id: 'a', email: 'a@x', age: 1 });
  expect(seen).toHaveLength(1);
  off();
  await db.put('users', { id: 'a', email: 'a@x', age: 2 });
  expect(seen).toHaveLength(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/events.test.ts`
Expected: FAIL — `subscribe` throws "not implemented".

- [ ] **Step 3: Write src/events.ts**

```ts
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
```

- [ ] **Step 4: Wire Events into tx.ts and open.ts**

In `src/tx.ts` replace the `EventsLike` block:
```ts
import type { Events } from './events';
export type Ctx = { events?: Events };
```
(delete the `EventsLike` type and the `IndexValues` import if now unused).

In `src/open.ts`:
```ts
import { Events, type Filter } from './events';
```
and change `DatabaseImpl`:
```ts
export class DatabaseImpl {
  private events: Events;

  constructor(readonly raw: IDBDatabase, schema: CompiledSchema, broadcast: boolean) {
    this.events = new Events(schema, broadcast ? `idbkit:${raw.name}` : undefined);
  }

  transaction(stores: string | readonly string[], mode: IDBTransactionMode = 'readonly'): TransactionImpl {
    return new TransactionImpl(this.raw.transaction(stores as string | string[], mode), { events: this.events });
  }

  subscribe(store: string, a: Filter | Listener, b?: Listener): Unsubscribe {
    return typeof a === 'function' ? this.events.subscribe(store, undefined, a) : this.events.subscribe(store, a, b!);
  }

  close(): void {
    this.events.close();
    this.raw.close();
  }
  // ...other methods unchanged
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm typecheck && pnpm vitest run`
Expected: all PASS, including earlier suites.

- [ ] **Step 6: Commit**

```bash
git add src/events.ts src/tx.ts src/open.ts test/events.test.ts
git commit -m "feat: change events with store and key subscriptions"
```

---

### Task 9: Range subscriptions with lazy old-value reads

**Files:**
- Modify: `src/events.ts` (`matches`), `test/events.test.ts` (append)

**Interfaces:**
- Consumes: `inRange` (Task 3), `CompiledSchema.indexes[i].path` (Task 4), `needsBefore` (Task 8), `readBefore` in `TransactionImpl` (Task 5).

- [ ] **Step 1: Append failing tests**

Append to `test/events.test.ts`:
```ts
import { vi } from 'vitest';

it('range subscription sees records entering, moving inside, and leaving the range', async () => {
  db.subscribe('users', { index: 'byAge', range: { gte: 18 } }, (c) => seen.push(c));
  await db.put('users', { id: 'kid', email: 'k@x', age: 5 });
  expect(seen).toEqual([]);
  await db.put('users', { id: 'a', email: 'a@x', age: 20 }); // enters
  expect(seen).toHaveLength(1);
  expect(seen[0].entries).toEqual([{ key: 'a', after: { id: 'a', age: 20 } }]);
  await db.put('users', { id: 'a', email: 'a@x', age: 25 }); // moves inside
  expect(seen).toHaveLength(2);
  expect(seen[1].entries).toEqual([{ key: 'a', before: { id: 'a', age: 20 }, after: { id: 'a', age: 25 } }]);
  await db.put('users', { id: 'a', email: 'a@x', age: 3 }); // leaves — only visible thanks to `before`
  expect(seen).toHaveLength(3);
  expect(seen[2].entries).toEqual([{ key: 'a', before: { id: 'a', age: 25 }, after: { id: 'a', age: 3 } }]);
  await db.put('users', { id: 'a', email: 'a@x', age: 4 }); // stays outside
  expect(seen).toHaveLength(3);
  await db.delete('users', 'kid'); // outside → ignored
  expect(seen).toHaveLength(3);
  await db.put('users', { id: 'b', email: 'b@x', age: 30 });
  await db.delete('users', 'b'); // delete inside range
  expect(seen).toHaveLength(5);
  expect(seen[4].entries).toEqual([{ key: 'b', before: { id: 'b', age: 30 } }]);
  await db.clear('users');
  expect(seen[5].keys).toBeNull();
});

it('composite index range subscription', async () => {
  type Post = { id: number; authorId: string; createdAt: number };
  const s = defineStores<{ posts: Post }>()({ posts: { key: 'id', autoIncrement: true, indexes: { byAuthorDate: ['authorId', 'createdAt'] } } });
  const pdb = await openDB('posts', { version: 1, stores: s, broadcast: false });
  const got: Change[] = [];
  pdb.subscribe('posts', { index: 'byAuthorDate', range: { gte: ['a', 0], lt: ['a', 100] } }, (c) => got.push(c));
  await pdb.add('posts', { authorId: 'b', createdAt: 1 });
  await pdb.add('posts', { authorId: 'a', createdAt: 500 });
  expect(got).toEqual([]);
  await pdb.add('posts', { authorId: 'a', createdAt: 50 });
  expect(got).toHaveLength(1);
  pdb.close();
});

it('reads the old value before put/delete only while a range subscription exists', async () => {
  const get = vi.spyOn(IDBObjectStore.prototype, 'get');
  await db.put('users', { id: 'a', email: 'a@x', age: 1 });
  await db.delete('users', 'a');
  expect(get).not.toHaveBeenCalled();

  const off = db.subscribe('users', { index: 'byAge', range: { gte: 0 } }, () => {});
  await db.put('users', { id: 'a', email: 'a@x', age: 1 });
  expect(get).toHaveBeenCalledTimes(1);
  await db.delete('users', 'a');
  expect(get).toHaveBeenCalledTimes(2);
  await db.add('users', { id: 'a', email: 'a@x', age: 1 }); // add never reads
  expect(get).toHaveBeenCalledTimes(2);

  off();
  await db.put('users', { id: 'a', email: 'a@x', age: 2 });
  expect(get).toHaveBeenCalledTimes(2);
  get.mockRestore();
});

it('key subscriptions do not trigger old-value reads', async () => {
  const get = vi.spyOn(IDBObjectStore.prototype, 'get');
  db.subscribe('users', { key: 'a' }, () => {});
  await db.put('users', { id: 'a', email: 'a@x', age: 1 });
  expect(get).not.toHaveBeenCalled();
  get.mockRestore();
});
```

Move the `import { vi } from 'vitest'` into the existing vitest import at the top of the file.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run test/events.test.ts`
Expected: the first two new tests FAIL (entries outside the range are delivered); the spy tests PASS already.

- [ ] **Step 3: Implement range matching**

Replace `matches` in `src/events.ts`:
```ts
  /**
   * An entry is relevant if its index key before or after the change falls in the range.
   * Without `before` we cannot tell whether the record left the range, so remote changes
   * (the other tab may not have read it) and entries with neither side are treated as relevant.
   */
  private matches(store: string, e: ChangeEntry, f: { index: string; range: KeyRange<Key> }, source: Change['source']): boolean {
    if (!e.before && (source === 'remote' || !e.after)) return true;
    const path = this.schema[store]?.indexes[f.index]?.path;
    if (!path) return true;
    const keyOf = (v: IndexValues) => (typeof path === 'string' ? v[path] : path.map((p) => v[p])) as Key;
    return (!!e.before && inRange(keyOf(e.before), f.range)) || (!!e.after && inRange(keyOf(e.after), f.range));
  }
```
Remove the `void inRange;` placeholder.

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm vitest run`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events.ts test/events.test.ts
git commit -m "feat: range subscriptions with lazy old-value reads"
```

---

### Task 10: Cross-tab broadcast

**Files:**
- Modify: `src/events.ts`
- Create: `test/broadcast.test.ts`

**Interfaces:**
- Consumes: `Events` (Task 8/9).
- Produces: `Events` opens `new BroadcastChannel(channelName)` when given a name and `BroadcastChannel` exists; `emit` posts the `Pending[]` array; incoming messages dispatch with `source: 'remote'`; `close()` closes the channel.

- [ ] **Step 1: Write the failing test**

`test/broadcast.test.ts`:
```ts
import { beforeEach, expect, it } from 'vitest';
import { defineStores, openDB, type Change } from '../src';
import { resetIndexedDB, sleep } from './helpers';

type User = { id: string; email: string; age: number };
const stores = defineStores<{ users: User }>()({ users: { key: 'id', indexes: { byAge: 'age' } } });

beforeEach(resetIndexedDB);

function nextChange(subscribe: (l: (c: Change) => void) => void): Promise<Change> {
  return new Promise((resolve) => subscribe(resolve));
}

it('a change in one connection reaches subscribers of another with source remote', async () => {
  const a = await openDB('bc', { version: 1, stores });
  const b = await openDB('bc', { version: 1, stores });
  const got = nextChange((l) => b.subscribe('users', l));
  await a.put('users', { id: 'x', email: 'x@x', age: 1 });
  expect(await got).toEqual({ store: 'users', keys: ['x'], entries: [{ key: 'x', after: { id: 'x', age: 1 } }], source: 'remote' });
  a.close();
  b.close();
});

it('the emitting connection does not receive its own broadcast twice', async () => {
  const a = await openDB('bc2', { version: 1, stores });
  const b = await openDB('bc2', { version: 1, stores });
  const seen: Change[] = [];
  a.subscribe('users', (c) => seen.push(c));
  await a.put('users', { id: 'x', email: 'x@x', age: 1 });
  await sleep(20);
  expect(seen).toHaveLength(1);
  expect(seen[0].source).toBe('local');
  a.close();
  b.close();
});

it('remote range subscription is conservative when before is missing', async () => {
  const a = await openDB('bc3', { version: 1, stores }); // no range subs here → no `before`
  const b = await openDB('bc3', { version: 1, stores });
  const got = nextChange((l) => b.subscribe('users', { index: 'byAge', range: { gte: 18 } }, l));
  await a.put('users', { id: 'kid', email: 'k@x', age: 5 }); // outside the range, but delivered anyway
  expect((await got).source).toBe('remote');
  a.close();
  b.close();
});

it('remote key subscription filters by key', async () => {
  const a = await openDB('bc4', { version: 1, stores });
  const b = await openDB('bc4', { version: 1, stores });
  const seen: Change[] = [];
  b.subscribe('users', { key: 'wanted' }, (c) => seen.push(c));
  await a.put('users', { id: 'other', email: 'o@x', age: 1 });
  await a.put('users', { id: 'wanted', email: 'w@x', age: 1 });
  await sleep(20);
  expect(seen.map((c) => c.keys)).toEqual([['wanted']]);
  a.close();
  b.close();
});

it('broadcast: false disables both sending and receiving', async () => {
  const a = await openDB('bc5', { version: 1, stores, broadcast: false });
  const b = await openDB('bc5', { version: 1, stores });
  const c = await openDB('bc5', { version: 1, stores });
  const seenB: Change[] = [];
  const seenA: Change[] = [];
  b.subscribe('users', (ch) => seenB.push(ch));
  a.subscribe('users', (ch) => seenA.push(ch));
  await a.put('users', { id: 'x', email: 'x@x', age: 1 });
  await c.put('users', { id: 'y', email: 'y@x', age: 1 });
  await sleep(20);
  expect(seenB.map((ch) => ch.keys)).toEqual([['y']]);
  expect(seenA.map((ch) => ch.keys)).toEqual([['x']]);
  a.close();
  b.close();
  c.close();
});

it('close stops receiving', async () => {
  const a = await openDB('bc6', { version: 1, stores });
  const b = await openDB('bc6', { version: 1, stores });
  const seen: Change[] = [];
  b.subscribe('users', (c) => seen.push(c));
  b.close();
  await a.put('users', { id: 'x', email: 'x@x', age: 1 });
  await sleep(20);
  expect(seen).toEqual([]);
  a.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/broadcast.test.ts`
Expected: the first, third and fourth tests time out or fail (nothing is broadcast yet).

- [ ] **Step 3: Add the channel to Events**

In `src/events.ts`:
```ts
export class Events {
  private subs = new Set<Sub>();
  private channel?: BroadcastChannel;

  constructor(private schema: CompiledSchema, channelName?: string) {
    if (channelName && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(channelName);
      this.channel.onmessage = (e: MessageEvent<Pending[]>) => this.dispatch(e.data, 'remote');
    }
  }

  emit(changes: Pending[]): void {
    this.dispatch(changes, 'local');
    this.channel?.postMessage(changes);
  }

  close(): void {
    this.channel?.close();
    this.subs.clear();
  }
  // pick, needsBefore, subscribe, dispatch, narrow, matches unchanged
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm vitest run`
Expected: all PASS. Node's `BroadcastChannel` delivers to other instances in the same thread (verified during planning); delivery is asynchronous, which is why the tests await a promise or `sleep`.

- [ ] **Step 5: Commit**

```bash
git add src/events.ts test/broadcast.test.ts
git commit -m "feat: cross-tab change broadcast via BroadcastChannel"
```

---

### Task 11: Build, size budget, README

**Files:**
- Create: `README.md`
- Modify: `package.json` only if size-limit needs configuration changes.

- [ ] **Step 1: Build and measure**

Run: `pnpm build && pnpm size`
Expected: `dist/index.js` and `dist/index.d.ts` exist; size-limit reports ≤ 3 KB gzip.

If over budget: report the exact number and the largest contributors (`npx size-limit --why` opens a treemap). Acceptable shrink moves, in order: drop `JSON.stringify` index comparison in favour of a small `sameKeyPath()` helper; shorten error messages; merge `run` into `request`. Do not remove behaviour covered by tests. If still over 3 KB after those, stop and report — raising the budget is the user's decision.

- [ ] **Step 2: Check the published surface**

Run: `node -e "import('./dist/index.js').then(m => console.log(Object.keys(m)))"`
Expected: `[ 'IdbError', 'SchemaError', 'defineStores', 'openDB' ]`.

Run: `grep -c "export interface Database" dist/index.d.ts`
Expected: `1`.

- [ ] **Step 3: Write README.md**

~~~~markdown
# idbkit

Tiny typed toolkit for IndexedDB. Core: ~3 KB gzip, zero dependencies, ESM.

- Schema in TypeScript, field names checked by the compiler
- Declarative structure sync plus data migrations per version
- Promise-based operations, explicit transactions, async cursors
- Change events per store, per key, or per index range — across tabs

## Install

```bash
pnpm add idbkit
```

## Usage

```ts
import { defineStores, openDB } from 'idbkit';

type User = { id: string; email: string; age: number };
type Post = { id: number; authorId: string; createdAt: number; title: string };

const stores = defineStores<{ users: User; posts: Post }>()({
  users: { key: 'id', indexes: { byEmail: { path: 'email', unique: true }, byAge: 'age' } },
  posts: { key: 'id', autoIncrement: true, indexes: { byAuthorDate: ['authorId', 'createdAt'] } },
});

const db = await openDB('app', {
  version: 2,
  stores,
  migrations: {
    2: async (tx) => {
      for await (const cur of tx.iterate('users')) {
        await cur.update({ ...cur.value, age: Number(cur.value.age) });
      }
    },
  },
});

await db.put('users', { id: 'u1', email: 'a@b.c', age: 30 });
const adults = await db.getAll('users', { index: 'byAge', range: { gte: 18 } });

const tx = db.transaction(['users', 'posts'], 'readwrite');
await tx.put('posts', { authorId: 'u1', createdAt: Date.now(), title: 'Hi' });
await tx.done;

const off = db.subscribe('posts', { index: 'byAuthorDate', range: { gte: ['u1', 0] } }, (change) => {
  console.log(change.keys, change.source); // 'local' | 'remote'
});
```

`defineStores<Schema>()` is called twice on purpose: TypeScript cannot infer the config's literal type while `Schema` is given explicitly.

## Migrations

On upgrade idbkit first creates missing stores and indexes (and recreates indexes whose definition changed), then runs `migrations[v]` for every `v` in `(oldVersion, newVersion]` in ascending order, then removes indexes that are no longer in the schema. Stores that exist but are not in the schema are kept; remove them with `tx.deleteStore(name)` inside a migration.

Inside a migration only `await` operations of the migration transaction. Awaiting anything else (fetch, timers) closes the transaction.

## Change events

Events carry only the key and indexed fields of affected records, never full records. A range subscription needs the old value to notice a record leaving the range; idbkit reads it before `put`/`delete` only while such a subscription exists on that store. Across tabs, if the writing tab had no range subscription, range subscribers in other tabs receive the change regardless and should re-query.

## Cursors

`db.iterate(store, opts)` opens a readwrite transaction so `cursor.update()` and `cursor.delete()` work. Standard IndexedDB caveat: updating a record through an index cursor so that its index key moves ahead in iteration order makes the cursor visit it again.

## License

MIT
~~~~

- [ ] **Step 4: Full check and commit**

Run: `pnpm check`
Expected: typecheck clean, all tests pass, build succeeds, size within budget.

```bash
git add -A
git commit -m "docs: README; verify build and size budget"
```
