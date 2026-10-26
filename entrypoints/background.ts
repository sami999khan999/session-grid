import { encryptJson, decryptJson } from '../src/core/crypto';
import { serve } from '../src/core/messages';
import { loadState, onStateChanged, saveState } from '../src/core/store';
import { SESSION_COLORS, type AppState, type PortableCookie, type Rule, type Session } from '../src/core/types';
import { ChromeEngine } from '../src/engines/chromium';
import type { IsolationEngine } from '../src/engines/engine';
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

  async function refreshBadge(tabId: number) {
    const sid = await engine.getTabSession(tabId).catch(() => null);
    const session = sid ? (await state.get()).sessions.find((s) => s.id === sid) : undefined;
    await browser.action.setBadgeText({ tabId, text: session ? session.tag.slice(0, 4) : '' }).catch(() => {});
    if (session) await browser.action.setBadgeBackgroundColor({ tabId, color: SESSION_COLORS[session.color] }).catch(() => {});
  }

  async function refreshAllBadges() {
    for (const tab of await browser.tabs.query({})) if (tab.id !== undefined) await refreshBadge(tab.id);
  }

  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' || info.url) void refreshBadge(tabId);
  });
  browser.tabs.onActivated.addListener(({ tabId }) => void refreshBadge(tabId));

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
