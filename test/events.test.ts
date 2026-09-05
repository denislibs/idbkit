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
