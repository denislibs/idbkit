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
