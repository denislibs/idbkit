import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdbError, defineStores, openDB, type UpgradeTransaction } from '../src';
import { openRaw, resetIndexedDB } from './helpers';

type V1User = { id: string; name: string };
type V3User = { id: string; first: string; last: string; email: string };

beforeEach(resetIndexedDB);

describe('upgrade', () => {
  it('runs migrations in order with correct versions and lets them use new stores and old indexes', async () => {
    const v1 = defineStores<{ users: V1User }>()({ users: { key: 'id', indexes: { byName: 'name' } } });
    const db1 = await openDB('m', { version: 1, stores: v1, broadcast: false });
    await db1.put('users', { id: 'a', name: 'Ann Lee' });
    db1.close();

    const calls: Array<[number, number, number]> = [];
    const v3 = defineStores<{ users: V3User; audit: { id: number; note: string } }>()({
      users: { key: 'id', indexes: { byEmail: 'email' } },
      audit: { key: 'id', autoIncrement: true },
    });
    const db3 = await openDB('m', {
      version: 3,
      stores: v3,
      broadcast: false,
      migrations: {
        3: async (tx: UpgradeTransaction) => {
          calls.push([3, tx.oldVersion, tx.newVersion]);
          // the new store already exists...
          await tx.add('audit', { note: 'migrated' });
          // ...and the old index is still there until after migrations
          expect(Array.from(tx.raw.objectStore('users').indexNames)).toContain('byName');
        },
        2: async (tx: UpgradeTransaction) => {
          calls.push([2, tx.oldVersion, tx.newVersion]);
          for await (const cur of tx.iterate('users')) {
            const { id, name } = cur.value as V1User;
            const [first, last] = name.split(' ');
            await cur.update({ id, first, last, email: `${first.toLowerCase()}@x` });
          }
        },
      },
    });
    expect(calls).toEqual([[2, 1, 3], [3, 1, 3]]);
    expect(await db3.get('users', 'a')).toEqual({ id: 'a', first: 'Ann', last: 'Lee', email: 'ann@x' });
    expect(await db3.getAll('audit')).toEqual([{ id: 1, note: 'migrated' }]);
    expect(Array.from(db3.raw.transaction('users').objectStore('users').indexNames)).toEqual(['byEmail']);
    db3.close();
  });

  it('skips migrations outside (oldVersion, newVersion]', async () => {
    const stores = defineStores<{ s: { id: number } }>()({ s: { key: 'id' } });
    (await openDB('skip', { version: 2, stores, broadcast: false })).close();
    const ran: number[] = [];
    const db = await openDB('skip', {
      version: 4,
      stores,
      broadcast: false,
      migrations: { 1: () => { ran.push(1); }, 2: () => { ran.push(2); }, 3: () => { ran.push(3); }, 4: () => { ran.push(4); } },
    });
    expect(ran).toEqual([3, 4]);
    db.close();
  });

  it('recreates an index whose definition changed', async () => {
    const a = defineStores<{ s: { id: number; tag: string } }>()({ s: { key: 'id', indexes: { byTag: 'tag' } } });
    (await openDB('idx', { version: 1, stores: a, broadcast: false })).close();
    const b = defineStores<{ s: { id: number; tag: string } }>()({ s: { key: 'id', indexes: { byTag: { path: 'tag', unique: true } } } });
    const db = await openDB('idx', { version: 2, stores: b, broadcast: false });
    expect(db.raw.transaction('s').objectStore('s').index('byTag').unique).toBe(true);
    db.close();
  });

  it('recreates an index whose path changes between array and string form', async () => {
    const a = defineStores<{ s: { id: number; tag: string } }>()({ s: { key: 'id', indexes: { byTag: ['tag'] } } });
    (await openDB('pathform', { version: 1, stores: a, broadcast: false })).close();
    const b = defineStores<{ s: { id: number; tag: string } }>()({ s: { key: 'id', indexes: { byTag: 'tag' } } });
    const db = await openDB('pathform', { version: 2, stores: b, broadcast: false });
    expect(db.raw.transaction('s').objectStore('s').index('byTag').keyPath).toBe('tag');
    db.close();
  });

  it('keeps stores outside the schema and warns, deleteStore removes them', async () => {
    const raw = await openRaw('extra', (d) => {
      d.createObjectStore('legacy', { keyPath: 'id' });
      d.createObjectStore('s', { keyPath: 'id' });
    });
    raw.close();
    const stores = defineStores<{ s: { id: number } }>()({ s: { key: 'id' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = await openDB('extra', { version: 2, stores, broadcast: false });
      expect(Array.from(db.raw.objectStoreNames)).toEqual(['legacy', 's']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"legacy"'));
      db.close();
      const db3 = await openDB('extra', { version: 3, stores, broadcast: false, migrations: { 3: (tx) => tx.deleteStore('legacy') } });
      expect(Array.from(db3.raw.objectStoreNames)).toEqual(['s']);
      expect(warn).toHaveBeenCalledTimes(1); // only the version-2 open warned; after deleteStore nothing is outside the schema
      db3.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('a throwing migration aborts the upgrade and rejects openDB with that error', async () => {
    const stores = defineStores<{ s: { id: number } }>()({ s: { key: 'id' } });
    const boom = new Error('boom');
    await expect(openDB('fail', { version: 1, stores, broadcast: false, migrations: { 1: () => { throw boom; } } })).rejects.toBe(boom);
    // nothing was created
    await new Promise<void>((resolve) => {
      const req = indexedDB.open('fail');
      req.onsuccess = () => { expect(req.result.version).toBe(1); expect(req.result.objectStoreNames.length).toBe(0); req.result.close(); resolve(); };
    });
  });

  it('a failed request inside a migration rejects openDB with IdbError', async () => {
    const stores = defineStores<{ s: { id: number } }>()({ s: { key: 'id' } });
    await expect(openDB('fail2', {
      version: 1, stores, broadcast: false,
      migrations: { 1: async (tx) => { await tx.add('s', { id: 1 }); await tx.add('s', { id: 1 }); } },
    })).rejects.toBeInstanceOf(IdbError);
  });

  it('logs when a migration fails after the upgrade transaction committed', async () => {
    const stores = defineStores<{ s: { id: number } }>()({ s: { key: 'id' } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const db = await openDB('late', {
        version: 1, stores, broadcast: false,
        migrations: { 1: async (tx) => { await new Promise((r) => setTimeout(r, 0)); await tx.add('s', { id: 1 }); } },
      });
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
      expect(String(error.mock.calls[0][0])).toContain('migration failed');
      db.close();
    } finally {
      error.mockRestore();
    }
  });

  it('onVersionChange fires on the old connection when a newer version opens', async () => {
    const stores = defineStores<{ s: { id: number } }>()({ s: { key: 'id' } });
    const onVersionChange = vi.fn();
    const db1 = await openDB('vc', { version: 1, stores, broadcast: false, onVersionChange });
    const onBlocked = vi.fn();
    const opening = openDB('vc', { version: 2, stores, broadcast: false, onBlocked });
    await vi.waitFor(() => expect(onVersionChange).toHaveBeenCalled());
    db1.close();
    const db2 = await opening;
    expect(db2.version).toBe(2);
    db2.close();
  });
});
