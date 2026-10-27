/** Shim → bridge: a cookie write (detail: Set-Cookie string). */
export const EV_SET_COOKIE = 'ssx:set-cookie';
/** Bridge → shim: fresh cookie snapshot (detail: cookie string). */
export const EV_SNAPSHOT = 'ssx:snapshot';
/** Bridge → shim: title prefix to show (detail: tag, or '' for none). */
export const EV_TITLE = 'ssx:title';

/** Real-sessionStorage key caching the tab's session for loads without Server-Timing (plain http, cache). */
export const META_KEY = '__ssx_meta';
/** Real-sessionStorage key guarding against reload loops when the bridge corrects the shim. */
export const RELOAD_KEY = '__ssx_reload';

export interface Meta {
  sessionKey: string;
  cookies: string;
}

/** Bridge-readable record of what the shim decided for this document (via a DOM attribute). */
export const MODE_ATTR = 'data-ssx-mode';

export const storageNamespace = (sessionKey: string) => `__ssx:${sessionKey}:`;
