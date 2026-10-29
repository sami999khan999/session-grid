import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { call } from '../../src/core/messages';
import { SESSION_COLORS } from '../../src/core/types';
import { mountGlassScroll } from '../../src/ui/scroll';
import { draftSession } from '../../src/ui/sessions';
import { useAppState } from '../../src/ui/useAppState';
import '../../src/ui/theme.css';
import './style.css';

function Popup() {
  const state = useAppState();
  const [tab, setTab] = useState<{ id: number; sessionId: string | null; web: boolean } | null>(null);
  const [tabCounts, setTabCounts] = useState<Record<string, { open: number; saved: number }>>({});
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');

  const refreshTab = async () => {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    if (active?.id === undefined) return;
    const info = await call('getTabInfo', { tabId: active.id });
    setTab({ id: active.id, sessionId: info.sessionId, web: /^https?:/.test(active.url ?? '') });
    setTabCounts(await call('sessionTabs', {}));
  };
  useEffect(() => void refreshTab(), []);

  const run = (fn: () => Promise<unknown>, close = false) => async () => {
    setError('');
    try {
      await fn();
      if (close) window.close();
      else await refreshTab();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!state) return null;
  const current = state.sessions.find((s) => s.id === tab?.sessionId);

  return (
    <>
      <header class="sky">
        <div class="row">
          <h1 class="row grow">
            <span class="cube bob" aria-hidden="true" />
            <span class="title">SessionStack</span>
          </h1>
          <span class="island bob deco" aria-hidden="true" />
          <button class="ghost" title="Manage sessions, rules and backups" onClick={() => void browser.runtime.openOptionsPage()}>
            Settings
          </button>
        </div>
        <div class="gauge row">
          <span class={`dot ${current ? '' : 'none'}`} style={current ? { background: SESSION_COLORS[current.color] } : undefined} />
          <div class="grow">
            <div class="label">This tab</div>
            <div class="truncate">{current ? <strong>{current.name}</strong> : 'Default browser session'}</div>
          </div>
          {tab?.web && current && (
            <button class="ghost" title="Reload this tab in the default browser session" onClick={run(() => call('assignTab', { tabId: tab.id, sessionId: null }))}>
              Leave
            </button>
          )}
        </div>
      </header>

      <div class="section-label row">
        <span class="grow">Sessions</span>
        <span>{state.sessions.length}</span>
      </div>

      {state.sessions.length === 0 ? (
        <p class="empty muted">No sessions yet. Create one below, then open a tab in it and sign in.</p>
      ) : (
        <ul>
          {state.sessions.map((s, i) => {
            const here = s.id === tab?.sessionId;
            const { open = 0, saved = 0 } = tabCounts[s.id] ?? {};
            const plural = (n: number) => `${n} tab${n === 1 ? '' : 's'}`;
            return (
              <li key={s.id} class={here ? 'current' : ''} style={{ '--c': SESSION_COLORS[s.color] }}>
                <div class="top row">
                  <span class="name grow truncate">{s.name}</span>
                  {here ? (
                    <span class="stamp">Active</span>
                  ) : (
                    (open || saved) > 0 && <span class={`count ${open ? 'live' : ''}`}>{open ? `${open} open` : `${saved} saved`}</span>
                  )}
                </div>
                <div class="bottom row">
                  <span class="chip">{s.tag}</span>
                  {i < 4 && <kbd>Alt+Shift+{i + 1}</kbd>}
                  <span class="grow" />
                  {!here && tab?.web && (
                    <button class="ghost" title="Reload this tab in this session" onClick={run(() => call('assignTab', { tabId: tab.id, sessionId: s.id }))}>
                      Move
                    </button>
                  )}
                  <button class="ghost icon" title="Open a new tab in this session" aria-label="New tab" onClick={run(() => call('openInSession', { sessionId: s.id }), true)}>
                    +
                  </button>
                  <button
                    class="primary small open"
                    title={open ? `Switch to this session's ${plural(open)}` : saved ? `Reopen ${plural(saved)} from last time` : 'Open a new tab in this session'}
                    onClick={run(() => call('resumeSession', { sessionId: s.id }), true)}
                  >
                    {open ? 'Show' : 'Open'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {error && <p class="error">{error}</p>}
      <form
        class="row plate"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await call('saveSession', { session: draftSession(state.sessions, newName) });
            setNewName('');
          })();
        }}
      >
        <input class="grow" placeholder="New session name" aria-label="New session name" value={newName} onInput={(e) => setNewName(e.currentTarget.value)} />
        <button type="submit">Add</button>
      </form>
    </>
  );
}

render(<Popup />, document.getElementById('app')!);
mountGlassScroll();
