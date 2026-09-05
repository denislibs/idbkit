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
