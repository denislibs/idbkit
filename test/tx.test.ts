import { beforeEach, describe, expect, it } from 'vitest';
import { IdbError } from '../src/errors';
import { TransactionImpl, UpgradeTransactionImpl } from '../src/tx';
import { openRaw, resetIndexedDB } from './helpers';

type User = { id: string; name: string; age: number };

let db: IDBDatabase;
beforeEach(async () => {
  resetIndexedDB();
  db = await openRaw('tx', (d) => {
    const users = d.createObjectStore('users', { keyPath: 'id' });
    users.createIndex('byAge', 'age');
    d.createObjectStore('posts', { keyPath: 'id', autoIncrement: true });
  });
});

const rw = (...stores: string[]) => new TransactionImpl(db.transaction(stores, 'readwrite'), {});
const ro = (...stores: string[]) => new TransactionImpl(db.transaction(stores, 'readonly'), {});

async function seed() {
  const tx = rw('users');
  await tx.put('users', { id: 'a', name: 'Ann', age: 30 });
  await tx.put('users', { id: 'b', name: 'Bob', age: 20 });
  await tx.put('users', { id: 'c', name: 'Cid', age: 40 });
  await tx.done;
}

describe('writes', () => {
  it('put returns the key and done resolves after commit', async () => {
    const tx = rw('users');
    expect(await tx.put('users', { id: 'a', name: 'Ann', age: 1 })).toBe('a');
    await tx.done;
    expect(await ro('users').get('users', 'a')).toEqual({ id: 'a', name: 'Ann', age: 1 });
  });

  it('add returns a generated key and rejects on duplicate', async () => {
    const tx = rw('posts');
    expect(await tx.add('posts', { title: 'x' })).toBe(1);
    await tx.done;
    const tx2 = rw('posts');
    await expect(tx2.add('posts', { id: 1, title: 'dup' })).rejects.toBeInstanceOf(IdbError);
  });

  it('delete and clear', async () => {
    await seed();
    const tx = rw('users');
    await tx.delete('users', 'a');
    await tx.done;
    expect(await ro('users').count('users')).toBe(2);
    const tx2 = rw('users');
    await tx2.clear('users');
    await tx2.done;
    expect(await ro('users').count('users')).toBe(0);
  });

  it('write in a readonly transaction rejects with IdbError', async () => {
    await expect(ro('users').put('users', { id: 'z', name: '', age: 0 })).rejects.toBeInstanceOf(IdbError);
  });
});

describe('reads', () => {
  beforeEach(seed);

  it('get returns undefined for a missing key', async () => {
    expect(await ro('users').get('users', 'nope')).toBeUndefined();
  });

  it('getAll by primary key range and by index range with limit', async () => {
    expect((await ro('users').getAll('users')).map((u: User) => u.id)).toEqual(['a', 'b', 'c']);
    expect((await ro('users').getAll('users', { range: { gte: 'b' } })).map((u: User) => u.id)).toEqual(['b', 'c']);
    expect((await ro('users').getAll('users', { index: 'byAge', range: { gte: 30 } })).map((u: User) => u.id)).toEqual(['a', 'c']);
    expect((await ro('users').getAll('users', { index: 'byAge', limit: 2 })).map((u: User) => u.id)).toEqual(['b', 'a']);
  });

  it('getAllKeys and count', async () => {
    expect(await ro('users').getAllKeys('users', { index: 'byAge' })).toEqual(['b', 'a', 'c']);
    expect(await ro('users').count('users', { index: 'byAge', range: { lt: 40 } })).toBe(2);
  });

  it('unknown store throws IdbError with the store name', async () => {
    await expect(ro('users').get('posts', 1)).rejects.toMatchObject({ name: 'IdbError', store: 'posts' });
  });
});

describe('done and abort', () => {
  it('abort rejects done and discards writes', async () => {
    const tx = rw('users');
    await tx.put('users', { id: 'x', name: 'X', age: 1 });
    tx.abort();
    await expect(tx.done).rejects.toBeInstanceOf(IdbError);
    expect(await ro('users').count('users')).toBe(0);
  });

  it('a failed request aborts the transaction and rejects done', async () => {
    const tx = rw('posts');
    await tx.add('posts', { id: 1 });
    await tx.add('posts', { id: 1 }).catch(() => {});
    await expect(tx.done).rejects.toBeInstanceOf(IdbError);
  });

  it('an operation after done on a completed transaction rejects with IdbError', async () => {
    const tx = rw('users');
    await tx.put('users', { id: 'z', name: 'Z', age: 1 });
    await tx.done;
    const err = await tx.put('users', { id: 'y', name: 'Y', age: 2 }).catch((e) => e);
    expect(err).toMatchObject({ name: 'IdbError' });
    expect((err.cause as DOMException).name).toBe('InvalidStateError');
  });
});

describe('iterate', () => {
  beforeEach(seed);

  it('walks an index in reverse with a range', async () => {
    const seen: [unknown, unknown][] = [];
    for await (const cur of ro('users').iterate('users', { index: 'byAge', range: { lte: 30 }, direction: 'prev' })) {
      seen.push([cur.key, cur.primaryKey]);
    }
    expect(seen).toEqual([[30, 'a'], [20, 'b']]);
  });

  it('honours limit and break', async () => {
    const limited: unknown[] = [];
    for await (const cur of ro('users').iterate('users', { limit: 2 })) limited.push(cur.primaryKey);
    expect(limited).toEqual(['a', 'b']);
    const tx = ro('users');
    for await (const cur of tx.iterate('users')) { limited.push(cur.primaryKey); break; }
    await tx.done;
    expect(limited).toEqual(['a', 'b', 'a']);
  });

  it('update and delete through the cursor', async () => {
    const tx = rw('users');
    // Update a non-indexed field so the index cursor does not revisit the record.
    for await (const cur of tx.iterate('users', { index: 'byAge' })) {
      if (cur.primaryKey === 'b') await cur.delete();
      else await cur.update({ ...(cur.value as User), name: (cur.value as User).name.toUpperCase() });
    }
    await tx.done;
    expect(await ro('users').getAll('users')).toEqual([
      { id: 'a', name: 'ANN', age: 30 },
      { id: 'c', name: 'CID', age: 40 },
    ]);
  });

  it('unknown store or index rejects with IdbError on first next()', async () => {
    const bad = ro('users').iterate('posts');
    await expect(bad[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: 'IdbError', store: 'posts' });
    const badIndex = ro('users').iterate('users', { index: 'nope' });
    await expect(badIndex[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: 'IdbError', store: 'users', op: 'iterate' });
  });

  it('cursor.update on a readonly transaction rejects with IdbError', async () => {
    const tx = ro('users');
    for await (const cur of tx.iterate('users')) {
      await expect(cur.update({ ...(cur.value as User), name: 'x' })).rejects.toBeInstanceOf(IdbError);
      break;
    }
  });

  it('continuing after an external await rejects with IdbError', async () => {
    const tx = ro('users');
    const it = tx.iterate('users')[Symbol.asyncIterator]();
    await it.next();
    await new Promise((r) => setTimeout(r, 0));
    await expect(it.next()).rejects.toBeInstanceOf(IdbError);
  });

  it('an invalid range rejects with IdbError instead of throwing', async () => {
    const it = ro('users').iterate('users', { range: { gte: {} as unknown as string } })[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toBeInstanceOf(IdbError);
    await expect(ro('users').getAll('users', { range: { gte: {} as unknown as string } })).rejects.toBeInstanceOf(IdbError);
  });
});

describe('UpgradeTransactionImpl', () => {
  it('exposes versions and can delete a store', async () => {
    db.close();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('tx', 2);
      req.onupgradeneeded = (e) => {
        const tx = new UpgradeTransactionImpl(req.transaction!, e.oldVersion, e.newVersion!);
        expect(tx.oldVersion).toBe(1);
        expect(tx.newVersion).toBe(2);
        tx.deleteStore('posts');
      };
      req.onsuccess = () => {
        expect(Array.from(req.result.objectStoreNames)).toEqual(['users']);
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  });
});
