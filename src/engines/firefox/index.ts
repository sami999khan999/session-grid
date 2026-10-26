import { browser } from 'wxt/browser';
import { resolveSession } from '../../core/rules';
import { kv } from '../../core/store';
import type { AppState, PortableCookie, Session } from '../../core/types';
import { isWebUrl, type IsolationEngine, type StateSource } from '../engine';

const DEFAULT_STORE = 'firefox-default';

/** Session id → contextual identity cookieStoreId. */
const containersStore = kv<Record<string, string>>('local', 'containers', {});

// Firefox-only APIs that aren't in the shared Chrome typings.
interface FirefoxTab extends Browser.tabs.Tab {
  cookieStoreId?: string;
}
interface Identity {
  cookieStoreId: string;
  name: string;
  color: string;
  icon: string;
}
interface ContextualIdentities {
  get(id: string): Promise<Identity>;
  create(details: { name: string; color: string; icon: string }): Promise<Identity>;
  update(id: string, details: { name?: string; color?: string; icon?: string }): Promise<Identity>;
  remove(id: string): Promise<Identity>;
}
interface FirefoxRequestDetails {
  tabId: number;
  url: string;
  cookieStoreId?: string;
}

const ff = browser as unknown as {
  contextualIdentities: ContextualIdentities;
  tabs: { create(p: Browser.tabs.CreateProperties & { cookieStoreId?: string }): Promise<FirefoxTab> };
  browsingData: { remove(o: { cookieStoreId: string }, d: Record<string, boolean>): Promise<void> };
  cookies: {
    getAll(d: { storeId: string; firstPartyDomain?: null }): Promise<Browser.cookies.Cookie[]>;
    set(d: Browser.cookies.SetDetails & { storeId: string }): Promise<unknown>;
  };
};

const containerName = (s: Session) => s.name || s.tag || 'Session';

export class FirefoxEngine implements IsolationEngine {
  /** Tabs we just created for a redirect; skip their first navigation to avoid loops. */
  private justOpened = new Set<number>();

  constructor(private state: StateSource) {}

  attach(): void {
    browser.webRequest.onBeforeRequest.addListener(
      // Firefox accepts a Promise from blocking listeners; the shared typings don't.
      ((d: unknown) => this.onMainFrame(d as FirefoxRequestDetails)) as never,
      { urls: ['<all_urls>'], types: ['main_frame'] },
      ['blocking'],
    );
  }

  /** Blocking: Firefox can't move a tab between containers, so reopen the URL in the mapped one. */
  private async onMainFrame(d: FirefoxRequestDetails): Promise<Browser.webRequest.BlockingResponse> {
    if (d.tabId < 0 || !isWebUrl(d.url)) return {};
    if (this.justOpened.delete(d.tabId)) return {};
    const target = resolveSession((await this.state.get()).rules, d.url);
    if (!target) return {};
    const store = (await containersStore.get())[target];
    if (!store || store === d.cookieStoreId) return {};

    const tab = await browser.tabs.get(d.tabId);
    const opened = await ff.tabs.create({
      url: d.url,
      cookieStoreId: store,
      index: tab.index + 1,
      windowId: tab.windowId,
      active: tab.active,
    });
    if (opened.id !== undefined) this.justOpened.add(opened.id);
    // Replace a tab that has nothing to go back to; keep one that has history.
    if (!isWebUrl(tab.url)) await browser.tabs.remove(d.tabId);
    return { cancel: true };
  }

  async sync(state: AppState): Promise<void> {
    const map = await containersStore.get();
    const live = new Set(state.sessions.map((s) => s.id));
    for (const session of state.sessions) {
      const details = { name: containerName(session), color: session.color, icon: 'fingerprint' };
      const existing = map[session.id];
      const ok = existing && (await ff.contextualIdentities.update(existing, details).then(() => true, () => false));
      if (!ok) map[session.id] = (await ff.contextualIdentities.create(details)).cookieStoreId;
    }
    for (const [sid, store] of Object.entries(map)) {
      if (live.has(sid)) continue;
      await ff.contextualIdentities.remove(store).catch(() => {});
      delete map[sid];
    }
    await containersStore.set(map);
  }

  async getTabSession(tabId: number): Promise<string | null> {
    const tab = (await browser.tabs.get(tabId)) as FirefoxTab;
    const map = await containersStore.get();
    return Object.entries(map).find(([, store]) => store === tab.cookieStoreId)?.[0] ?? null;
  }

  private async storeFor(sessionId: string): Promise<string> {
    const store = (await containersStore.get())[sessionId];
    if (!store) throw new Error('Unknown session');
    return store;
  }

  async openInSession(sessionId: string, url?: string): Promise<void> {
    const tab = await ff.tabs.create({ cookieStoreId: await this.storeFor(sessionId), active: true, ...(url ? { url } : {}) });
    if (tab.id !== undefined && url) this.justOpened.add(tab.id);
  }

  async assignTab(tabId: number, sessionId: string | null): Promise<void> {
    const tab = (await browser.tabs.get(tabId)) as FirefoxTab;
    const store = sessionId ? await this.storeFor(sessionId) : DEFAULT_STORE;
    if (tab.cookieStoreId === store) return;
    const opened = await ff.tabs.create({
      cookieStoreId: store,
      index: tab.index + 1,
      windowId: tab.windowId,
      active: tab.active,
      pinned: tab.pinned,
      ...(isWebUrl(tab.url) ? { url: tab.url } : {}),
    });
    if (opened.id !== undefined) this.justOpened.add(opened.id);
    await browser.tabs.remove(tabId);
  }

  async clearSession(sessionId: string): Promise<void> {
    const cookieStoreId = await this.storeFor(sessionId);
    await ff.browsingData.remove({ cookieStoreId }, { cookies: true, localStorage: true, indexedDB: true });
  }

  async exportCookies(sessionId: string): Promise<PortableCookie[]> {
    const cookies = await ff.cookies.getAll({ storeId: await this.storeFor(sessionId), firstPartyDomain: null });
    return cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain.replace(/^\./, ''),
      hostOnly: c.hostOnly,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite === 'no_restriction' ? 'none' : c.sameSite === 'lax' || c.sameSite === 'strict' ? c.sameSite : 'unspecified',
      ...(c.expirationDate !== undefined ? { expires: Math.floor(c.expirationDate) } : {}),
    }));
  }

  async importCookies(sessionId: string, cookies: PortableCookie[]): Promise<void> {
    const storeId = await this.storeFor(sessionId);
    for (const c of cookies) {
      await ff.cookies
        .set({
          storeId,
          url: `${c.secure ? 'https' : 'http'}://${c.domain}${c.path}`,
          name: c.name,
          value: c.value,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: (c.sameSite === 'none' ? 'no_restriction' : c.sameSite === 'unspecified' ? 'lax' : c.sameSite) as Browser.cookies.SameSiteStatus,
          ...(c.hostOnly ? {} : { domain: c.domain }),
          ...(c.expires !== undefined ? { expirationDate: c.expires } : {}),
        })
        .catch((err: unknown) => console.warn('[SessionStack] cookie import skipped', c.name, err));
    }
  }
}
