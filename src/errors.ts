export type ErrorInfo = { cause?: unknown; store?: string; op?: string };

export class IdbError extends Error {
  readonly store?: string;
  readonly op?: string;

  constructor(message: string, info: ErrorInfo = {}) {
    super(message, { cause: info.cause });
    this.name = 'IdbError';
    this.store = info.store;
    this.op = info.op;
  }
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

/**
 * Promisify an IDBRequest. Handlers are replaced on each call, so it is safe to re-await a cursor request.
 * Given a thunk instead, a synchronous throw from it (e.g. ReadOnlyError) becomes an IdbError rejection,
 * with an already-thrown IdbError passed through unchanged.
 */
export function request<T>(req: IDBRequest<T> | (() => IDBRequest<T>), store?: string, op?: string): Promise<T> {
  let r: IDBRequest<T>;
  if (typeof req === 'function') {
    try {
      r = req();
    } catch (cause) {
      if (cause instanceof IdbError) return Promise.reject(cause);
      return Promise.reject(new IdbError((cause as Error)?.message ?? 'IndexedDB call failed', { cause, store, op }));
    }
  } else {
    r = req;
  }
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new IdbError(r.error?.message ?? 'IndexedDB request failed', { cause: r.error, store, op }));
  });
}
