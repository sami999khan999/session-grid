import { browser } from 'wxt/browser';
import { getDomain } from 'tldts';
import { compilePattern, resolveSession } from '../../core/rules';
import { kv } from '../../core/store';
import type { AppState, PortableCookie } from '../../core/types';
import { isWebUrl, type IsolationEngine, type StateSource } from '../engine';
import { compileMappingRules, compileSessionRules } from './dnr';
import { SessionJar } from './jar';

const dnr = () => browser.declarativeNetRequest;

/** Tab → session assignments; tab ids only live as long as the browser session. */
const tabsStore = kv<Record<string, string>>('session', 'tabs', {});
/** Installed DNR rule ids per session. */
const ruleIdsStore = kv<Record<string, number[]>>('session', 'ruleIds', {});
const nextRuleIdStore = kv<number>('session', 'nextRuleId', 1);
/** Bumped on clearSession so the page shim starts a fresh web-storage namespace. */
const epochsStore = kv<Record<string, number>>('local', 'epochs', {});
/** URL + position of partitioned tabs, used to re-attach sessions after a browser restart. */
const restoreHintsStore = kv<{ url: string; index: number; sessionId: string }[]>('local', 'restoreHints', []);

/** ruleIds entry for the auto-mapping redirects (not a session id). */
const MAPPING_KEY = '__mapping';

const jarStore = (sessionId: string) => kv<unknown>('local', `jar:${sessionId}`, null);

interface PendingNav {
  tabId: number;
  url: string;
  /** Cookie header the navigation actually went out with. */
  sent: string;
}

export class ChromeEngine implements IsolationEngine {
  private tabs = new Map<number, string>();
  private jars = new Map<string, SessionJar>();
  private epochs: Record<string, number> = {};
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private dirty = new Set<string>();
  private mappingDirty = true;
  /** Sessions whose jar may be ahead of the installed rules, with a change counter. */
  private stale = new Map<string, number>();
  private compileScheduled: Promise<void> | null = null;
  /** Main-frame navigations that went out while a rule recompile was pending. */
  private raced = new Map<string, PendingNav[]>();
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private state: StateSource) {
    this.ready = this.rehydrate();
  }

  private async rehydrate() {
    const [tabs, epochs, open] = await Promise.all([tabsStore.get(), epochsStore.get(), browser.tabs.query({})]);
    this.epochs = epochs;
    const openIds = new Set(open.map((t) => t.id));
    for (const [id, sid] of Object.entries(tabs)) if (openIds.has(+id)) this.tabs.set(+id, sid);
  }

  private sessionKey(sessionId: string) {
    return `${sessionId}.${this.epochs[sessionId] ?? 0}`;
  }

  // ---------------------------------------------------------------- listeners

  attach(): void {
    browser.webRequest.onHeadersReceived.addListener(
      (d) => {
        // Mark synchronously: a redirect's next request fires before the async handler runs.
        const sid = this.tabs.get(d.tabId);
        if (sid && d.responseHeaders?.some((h) => h.name.toLowerCase() === 'set-cookie')) this.markStale(sid);
        void this.onHeaders(d.tabId, d.url, d.responseHeaders ?? []);
        return undefined;
      },
      { urls: ['<all_urls>'] },
      ['responseHeaders', 'extraHeaders'],
    );

    browser.webRequest.onSendHeaders.addListener(
      (d) => {
        if (d.method !== 'GET') return;
        const sid = this.tabs.get(d.tabId);
        if (!sid || !this.stale.has(sid)) return;
        // extraHeaders shows the Cookie header as sent, after DNR rewrote it.
        const sent = d.requestHeaders?.find((h) => h.name.toLowerCase() === 'cookie')?.value ?? '';
        const list = this.raced.get(sid) ?? [];
        list.push({ tabId: d.tabId, url: d.url, sent });
        this.raced.set(sid, list);
      },
      { urls: ['<all_urls>'], types: ['main_frame'] },
      ['requestHeaders', 'extraHeaders'],
    );

    browser.webNavigation.onCreatedNavigationTarget.addListener((d) => {
      void this.onOpenedFrom(d.sourceTabId, d.tabId, d.url);
    });

    browser.tabs.onRemoved.addListener((tabId) => {
      void this.ready.then(() => {
        if (this.tabs.has(tabId)) void this.setTab(tabId, null);
      });
    });

    browser.runtime.onStartup.addListener(() => void this.restoreAfterRestart());
  }

  private async onHeaders(tabId: number, url: string, headers: { name: string; value?: string }[]) {
    if (tabId < 0) return;
    await this.ready;
    const sid = this.tabs.get(tabId);
    if (!sid) return;
    const setCookies = headers.filter((h) => h.name.toLowerCase() === 'set-cookie' && h.value);
    if (!setCookies.length) return;
    const jar = await this.jar(sid);
    let changed = false;
    // extraHeaders may join multiple Set-Cookie headers with newlines.
    for (const h of setCookies) for (const line of h.value!.split('\n')) changed = jar.set(line, url) || changed;
    if (changed) this.jarChanged(sid);
    else if (!this.dirty.has(sid)) {
      // Nothing was stored, so nothing is pending for this session.
      this.stale.delete(sid);
      this.raced.delete(sid);
    }
  }

  private async onOpenedFrom(sourceTabId: number, tabId: number, url: string) {
    await this.ready;
    const sid = this.tabs.get(sourceTabId);
    if (!sid || this.tabs.has(tabId) || !(await this.state.get()).prefs.inheritOpener) return;
    if (resolveSession((await this.state.get()).rules, url)) return; // the mapping redirect decides
    await this.setTab(tabId, sid);
    if (isWebUrl(url)) await browser.tabs.update(tabId, { url });
  }

  private async restoreAfterRestart() {
    await this.ready;
    const hints = await restoreHintsStore.get();
    if (!hints.length) return;
    const sessions = new Set((await this.state.get()).sessions.map((s) => s.id));
    const tabs = await browser.tabs.query({});
    const used = new Set<number>();
    for (const hint of hints) {
      if (!sessions.has(hint.sessionId)) continue;
      const tab = tabs.find((t) => t.id !== undefined && !used.has(t.id) && (t.url ?? t.pendingUrl) === hint.url && t.index === hint.index)
        ?? tabs.find((t) => t.id !== undefined && !used.has(t.id) && (t.url ?? t.pendingUrl) === hint.url);
      if (!tab?.id) continue;
      used.add(tab.id);
      await this.setTab(tab.id, hint.sessionId);
      if (!tab.discarded) await browser.tabs.reload(tab.id);
    }
  }

  // ---------------------------------------------------------------- engine API

  async sync(state: AppState): Promise<void> {
    await this.ready;
    const live = new Set(state.sessions.map((s) => s.id));
    for (const [tabId, sid] of [...this.tabs]) {
      if (!live.has(sid)) {
        await this.setTab(tabId, null);
        await browser.tabs.reload(tabId).catch(() => {});
      }
    }
    const ruleIds = await ruleIdsStore.get();
    for (const sid of Object.keys(ruleIds)) if (sid !== MAPPING_KEY && !live.has(sid)) this.markDirty(sid);
    for (const sid of Object.keys(this.epochs)) {
      if (live.has(sid)) continue;
      delete this.epochs[sid];
      this.jars.delete(sid);
      await jarStore(sid).remove();
    }
    await epochsStore.set(this.epochs);
    this.mappingDirty = true;
    await this.flush();
  }

  async getTabSession(tabId: number): Promise<string | null> {
    await this.ready;
    return this.tabs.get(tabId) ?? null;
  }

  async openInSession(sessionId: string, url?: string): Promise<void> {
    const tab = await browser.tabs.create({ active: true });
    if (tab.id === undefined) return;
    await this.setTab(tab.id, sessionId);
    if (url) await browser.tabs.update(tab.id, { url });
  }

  async assignTab(tabId: number, sessionId: string | null): Promise<void> {
    await this.ready;
    if ((this.tabs.get(tabId) ?? null) === sessionId) return;
    await this.setTab(tabId, sessionId);
    const tab = await browser.tabs.get(tabId);
    if (isWebUrl(tab.url)) await browser.tabs.reload(tabId);
  }

  /** Switch page: put the sending tab in a session without reloading; the page navigates on. */
  async joinSession(tabId: number, sessionId: string): Promise<void> {
    await this.ready;
    if (!(await this.state.get()).sessions.some((s) => s.id === sessionId)) throw new Error('Unknown session');
    if (this.tabs.get(tabId) !== sessionId) await this.setTab(tabId, sessionId);
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.ready;
    (await this.jar(sessionId)).clear();
    this.epochs[sessionId] = (this.epochs[sessionId] ?? 0) + 1;
    await epochsStore.set(this.epochs);
    this.jarChanged(sessionId);
    await this.flush();
    for (const [tabId, sid] of this.tabs) if (sid === sessionId) await browser.tabs.reload(tabId).catch(() => {});
  }

  async exportCookies(sessionId: string): Promise<PortableCookie[]> {
    return (await this.jar(sessionId)).exportPortable();
  }

  async importCookies(sessionId: string, cookies: PortableCookie[]): Promise<void> {
    (await this.jar(sessionId)).importPortable(cookies);
    this.jarChanged(sessionId);
    await this.flush();
  }

  // ---------------------------------------------------------------- page bridge

  /** Bootstrap data for a frame: its tab's session key and the JS-visible cookies for its URL. */
  async pageBootstrap(tabId: number | undefined, frameUrl: string | undefined, topUrl: string | undefined) {
    await this.ready;
    const sid = tabId === undefined ? undefined : this.tabs.get(tabId);
    if (!sid || !frameUrl || !isWebUrl(frameUrl)) return { sessionId: sid ? this.sessionKey(sid) : null, cookies: '' };
    const jar = await this.jar(sid);
    const context = sameSite(frameUrl, topUrl ?? frameUrl) ? 'strict' : 'none';
    return { sessionId: this.sessionKey(sid), cookies: jar.header(frameUrl, context, false) };
  }

  async pageSetCookie(tabId: number | undefined, frameUrl: string | undefined, cookie: string) {
    await this.ready;
    const sid = tabId === undefined ? undefined : this.tabs.get(tabId);
    if (!sid || !isWebUrl(frameUrl)) return;
    if ((await this.jar(sid)).set(cookie, frameUrl, false)) this.jarChanged(sid);
  }

  // ---------------------------------------------------------------- internals

  private async setTab(tabId: number, sessionId: string | null) {
    const prev = this.tabs.get(tabId);
    if (sessionId) this.tabs.set(tabId, sessionId);
    else this.tabs.delete(tabId);
    await tabsStore.set(Object.fromEntries(this.tabs));
    if (prev) this.markDirty(prev);
    if (sessionId) this.markDirty(sessionId);
    await this.flush();
    await this.saveRestoreHints();
  }

  private async saveRestoreHints() {
    const tabs = await browser.tabs.query({});
    const hints = tabs.flatMap((t) => {
      const sid = t.id === undefined ? undefined : this.tabs.get(t.id);
      return sid && isWebUrl(t.url) ? [{ url: t.url, index: t.index, sessionId: sid }] : [];
    });
    await restoreHintsStore.set(hints);
  }

  private async jar(sessionId: string): Promise<SessionJar> {
    let jar = this.jars.get(sessionId);
    if (!jar) {
      jar = new SessionJar((await jarStore(sessionId).get()) ?? undefined);
      // Another caller may have loaded it while we awaited.
      jar = this.jars.get(sessionId) ?? jar;
      this.jars.set(sessionId, jar);
    }
    return jar;
  }

  private jarChanged(sessionId: string) {
    this.markStale(sessionId);
    this.markDirty(sessionId);
    void this.flush().then(() => this.notifyTabs(sessionId));
    clearTimeout(this.saveTimers.get(sessionId));
    this.saveTimers.set(
      sessionId,
      setTimeout(() => {
        const jar = this.jars.get(sessionId);
        if (jar) void jarStore(sessionId).set(jar.serialize());
      }, 300),
    );
  }

  private markDirty(sessionId: string) {
    this.dirty.add(sessionId);
    // Tab membership feeds the mapping rules' excludedTabIds.
    this.mappingDirty = true;
  }

  private markStale(sessionId: string) {
    this.stale.set(sessionId, (this.stale.get(sessionId) ?? 0) + 1);
  }

  /** Recompile all dirty sessions in one atomic DNR update. Calls coalesce while one is in flight. */
  private flush(): Promise<void> {
    if (!this.compileScheduled) {
      this.compileScheduled = (this.queue = this.queue.then(async () => {
        this.compileScheduled = null;
        await this.compileDirty();
      })) as Promise<void>;
    }
    return this.compileScheduled;
  }

  private async compileDirty() {
    const sessions = [...this.dirty];
    this.dirty.clear();
    const mapping = this.mappingDirty;
    this.mappingDirty = false;
    if (!sessions.length && !mapping) return;
    const staleAtStart = new Map(sessions.map((sid) => [sid, this.stale.get(sid)]));

    const [ruleIds, existing] = await Promise.all([ruleIdsStore.get(), dnr().getSessionRules()]);
    let nextId = Math.max(await nextRuleIdStore.get(), ...existing.map((r) => r.id + 1));
    const live = new Set((await this.state.get()).sessions.map((s) => s.id));
    const removeRuleIds: number[] = [];
    const addRules: Browser.declarativeNetRequest.Rule[] = [];

    const otherRegex = existing.filter((r) => r.condition.regexFilter).length
      - sessions.reduce((n, sid) => n + (ruleIds[sid] ?? []).length, 0);
    const budget = Math.max(0, (dnr().MAX_NUMBER_OF_REGEX_RULES ?? 1000) - Math.max(0, otherRegex) - 10);

    for (const sid of sessions) {
      removeRuleIds.push(...(ruleIds[sid] ?? []));
      delete ruleIds[sid];
      const tabIds = [...this.tabs].filter(([, s]) => s === sid).map(([t]) => t);
      if (!tabIds.length || !live.has(sid)) continue;
      const { rules, dropped } = compileSessionRules(this.sessionKey(sid), tabIds, await this.jar(sid), budget / sessions.length);
      if (dropped.length) console.warn(`[SessionStack] session ${sid}: rule budget exhausted, not sending cookies to`, dropped);
      ruleIds[sid] = [];
      for (const rule of rules) {
        const id = nextId++;
        ruleIds[sid].push(id);
        addRules.push({ id, ...rule } as Browser.declarativeNetRequest.Rule);
      }
    }

    if (mapping) {
      removeRuleIds.push(...(ruleIds[MAPPING_KEY] ?? []));
      ruleIds[MAPPING_KEY] = [];
      const userRules = (await this.state.get()).rules
        .filter((r) => r.enabled && live.has(r.sessionId))
        .flatMap((r) => {
          const pattern = compilePattern(r.pattern);
          return pattern ? [{ pattern, sessionId: r.sessionId, priority: r.priority }] : [];
        });
      const bySession = new Map<string, number[]>();
      for (const [tabId, sid] of this.tabs) bySession.set(sid, [...(bySession.get(sid) ?? []), tabId]);
      const origin = browser.runtime.getURL('/').replace(/\/$/, '');
      for (const rule of compileMappingRules(userRules, bySession, origin)) {
        const id = nextId++;
        ruleIds[MAPPING_KEY].push(id);
        addRules.push({ id, ...rule } as Browser.declarativeNetRequest.Rule);
      }
    }

    try {
      await dnr().updateSessionRules({ removeRuleIds, addRules });
    } catch (err) {
      console.error('[SessionStack] DNR update failed; leaving cookie-less base rules only', err);
      const baseOnly = addRules.filter((r) => r.priority === 1);
      for (const sid of sessions) ruleIds[sid] = (ruleIds[sid] ?? []).filter((id) => baseOnly.some((r) => r.id === id));
      await dnr().updateSessionRules({ removeRuleIds, addRules: baseOnly });
    }
    await Promise.all([ruleIdsStore.set(ruleIds), nextRuleIdStore.set(nextId)]);
    this.scheduleExpiryRecompile();

    for (const sid of sessions) {
      // Only once the rules include every change seen so far is a re-navigation worth it.
      if (this.stale.get(sid) !== staleAtStart.get(sid)) continue;
      this.stale.delete(sid);
      const raced = this.raced.get(sid);
      this.raced.delete(sid);
      const jar = await this.jar(sid);
      const latest = new Map((raced ?? []).map((nav) => [nav.tabId, nav]));
      for (const nav of latest.values()) {
        if (this.tabs.get(nav.tabId) !== sid) continue;
        const expected = new Set([jar.header(nav.url, 'strict'), jar.header(nav.url, 'lax')]);
        if (!expected.has(nav.sent)) void this.renavigate(nav);
      }
    }
  }

  /** Load a navigation again once it has committed, unless the user has moved on. */
  private async renavigate(nav: PendingNav) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const tab = await browser.tabs.get(nav.tabId).catch(() => null);
      if (!tab) return;
      if (tab.url === nav.url) {
        await browser.tabs.update(nav.tabId, { url: nav.url }).catch(() => {});
        return;
      }
      // Still committing the raced navigation: wait. (pendingUrl isn't updated across redirects,
      // so it can't tell us where the load is heading.) Done loading elsewhere = user moved on.
      if (tab.status !== 'loading') return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Expired cookies must leave the compiled headers, so recompile at the next expiry. */
  private scheduleExpiryRecompile() {
    clearTimeout(this.expiryTimer);
    let next: number | undefined;
    let sessions: string[] = [];
    for (const [sid, jar] of this.jars) {
      if (![...this.tabs.values()].includes(sid)) continue;
      const t = jar.nextExpiry();
      if (t === undefined) continue;
      if (next === undefined || t < next) [next, sessions] = [t, [sid]];
      else if (t === next) sessions.push(sid);
    }
    if (next === undefined) return;
    // Long timeouts don't survive service-worker shutdown; the next wake recompiles anyway.
    this.expiryTimer = setTimeout(() => {
      sessions.forEach((s) => this.markDirty(s));
      void this.flush();
    }, Math.min(Math.max(next - Date.now(), 0) + 50, 2 ** 31 - 1));
  }

  private async notifyTabs(sessionId: string) {
    for (const [tabId, sid] of this.tabs) {
      if (sid === sessionId) browser.tabs.sendMessage(tabId, { type: 'cookiesChanged' }).catch(() => {});
    }
  }
}

/** Same registrable domain ("site"), falling back to the host for localhost, IPs and special-use names. */
export function sameSite(a: string, b: string): boolean {
  try {
    const site = (u: string) => {
      const host = new URL(u).hostname;
      return getDomain(host, { allowPrivateDomains: true }) ?? host;
    };
    return site(a) === site(b);
  } catch {
    return false;
  }
}
