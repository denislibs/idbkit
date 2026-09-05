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
 * Promisify an IDBRequest. Always takes a thunk, never a bare request: calling the IndexedDB method
 * inside the thunk (rather than before passing it in) means a synchronous throw from that call
 * (e.g. ReadOnlyError, TransactionInactiveError, a bad key) becomes an IdbError rejection instead of
 * escaping as a raw DOMException, with an already-thrown IdbError passed through unchanged.
 */
export function request<T>(req: () => IDBRequest<T>, store?: string, op?: string): Promise<T> {
  let r: IDBRequest<T>;
  try {
    r = req();
  } catch (cause) {
    if (cause instanceof IdbError) return Promise.reject(cause);
    return Promise.reject(new IdbError((cause as Error)?.message ?? 'IndexedDB call failed', { cause, store, op }));
  }
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new IdbError(r.error?.message ?? 'IndexedDB request failed', { cause: r.error, store, op }));
  });
}
