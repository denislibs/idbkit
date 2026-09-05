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

`db.iterate(store, opts)` opens a readwrite transaction so `cursor.update()` and `cursor.delete()` work. Standard IndexedDB caveat: updating a record through an index cursor so that its index key moves ahead in iteration order makes the cursor visit it again. `db.iterate` awaits the transaction's commit on every exit path, including `break`, so any change events from the loop have already been delivered by the time it returns; a broadcast failure is logged and never affects the write.

## License

MIT
