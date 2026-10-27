import { Cookie, CookieJar, MemoryCookieStore } from 'tough-cookie';
import type { PortableCookie } from '../../core/types';

export type SameSiteContext = 'strict' | 'lax' | 'none';

const JAR_OPTIONS = { looseMode: true, allowSpecialUseDomain: true, rejectPublicSuffixes: true };

// Header values DNR accepts; cookies outside this range would make the whole rule update fail.
const HEADER_SAFE = /^[\x20-\x7e\t]*$/;

/** A browser-semantics view over a tough-cookie jar for one session. */
export class SessionJar {
  readonly jar: CookieJar;

  constructor(serialized?: unknown) {
    const store = new MemoryCookieStore();
    this.jar = serialized
      ? CookieJar.deserializeSync(serialized as string, store)
      : new CookieJar(store, JAR_OPTIONS);
  }

  serialize(): unknown {
    return this.jar.serializeSync();
  }

  /** Store a cookie from a Set-Cookie header (`http`) or document.cookie (`!http`). Returns whether it was accepted. */
  set(setCookie: string, url: string, http = true): boolean {
    try {
      return !!this.jar.setCookieSync(setCookie, url, { http, ignoreError: true });
    } catch {
      return false;
    }
  }

  /** Cookies a browser would send to `url` in the given SameSite context, in header order. */
  match(url: string, context: SameSiteContext, http = true): Cookie[] {
    return this.jar
      .getCookiesSync(url, { http, sort: true })
      .filter((c) => HEADER_SAFE.test(c.key) && HEADER_SAFE.test(c.value))
      .filter((c) => allowedIn(c, context));
  }

  header(url: string, context: SameSiteContext, http = true): string {
    return this.match(url, context, http)
      .map((c) => c.cookieString())
      .join('; ');
  }

  all(): Cookie[] {
    const now = Date.now();
    const raw = (this.jar.serializeSync()?.cookies ?? []) as unknown[];
    return raw
      .map((c) => Cookie.fromJSON(c))
      .filter((c): c is Cookie => !!c && c.TTL(now) > 0);
  }

  clear(): void {
    this.jar.removeAllCookiesSync();
  }

  /** Earliest expiry among stored cookies, in epoch ms. */
  nextExpiry(): number | undefined {
    let next: number | undefined;
    for (const c of this.all()) {
      const t = c.expiryTime();
      if (t !== undefined && Number.isFinite(t) && (next === undefined || t < next)) next = t;
    }
    return next;
  }

  exportPortable(): PortableCookie[] {
    return this.all().map((c) => {
      const expiry = c.expiryTime();
      const sameSite = normalizeSameSite(c.sameSite);
      return {
        name: c.key,
        value: c.value,
        domain: c.domain ?? '',
        hostOnly: !!c.hostOnly,
        path: c.path ?? '/',
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite,
        ...(expiry !== undefined && Number.isFinite(expiry) ? { expires: Math.floor(expiry / 1000) } : {}),
      };
    });
  }

  importPortable(cookies: PortableCookie[]): void {
    for (const c of cookies) {
      const domain = c.domain.replace(/^\./, '');
      const attrs = [`${c.name}=${c.value}`, `Path=${c.path}`];
      if (!c.hostOnly) attrs.push(`Domain=${domain}`);
      if (c.secure) attrs.push('Secure');
      if (c.httpOnly) attrs.push('HttpOnly');
      if (c.sameSite !== 'unspecified') attrs.push(`SameSite=${c.sameSite}`);
      if (c.expires !== undefined) attrs.push(`Expires=${new Date(c.expires * 1000).toUTCString()}`);
      this.set(attrs.join('; '), `${c.secure ? 'https' : 'http'}://${domain}${c.path}`);
    }
  }
}

function normalizeSameSite(s: string | undefined): PortableCookie['sameSite'] {
  const v = s?.toLowerCase();
  return v === 'strict' || v === 'lax' || v === 'none' ? v : 'unspecified';
}

/** Chrome semantics: unspecified SameSite behaves as Lax; SameSite=None requires Secure. */
function allowedIn(c: Cookie, context: SameSiteContext): boolean {
  const s = normalizeSameSite(c.sameSite);
  if (s === 'none' && !c.secure) return false;
  if (context === 'strict') return true;
  if (context === 'lax') return s !== 'strict';
  return s === 'none';
}
