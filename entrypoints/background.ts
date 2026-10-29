import { encryptJson, decryptJson } from '../src/core/crypto';
import { badgedFavicon, inkFor } from '../src/core/favicon';
import { serve } from '../src/core/messages';
import { kv, loadState, onStateChanged, saveState } from '../src/core/store';
import { SESSION_COLORS, type AppState, type PortableCookie, type Rule, type Session } from '../src/core/types';
import { ChromeEngine } from '../src/engines/chromium';
import { TabGrouper } from '../src/engines/chromium/groups';
import { isWebUrl, type IsolationEngine } from '../src/engines/engine';
import { FirefoxEngine } from '../src/engines/firefox';

interface ExportPayload {
  version: 1;
  exportedAt: string;
  sessions: Session[];
  rules: Rule[];
  cookies: Record<string, PortableCookie[]>;
}

export default defineBackground(() => {
  let cached: Promise<AppState> | null = null;
  const state = { get: () => (cached ??= loadState()) };
  onStateChanged((s) => (cached = Promise.resolve(s)));

  const chrome = import.meta.env.FIREFOX ? null : new ChromeEngine(state);
  const engine: IsolationEngine = chrome ?? new FirefoxEngine(state);
  const grouper = chrome ? new TabGrouper() : null;
  engine.attach();

  async function update(mutate: (s: AppState) => void): Promise<AppState> {
    const s = structuredClone(await state.get());
    mutate(s);
    cached = Promise.resolve(s);
    await saveState(s);
    await engine.sync(s);
    await refreshAllBadges();
    return s;
  }

  // ------------------------------------------------------------------ badges

  async function tabSession(tabId: number): Promise<Session | undefined> {
    const sid = await engine.getTabSession(tabId).catch(() => null);
    return sid ? (await state.get()).sessions.find((s) => s.id === sid) : undefined;
  }

  async function refreshBadge(tabId: number) {
    const session = await tabSession(tabId);
    await grouper?.sync(tabId, session, (await state.get()).prefs.tabGroups);
    // Three characters is what the toolbar badge fits without clipping.
    await browser.action.setBadgeText({ tabId, text: session ? session.tag.slice(0, 3) : '' }).catch(() => {});
    scheduleSnapshot();
    if (!session) return;
    const color = SESSION_COLORS[session.color];
    await browser.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
    await browser.action.setBadgeTextColor?.({ tabId, color: inkFor(color) }).catch(() => {});
  }

  // ------------------------------------------------------------------ saved tabs

  // Each session's tabs (URLs in window and strip order), so the popup's Open can bring them
  // back. A session with no open tabs keeps its last snapshot: closing its group, its window or
  // the browser leaves behind what was open.
  const savedTabs = kv<Record<string, string[]>>('local', 'savedTabs', {});
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleSnapshot() {
    clearTimeout(snapshotTimer);
    // Closing a group removes its tabs one by one; wait until they're all gone.
    snapshotTimer = setTimeout(() => void snapshot(), 1500);
  }

  async function openTabsBySession() {
    const tabs = (await browser.tabs.query({})).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    const open: Record<string, Browser.tabs.Tab[]> = {};
    for (const tab of tabs) {
      const sid = tab.id === undefined ? null : await engine.getTabSession(tab.id).catch(() => null);
      if (sid) (open[sid] ??= []).push(tab);
    }
    return open;
  }

  async function snapshot() {
    const live = new Set((await state.get()).sessions.map((s) => s.id));
    const next = Object.fromEntries(Object.entries(await savedTabs.get()).filter(([sid]) => live.has(sid)));
    for (const [sid, tabs] of Object.entries(await openTabsBySession())) {
      const urls = tabs.map((t) => t.url || t.pendingUrl).filter(isWebUrl);
      if (urls.length) next[sid] = urls;
    }
    await savedTabs.set(next);
  }

  async function refreshAllBadges() {
    for (const tab of await browser.tabs.query({})) if (tab.id !== undefined) await refreshBadge(tab.id);
    await grouper?.prune((await state.get()).sessions);
  }

  // Favicon badge (Chrome; Firefox marks container tabs itself). The page's own favicon, as the
  // browser resolved it, gets the session lamp and is handed to the tab's bridge to display.
  // `applied` and `lampBase` recognise icons we set, so the resulting favIconUrl change doesn't loop.
  const applied = new Map<number, string>();
  const lampBase = browser.runtime.getURL('/favicon/' as '/');
  async function refreshFavicon(tabId: number, favIconUrl: string | undefined) {
    if (!chrome || (favIconUrl && (applied.get(tabId) === favIconUrl || favIconUrl.startsWith(lampBase)))) return;
    const session = await tabSession(tabId);
    if (!session || !(await state.get()).prefs.faviconBadge) return;
    const href = await badgedFavicon(favIconUrl, SESSION_COLORS[session.color], session.tag);
    applied.set(tabId, href);
    // A strict img-src CSP blocks the data: icon. Extension files are exempt, so the bridge then
    // falls back to the plain lamp for the session's colour.
    const fallback = `${lampBase}${session.color}.png`;
    await browser.tabs.sendMessage(tabId, { type: 'favicon', href, fallback }, { frameId: 0 }).catch(() => {});
  }

  // Chrome often learns the favicon after `complete`. Give it a moment, then fall back to the
  // conventional /favicon.ico (a plain lettered tile if that fails too).
  async function faviconAfterLoad(tabId: number) {
    await new Promise((r) => setTimeout(r, 1000));
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab?.url || tab.favIconUrl) return;
    const origin = /^https?:/.test(tab.url) ? new URL(tab.url).origin : null;
    await refreshFavicon(tabId, origin ? `${origin}/favicon.ico` : undefined);
  }

  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.groupId !== undefined) void groupChanged(tabId, info.groupId);
    if (info.status || info.url || info.pinned === false) void refreshBadge(tabId);
    if (info.favIconUrl !== undefined) void refreshFavicon(tabId, info.favIconUrl);
    else if (info.status === 'complete' && !tab.favIconUrl) void faviconAfterLoad(tabId);
  });
  browser.tabs.onActivated.addListener(({ tabId }) => void refreshBadge(tabId));
  // A tab dragged to another window joins its session's group there.
  const attachedAt = new Map<number, number>();
  browser.tabs.onAttached.addListener((tabId) => {
    attachedAt.set(tabId, Date.now());
    void refreshBadge(tabId);
  });

  // Group membership follows the user's drags: into a session's group moves the tab into that
  // session; out of it returns the tab to the default session. Our own grouping always matches
  // the tab's session, so it never triggers a move.
  async function groupChanged(tabId: number, groupId: number) {
    if (!grouper || !(await state.get()).prefs.tabGroups) return;
    const current = await engine.getTabSession(tabId).catch(() => null);
    if (groupId !== -1) {
      const target = await grouper.sessionOf(groupId);
      if (target && target !== current) await moveTab(tabId, target);
      return;
    }
    if (!current) return;
    // Leaving a group is also what pinning a tab or dragging it to another window looks like.
    await new Promise((r) => setTimeout(r, 500));
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab || tab.pinned || tab.groupId !== -1 || Date.now() - (attachedAt.get(tabId) ?? 0) < 2000) return;
    if ((await engine.getTabSession(tabId).catch(() => null)) === current) await moveTab(tabId, null);
  }

  async function moveTab(tabId: number, sessionId: string | null) {
    await engine.assignTab(tabId, sessionId).catch(() => {});
    await refreshBadge(tabId);
  }
  browser.tabs.onRemoved.addListener((tabId, { isWindowClosing }) => {
    applied.delete(tabId);
    attachedAt.delete(tabId);
    if (!isWindowClosing) scheduleSnapshot();
  });
  browser.tabs.onMoved.addListener(scheduleSnapshot);

  // ------------------------------------------------------------------ hotkeys

  browser.commands.onCommand.addListener((command) => {
    const n = /^open-session-(\d)$/.exec(command)?.[1];
    if (!n) return;
    void state.get().then((s) => {
      const session = s.sessions[+n - 1];
      if (session) return engine.openInSession(session.id);
    });
  });

  // ------------------------------------------------------------------ API

  serve({
    getState: () => state.get(),

    async saveSession({ session }) {
      const clean: Session = { ...session, name: session.name.trim() || 'Session', tag: session.tag.trim().slice(0, 12) };
      await update((s) => {
        const i = s.sessions.findIndex((x) => x.id === clean.id);
        if (i >= 0) s.sessions[i] = clean;
        else s.sessions.push(clean);
      });
      return clean;
    },

    async deleteSession({ id }) {
      await update((s) => {
        s.sessions = s.sessions.filter((x) => x.id !== id);
        s.rules = s.rules.filter((r) => r.sessionId !== id);
      });
    },

    async clearSession({ id }) {
      await engine.clearSession(id);
    },

    async reorderSessions({ ids }) {
      await update((s) => {
        s.sessions.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      });
    },

    async saveRules({ rules }) {
      await update((s) => {
        const live = new Set(s.sessions.map((x) => x.id));
        s.rules = rules.filter((r) => live.has(r.sessionId));
      });
    },

    async setPrefs({ prefs }) {
      await update((s) => {
        s.prefs = { ...s.prefs, ...prefs };
      });
    },

    async openInSession({ sessionId, url }) {
      await engine.openInSession(sessionId, url);
    },

    async resumeSession({ sessionId }) {
      const open = (await openTabsBySession())[sessionId];
      if (open?.length) {
        const tab = open.find((t) => t.active) ?? open[0]!;
        await browser.tabs.update(tab.id!, { active: true });
        await browser.windows.update(tab.windowId, { focused: true });
        return;
      }
      const urls = (await savedTabs.get())[sessionId] ?? [];
      if (!urls.length) return engine.openInSession(sessionId);
      for (const [i, url] of urls.entries()) await engine.openInSession(sessionId, url, i === 0);
    },

    async sessionTabs() {
      const [open, saved, s] = await Promise.all([openTabsBySession(), savedTabs.get(), state.get()]);
      return Object.fromEntries(s.sessions.map((x) => [x.id, { open: open[x.id]?.length ?? 0, saved: saved[x.id]?.length ?? 0 }]));
    },

    async assignTab({ tabId, sessionId }) {
      await engine.assignTab(tabId, sessionId);
      await refreshBadge(tabId);
    },

    async joinSession({ sessionId }, sender) {
      if (!chrome || sender.tab?.id === undefined) throw new Error('Not available');
      await chrome.joinSession(sender.tab.id, sessionId);
      await refreshBadge(sender.tab.id);
    },

    async getTabInfo({ tabId }) {
      return { tabId, sessionId: await engine.getTabSession(tabId) };
    },

    async exportData({ passphrase }) {
      if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
      const s = await state.get();
      const cookies: Record<string, PortableCookie[]> = {};
      for (const session of s.sessions) cookies[session.id] = await engine.exportCookies(session.id);
      const payload: ExportPayload = { version: 1, exportedAt: new Date().toISOString(), sessions: s.sessions, rules: s.rules, cookies };
      return JSON.stringify(await encryptJson(payload, passphrase), null, 2);
    },

    async importData({ text, passphrase, mode }) {
      let envelope: unknown;
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new Error('That file is not valid JSON.');
      }
      const data = await decryptJson<ExportPayload>(envelope, passphrase);
      if (data.version !== 1 || !Array.isArray(data.sessions)) throw new Error('Unsupported export version.');
      await update((s) => {
        if (mode === 'replace') {
          s.sessions = data.sessions;
          s.rules = data.rules;
          return;
        }
        for (const session of data.sessions) {
          const i = s.sessions.findIndex((x) => x.id === session.id);
          if (i >= 0) s.sessions[i] = session;
          else s.sessions.push(session);
        }
        const ruleIds = new Set(data.rules.map((r) => r.id));
        s.rules = [...s.rules.filter((r) => !ruleIds.has(r.id)), ...data.rules];
      });
      for (const session of data.sessions) {
        const cookies = data.cookies[session.id];
        if (cookies?.length) await engine.importCookies(session.id, cookies);
      }
      return { sessions: data.sessions.length, rules: data.rules.length };
    },

    async pageSetCookie({ cookie }, sender) {
      await chrome?.pageSetCookie(sender.tab?.id, sender.url, cookie);
    },

    async pageBootstrap(_req, sender) {
      if (!chrome) return { sessionId: null, cookies: '' };
      const boot = await chrome.pageBootstrap(sender.tab?.id, sender.url, sender.tab?.url);
      const s = await state.get();
      const sid = boot.sessionId?.split('.')[0];
      const tag = s.prefs.titlePrefix ? s.sessions.find((x) => x.id === sid)?.tag : undefined;
      return tag ? { ...boot, title: tag } : boot;
    },
  });

  void state.get().then((s) => engine.sync(s)).then(refreshAllBadges);
});
