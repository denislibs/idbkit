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
