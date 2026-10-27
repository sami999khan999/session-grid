import { call } from '../src/core/messages';
import { EV_SET_COOKIE, EV_SNAPSHOT, META_KEY, MODE_ATTR, RELOAD_KEY } from '../src/page/protocol';

function prefixTitle(tag: string) {
  const prefix = `[${tag}] `;
  const apply = () => {
    if (document.title && !document.title.startsWith(prefix)) document.title = prefix + document.title;
  };
  apply();
  new MutationObserver(apply).observe(document, { subtree: true, childList: true, characterData: true });
}

/** Show the session-badged favicon: the page's own icon links are parked, ours goes last. */
function setFavicon(href: string) {
  const head = document.head ?? document.documentElement;
  for (const link of head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]:not([data-sessionstack])')) {
    link.dataset.sessionstackRel = link.rel;
    link.rel = 'sessionstack-parked-icon';
  }
  let ours = head.querySelector<HTMLLinkElement>('link[data-sessionstack]');
  if (!ours) {
    ours = Object.assign(document.createElement('link'), { rel: 'icon', type: 'image/png' });
    ours.dataset.sessionstack = '';
  }
  ours.href = href;
  head.append(ours);
}

/**
 * Isolated-world bridge between the page shim and the background: forwards cookie writes,
 * pushes fresh snapshots, and repairs the shim's decision when it was made from stale data.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  allFrames: true,
  matchAboutBlank: true,
  exclude: ['firefox'],
  async main() {
    // Read lazily: the MAIN-world shim isn't guaranteed to run before this script.
    const shimKey = () => document.documentElement.getAttribute(MODE_ATTR) ?? '';

    document.addEventListener(EV_SET_COOKIE, (e) => {
      void call('pageSetCookie', { cookie: String((e as CustomEvent).detail ?? '') });
    });

    const push = async () => {
      const { sessionId, cookies, title } = await call('pageBootstrap', {});
      if (sessionId) document.dispatchEvent(new CustomEvent(EV_SNAPSHOT, { detail: cookies }));
      if (title && window === window.top) prefixTitle(title);
      return sessionId ?? '';
    };

    browser.runtime.onMessage.addListener((msg: { type?: string; href?: string }) => {
      if (msg?.type === 'cookiesChanged' && shimKey()) void push();
      if (msg?.type === 'favicon' && msg.href && window === window.top) setFavicon(msg.href);
    });

    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    const actual = await push().catch(() => shimKey());
    if (actual === shimKey()) return;

    // The shim ran in the wrong session (no Server-Timing on this load, stale cache). Fix the
    // cached meta so the next load decides correctly, then reload once.
    try {
      if (actual) sessionStorage.setItem(META_KEY, JSON.stringify({ sessionKey: actual, cookies: '' }));
      else sessionStorage.removeItem(META_KEY);
      const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
      if (Date.now() - last < 10_000 || window !== window.top) return;
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch {
      return;
    }
    location.reload();
  },
});
