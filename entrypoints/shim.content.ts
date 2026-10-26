import { CookieView } from '../src/page/cookies';
import { KEY_PREFIX, eventKey, namespacedStorage } from '../src/page/storage';
import { EV_SET_COOKIE, EV_SNAPSHOT, META_KEY, MODE_ATTR, storageNamespace, type Meta } from '../src/page/protocol';
import { TIMING_NAME, parseTiming } from '../src/engines/chromium/dnr';

/**
 * Page-world shim for partitioned Chrome tabs. Runs before any page script, decides
 * synchronously which session this document belongs to, and redirects document.cookie,
 * cookieStore and web storage to that session's namespace.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: true,
  matchAboutBlank: true,
  exclude: ['firefox'],
  main() {
    const SYM = Symbol.for('sessionstack');
    const nativeSession = safe(() => window.sessionStorage);
    const nativeLocal = safe(() => window.localStorage);
    const meta = resolveMeta();
    document.documentElement.setAttribute(MODE_ATTR, meta ? meta.sessionKey : '');

    if (!meta) {
      hideOwnKeys();
      return;
    }
    Object.defineProperty(window, SYM, { value: meta });

    const namespace = storageNamespace(meta.sessionKey);
    gcStaleNamespaces(namespace);
    const view = new CookieView(meta.cookies);
    const send = (cookie: string) => document.dispatchEvent(new CustomEvent(EV_SET_COOKIE, { detail: cookie }));
    document.addEventListener(EV_SNAPSHOT, (e) => {
      const cookies = String((e as CustomEvent).detail ?? '');
      view.reset(cookies);
      writeMeta({ sessionKey: meta.sessionKey, cookies });
    });

    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      enumerable: true,
      get: () => view.toString(),
      set: (value: unknown) => {
        const str = String(value);
        view.apply(str);
        send(str);
      },
    });

    patchCookieStore(view, send);
    if (nativeLocal) installStorage('localStorage', nativeLocal, namespace);
    if (nativeSession) installStorage('sessionStorage', nativeSession, namespace);
    filterStorageEvents(namespace);

    // ---------------------------------------------------------------- helpers

    function resolveMeta(): Meta | null {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const timing = nav?.serverTiming?.find((e) => e.name === TIMING_NAME);
      if (timing) {
        const parsed = parseTiming(timing.description);
        if (parsed) {
          writeMeta(parsed);
          return parsed;
        }
      }
      // about:blank / srcdoc frames inherit from a same-origin parent.
      if (window !== window.parent) {
        const inherited = safe(() => (window.parent as unknown as Record<symbol, Meta | undefined>)[SYM]);
        if (inherited) return inherited;
      }
      // No header (plain http, cached response): fall back to what this tab last saw. The bridge
      // checks it against the background and reloads if it is stale.
      const cached = safe(() => nativeSession?.getItem(META_KEY));
      return cached ? (JSON.parse(cached) as Meta) : null;
    }

    function writeMeta(m: Meta) {
      safe(() => nativeSession?.setItem(META_KEY, JSON.stringify(m)));
    }

    function hideOwnKeys() {
      for (const [name, area] of [['localStorage', nativeLocal], ['sessionStorage', nativeSession]] as const) {
        if (!area) continue;
        let found = false;
        for (let i = 0; i < area.length && !found; i++) found = !!area.key(i)?.startsWith(KEY_PREFIX);
        if (found) installStorage(name, area, null);
      }
      if (nativeLocal || nativeSession) filterStorageEvents(null);
    }

    function gcStaleNamespaces(current: string) {
      const sid = current.slice(0, current.lastIndexOf('.'));
      for (const area of [nativeLocal, nativeSession]) {
        if (!area) continue;
        const stale: string[] = [];
        for (let i = 0; i < area.length; i++) {
          const k = area.key(i);
          if (k?.startsWith(sid + '.') && !k.startsWith(current)) stale.push(k);
        }
        stale.forEach((k) => area.removeItem(k));
      }
    }

    function installStorage(name: 'localStorage' | 'sessionStorage', area: Storage, ns: string | null) {
      const proxy = namespacedStorage(area, ns);
      Object.defineProperty(window, name, { configurable: true, enumerable: true, get: () => proxy });
    }

    function filterStorageEvents(ns: string | null) {
      const redispatched = new WeakSet<Event>();
      window.addEventListener(
        'storage',
        (e) => {
          if (redispatched.has(e)) return;
          e.stopImmediatePropagation();
          const key = eventKey(e.key, ns);
          if (key === undefined) return;
          const copy = new StorageEvent('storage', { key, oldValue: e.oldValue, newValue: e.newValue, url: e.url });
          redispatched.add(copy);
          window.dispatchEvent(copy);
        },
        true,
      );
    }

    function patchCookieStore(v: CookieView, write: (cookie: string) => void) {
      const CS = (window as unknown as { CookieStore?: { prototype: object } }).CookieStore;
      if (!CS) return;
      type Opts = string | { name?: string; value?: string; expires?: number | null; path?: string; domain?: string | null };
      const nameOf = (o?: Opts) => (typeof o === 'string' ? o : o?.name);
      const toItem = (e: { name: string; value: string }) => ({ name: e.name, value: e.value });
      Object.assign(CS.prototype, {
        async get(o?: Opts) {
          const name = nameOf(o);
          const found = v.list().find((e) => name === undefined || e.name === name);
          return found ? toItem(found) : null;
        },
        async getAll(o?: Opts) {
          const name = nameOf(o);
          return v.list().filter((e) => name === undefined || e.name === name).map(toItem);
        },
        async set(a: Opts, b?: string) {
          const o = typeof a === 'string' ? { name: a, value: b ?? '' } : a;
          const attrs = [`${o.name}=${o.value ?? ''}`, `Path=${o.path ?? '/'}`];
          if (o.domain) attrs.push(`Domain=${o.domain}`);
          if (o.expires != null) attrs.push(`Expires=${new Date(o.expires).toUTCString()}`);
          const str = attrs.join('; ');
          v.apply(str);
          write(str);
        },
        async delete(o: Opts) {
          const name = nameOf(o) ?? '';
          const str = `${name}=; Path=${typeof o === 'object' && o.path ? o.path : '/'}; Max-Age=0`;
          v.apply(str);
          write(str);
        },
      });
    }
  },
});

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
