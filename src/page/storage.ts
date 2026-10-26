/** Prefix that marks web-storage keys owned by SessionStack. */
export const KEY_PREFIX = '__ssx';

const proto = Storage.prototype;
const native = {
  getItem: proto.getItem,
  setItem: proto.setItem,
  removeItem: proto.removeItem,
  key: proto.key,
  length: Object.getOwnPropertyDescriptor(proto, 'length')!.get!,
};

/**
 * A Storage look-alike over `area` that only sees keys under `namespace`, with the prefix
 * stripped. With `namespace === null` it shows every key except SessionStack's own, which is
 * what unpartitioned tabs use to hide partitioned data.
 */
export function namespacedStorage(area: Storage, namespace: string | null): Storage {
  const owns = (k: string) => (namespace === null ? !k.startsWith(KEY_PREFIX) : k.startsWith(namespace));
  const toNative = (k: string) => (namespace ?? '') + k;
  const fromNative = (k: string) => (namespace === null ? k : k.slice(namespace.length));

  const keys = () => {
    const out: string[] = [];
    const n = native.length.call(area) as number;
    for (let i = 0; i < n; i++) {
      const k = native.key.call(area, i);
      if (k !== null && owns(k)) out.push(fromNative(k));
    }
    return out;
  };

  const api = {
    getItem: (k: string) => native.getItem.call(area, toNative(String(k))),
    setItem: (k: string, v: string) => native.setItem.call(area, toNative(String(k)), String(v)),
    removeItem: (k: string) => native.removeItem.call(area, toNative(String(k))),
    clear: () => keys().forEach((k) => native.removeItem.call(area, toNative(k))),
    key: (i: number) => keys()[i] ?? null,
  };
  const isApi = (p: PropertyKey): p is keyof typeof api => typeof p === 'string' && Object.hasOwn(api, p);

  const target = Object.create(proto) as Storage;
  return new Proxy(target, {
    get(_t, p) {
      if (isApi(p)) return api[p];
      if (p === 'length') return keys().length;
      if (typeof p === 'symbol') return p === Symbol.toStringTag ? 'Storage' : undefined;
      if (p in proto) return Reflect.get(proto, p);
      return api.getItem(p) ?? undefined;
    },
    set(_t, p, v) {
      if (typeof p === 'symbol' || isApi(p) || p === 'length') return false;
      api.setItem(p, v);
      return true;
    },
    has(_t, p) {
      if (typeof p === 'symbol') return false;
      return isApi(p) || p === 'length' || p in proto || api.getItem(p) !== null;
    },
    deleteProperty(_t, p) {
      if (typeof p === 'string') api.removeItem(p);
      return true;
    },
    ownKeys() {
      return keys();
    },
    getOwnPropertyDescriptor(_t, p) {
      if (typeof p !== 'string' || isApi(p)) return undefined;
      const value = api.getItem(p);
      return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true };
    },
    defineProperty(_t, p, desc) {
      if (typeof p === 'symbol' || !('value' in desc)) return false;
      api.setItem(p, desc.value);
      return true;
    },
  });
}

/** Translate a `storage` event key into the namespace's view, or `undefined` if it belongs elsewhere. */
export function eventKey(key: string | null, namespace: string | null): string | null | undefined {
  if (key === null) return null; // clear() on the underlying area
  if (namespace === null) return key.startsWith(KEY_PREFIX) ? undefined : key;
  return key.startsWith(namespace) ? key.slice(namespace.length) : undefined;
}
