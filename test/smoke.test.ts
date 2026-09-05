import { beforeEach, expect, it } from 'vitest';
import { openRaw, resetIndexedDB } from './helpers';

beforeEach(resetIndexedDB);

it('fake-indexeddb is wired up', async () => {
  const db = await openRaw('smoke', (d) => d.createObjectStore('s', { keyPath: 'id' }));
  expect(Array.from(db.objectStoreNames)).toEqual(['s']);
  db.close();
});
