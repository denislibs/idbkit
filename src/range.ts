export type Key = IDBValidKey;
export type Bounds<K> = { gt?: K; gte?: K; lt?: K; lte?: K };
export type KeyRange<K> = K | Bounds<K>;

function isBounds(r: unknown): r is Bounds<Key> {
  return (
    typeof r === 'object' &&
    r !== null &&
    !Array.isArray(r) &&
    !(r instanceof Date) &&
    !(r instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(r)
  );
}

export function toKeyRange(r: KeyRange<Key> | undefined): IDBKeyRange | undefined {
  if (r === undefined) return undefined;
  if (!isBounds(r)) return IDBKeyRange.only(r);
  const lower = r.gte ?? r.gt;
  const upper = r.lte ?? r.lt;
  const lowerOpen = r.gte === undefined;
  const upperOpen = r.lte === undefined;
  if (lower === undefined && upper === undefined) return undefined;
  if (upper === undefined) return IDBKeyRange.lowerBound(lower, lowerOpen);
  if (lower === undefined) return IDBKeyRange.upperBound(upper, upperOpen);
  return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
}

export function inRange(key: Key, r: KeyRange<Key>): boolean {
  try {
    if (!isBounds(r)) return indexedDB.cmp(key, r) === 0;
    const lower = r.gte ?? r.gt;
    const upper = r.lte ?? r.lt;
    if (lower !== undefined) {
      const c = indexedDB.cmp(key, lower);
      if (c < 0 || (c === 0 && r.gte === undefined)) return false;
    }
    if (upper !== undefined) {
      const c = indexedDB.cmp(key, upper);
      if (c > 0 || (c === 0 && r.lte === undefined)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
