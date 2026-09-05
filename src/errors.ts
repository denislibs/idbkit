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

/** Promisify an IDBRequest. Handlers are replaced on each call, so it is safe to re-await a cursor request. */
export function request<T>(req: IDBRequest<T>, store?: string, op?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(new IdbError(req.error?.message ?? 'IndexedDB request failed', { cause: req.error, store, op }));
  });
}

/** Like `request`, but a synchronous throw from `fn` (e.g. ReadOnlyError) becomes an IdbError rejection. */
export function run<T>(fn: () => IDBRequest<T>, store?: string, op?: string): Promise<T> {
  let req: IDBRequest<T>;
  try {
    req = fn();
  } catch (cause) {
    if (cause instanceof IdbError) return Promise.reject(cause);
    return Promise.reject(new IdbError((cause as Error)?.message ?? 'IndexedDB call failed', { cause, store, op }));
  }
  return request(req, store, op);
}
