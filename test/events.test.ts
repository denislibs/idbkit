import { beforeEach, expect, it, vi } from 'vitest';
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

it('db.iterate delivers events before the loop exits, also on break', async () => {
  await db.put('users', { id: 'a', email: 'a@x', age: 1 });
  await db.put('users', { id: 'b', email: 'b@x', age: 2 });
  db.subscribe('users', (c) => seen.push(c));
  for await (const cur of db.iterate('users')) {
    await cur.update({ ...cur.value, age: 10 });
    break;
  }
  expect(seen).toHaveLength(1);
  expect(seen[0].keys).toEqual(['a']);
});

it('an error thrown inside a db.iterate loop is not masked by the abort', async () => {
  await db.put('users', { id: 'a', email: 'a@x', age: 1 });
  const boom = new Error('boom');
  await expect(
    (async () => {
      for await (const cur of db.iterate('users')) {
        await cur.update({ ...cur.value, age: 10 });
        throw boom;
      }
    })(),
  ).rejects.toBe(boom);
});

it('unsubscribe stops delivery and a throwing listener does not break others', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const off = db.subscribe('users', () => { throw new Error('listener boom'); });
  db.subscribe('users', (c) => seen.push(c));
  await db.put('users', { id: 'a', email: 'a@x', age: 1 });
  expect(seen).toHaveLength(1);
  off();
  await db.put('users', { id: 'a', email: 'a@x', age: 2 });
  expect(seen).toHaveLength(2);
  consoleError.mockRestore();
});

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

it('an invalid key rejects with IdbError when a range subscription forces an old-value read', async () => {
  db.subscribe('users', { index: 'byAge', range: { gte: 0 } }, () => {});
  await expect(db.put('users', { id: {} as unknown as string, email: 'e', age: 1 })).rejects.toBeInstanceOf(IdbError);
});
