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

  it('operations after close reject with IdbError instead of throwing', async () => {
    const db = await openDB('closed', { version: 1, stores, broadcast: false });
    db.close();
    await expect(db.get('users', 'a')).rejects.toBeInstanceOf(IdbError);
    await expect(db.getAll('users')).rejects.toBeInstanceOf(IdbError);
    await expect(db.count('users')).rejects.toBeInstanceOf(IdbError);
    await expect(db.put('users', { id: 'a', email: 'a@x', age: 1 })).rejects.toBeInstanceOf(IdbError);
    await expect(db.iterate('users')[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(IdbError);
    expect(() => db.transaction('users')).toThrow(IdbError);
  });
});
