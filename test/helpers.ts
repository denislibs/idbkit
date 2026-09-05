import { IDBFactory } from 'fake-indexeddb';

/** Fresh, empty IndexedDB for each test. */
export function resetIndexedDB(): void {
  globalThis.indexedDB = new IDBFactory() as unknown as typeof globalThis.indexedDB;
}

/** Open a raw IDBDatabase at version 1, running `setup` inside upgradeneeded. */
export function openRaw(name: string, setup: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => setup(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolve after `ms` milliseconds. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
