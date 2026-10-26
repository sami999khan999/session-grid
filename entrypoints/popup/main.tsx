import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { call } from '../../src/core/messages';
import { SESSION_COLORS } from '../../src/core/types';
import { draftSession } from '../../src/ui/sessions';
import { useAppState } from '../../src/ui/useAppState';
import '../../src/ui/theme.css';
import './style.css';

function Popup() {
  const state = useAppState();
  const [tab, setTab] = useState<{ id: number; sessionId: string | null; web: boolean } | null>(null);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');

  const refreshTab = async () => {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    if (active?.id === undefined) return;
    const info = await call('getTabInfo', { tabId: active.id });
    setTab({ id: active.id, sessionId: info.sessionId, web: /^https?:/.test(active.url ?? '') });
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
      <header>
        <h1>SessionStack</h1>
        <div class="row muted">
          This tab:
          {current ? (
            <span class="row" style={{ gap: 5 }}>
              <span class="dot" style={{ background: SESSION_COLORS[current.color] }} />
              <strong style={{ color: 'var(--text)' }}>{current.name}</strong>
            </span>
          ) : (
            <span>default browser session</span>
          )}
        </div>
      </header>

      {state.sessions.length === 0 ? (
        <p class="empty muted">No sessions yet. Create one below, then open a tab in it and sign in.</p>
      ) : (
        <ul>
          {state.sessions.map((s, i) => (
            <li key={s.id} class={`row ${s.id === tab?.sessionId ? 'current' : ''}`}>
              <span class="dot" style={{ background: SESSION_COLORS[s.color] }} />
              <div class="grow">
                <div class="name truncate">{s.name}</div>
                <div class="tag muted">
                  {s.tag}
                  {i < 4 ? ` · Alt+Shift+${i + 1}` : ''}
                </div>
              </div>
              {tab?.web && s.id !== tab.sessionId && (
                <button title="Reload this tab in this session" onClick={run(() => call('assignTab', { tabId: tab.id, sessionId: s.id }))}>
                  Move here
                </button>
              )}
              <button class="primary" title="Open a new tab in this session" onClick={run(() => call('openInSession', { sessionId: s.id }), true)}>
                New tab
              </button>
            </li>
          ))}
          {tab?.web && tab.sessionId && (
            <li class="row">
              <span class="dot" style={{ background: 'var(--border)' }} />
              <div class="grow muted">Default browser session</div>
              <button onClick={run(() => call('assignTab', { tabId: tab.id, sessionId: null }))}>Move here</button>
            </li>
          )}
        </ul>
      )}

      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await call('saveSession', { session: draftSession(state.sessions, newName) });
            setNewName('');
          })();
        }}
      >
        <input class="grow" placeholder="New session name" value={newName} onInput={(e) => setNewName(e.currentTarget.value)} />
        <button type="submit">Add</button>
      </form>
      {error && <p class="error">{error}</p>}
      <footer>
        <button class="link" onClick={() => void browser.runtime.openOptionsPage()}>
          Manage sessions & rules
        </button>
      </footer>
    </>
  );
}

render(<Popup />, document.getElementById('app')!);
