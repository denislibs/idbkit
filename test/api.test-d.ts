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
