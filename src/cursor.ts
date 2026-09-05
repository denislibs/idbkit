import { request } from './errors';
import type { Key } from './range';
import type { Cursor } from './types';

export type CursorHooks = {
  onUpdate(primaryKey: Key, before: unknown, after: unknown): void;
  onDelete(primaryKey: Key, before: unknown): void;
};

/**
 * Async iteration over an IndexedDB cursor. Awaiting only IndexedDB requests inside the loop keeps
 * the transaction alive; awaiting anything else (fetch, timers) closes it and the next `continue()` throws.
 */
export async function* iterate<V>(
  source: IDBObjectStore | IDBIndex,
  range: IDBKeyRange | undefined,
  direction: IDBCursorDirection | undefined,
  limit: number | undefined,
  store: string,
  hooks?: CursorHooks,
): AsyncGenerator<Cursor<V>, void, undefined> {
  const req = source.openCursor(range, direction);
  let cur = await request(req, store, 'iterate');
  let n = 0;
  while (cur) {
    const c = cur;
    const before = c.value as V;
    yield {
      key: c.key,
      primaryKey: c.primaryKey,
      value: before,
      async update(value) {
        await request(c.update(value), store, 'update');
        hooks?.onUpdate(c.primaryKey, before, value);
      },
      async delete() {
        await request(c.delete(), store, 'delete');
        hooks?.onDelete(c.primaryKey, before);
      },
    };
    if (limit !== undefined && ++n >= limit) return;
    c.continue();
    cur = await request(req, store, 'iterate');
  }
}
