import { beforeEach, expect, it } from 'vitest';
import { IdbError, SchemaError, request } from '../src/errors';
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

it('request(thunk) converts a synchronous throw into an IdbError rejection', async () => {
  const db = await openRaw('e3', (d) => d.createObjectStore('s', { keyPath: 'id' }));
  const store = db.transaction('s', 'readonly').objectStore('s');
  const err = await request(() => store.put({ id: 1 }), 's', 'put').catch((e: unknown) => e);
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
