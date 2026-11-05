import { browser } from 'wxt/browser';
import type { AppState, Prefs, Rule, Session } from './types';

export interface TabInfo {
  tabId: number;
  sessionId: string | null;
}

/** Requests to the background, keyed by `type`, with their response types. */
export interface Api {
  getState: { req: {}; res: AppState };
  saveSession: { req: { session: Session }; res: Session };
  deleteSession: { req: { id: string }; res: void };
  clearSession: { req: { id: string }; res: void };
  reorderSessions: { req: { ids: string[] }; res: void };
  saveRules: { req: { rules: Rule[] }; res: void };
  setPrefs: { req: { prefs: Partial<Prefs> }; res: void };
  openInSession: { req: { sessionId: string; url?: string }; res: void };
  /** Bring back a session's tabs: focus them if open, else reopen the saved snapshot. */
  resumeSession: { req: { sessionId: string }; res: void };
  /** Per session: how many of its tabs are open now and how many are saved. */
  sessionTabs: { req: {}; res: Record<string, { open: number; saved: number }> };
  assignTab: { req: { tabId: number; sessionId: string | null }; res: void };
  /** Switch page: join the sender tab to a session (auto-mapping redirect target). */
  joinSession: { req: { sessionId: string }; res: void };
  getTabInfo: { req: { tabId: number }; res: TabInfo };
  exportData: { req: { passphrase: string }; res: string };
  importData: { req: { text: string; passphrase: string; mode: 'merge' | 'replace' }; res: { sessions: number; rules: number } };
  /** Chrome page bridge: a document.cookie / cookieStore write. */
  pageSetCookie: { req: { cookie: string }; res: void };
  /** Chrome page bridge: bootstrap for the sending frame. */
  pageBootstrap: { req: {}; res: { sessionId: string | null; cookies: string; title?: string; time?: { timeZone?: string; offset: number } } };
}

export type ApiType = keyof Api;
export type ApiRequest = { [K in ApiType]: { type: K } & Api[K]['req'] }[ApiType];

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export async function call<K extends ApiType>(type: K, req: Api[K]['req']): Promise<Api[K]['res']> {
  const res = (await browser.runtime.sendMessage({ type, ...req })) as Result<Api[K]['res']> | undefined;
  if (!res) throw new Error(`No response for ${type}`);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

export type Handlers = {
  [K in ApiType]: (req: Api[K]['req'], sender: Browser.runtime.MessageSender) => Promise<Api[K]['res']>;
};

/** The only calls content scripts may make; everything else is for extension pages. */
const PAGE_CALLS = new Set<ApiType>(['pageSetCookie', 'pageBootstrap']);

export function serve(handlers: Handlers): void {
  browser.runtime.onMessage.addListener((msg: ApiRequest, sender, sendResponse) => {
    const fromExtensionPage = sender.url?.startsWith(browser.runtime.getURL('/')) ?? false;
    if (sender.id !== browser.runtime.id || (!fromExtensionPage && !PAGE_CALLS.has(msg?.type))) return false;
    const handler = handlers[msg?.type] as ((req: unknown, s: typeof sender) => Promise<unknown>) | undefined;
    if (!handler) return false;
    handler(msg, sender).then(
      (value) => sendResponse({ ok: true, value }),
      (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  });
}
