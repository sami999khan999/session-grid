import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { call } from '../../src/core/messages';
import { isValidPattern } from '../../src/core/rules';
import { SESSION_COLORS, newId, type AppState, type Rule, type Session, type SessionColor } from '../../src/core/types';
import { draftSession } from '../../src/ui/sessions';
import { isFirefox, useAppState } from '../../src/ui/useAppState';
import '../../src/ui/theme.css';
import './style.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function SessionRow({ session }: { session: Session }) {
  const [draft, setDraft] = useState(session);
  const [confirm, setConfirm] = useState<'clear' | 'delete' | null>(null);
  useEffect(() => setDraft(session), [session]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(session);

  return (
    <div class="row">
      <span class="dot" style={{ background: SESSION_COLORS[draft.color] }} />
      <input class="grow" aria-label="Name" value={draft.name} onInput={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
      <input class="tag" aria-label="Badge tag" maxLength={12} value={draft.tag} onInput={(e) => setDraft({ ...draft, tag: e.currentTarget.value })} />
      <select aria-label="Color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.currentTarget.value as SessionColor })}>
        {Object.keys(SESSION_COLORS).map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      {dirty && <button class="primary" onClick={() => void call('saveSession', { session: draft })}>Save</button>}
      <button onClick={() => void call('openInSession', { sessionId: session.id })}>Open tab</button>
      {confirm ? (
        <>
          <button
            class="danger"
            onClick={() => {
              setConfirm(null);
              void (confirm === 'clear' ? call('clearSession', { id: session.id }) : call('deleteSession', { id: session.id }));
            }}
          >
            {confirm === 'clear' ? 'Confirm sign-out' : 'Confirm delete'}
          </button>
          <button onClick={() => setConfirm(null)}>Cancel</button>
        </>
      ) : (
        <>
          <button title="Delete this session's cookies and site data" onClick={() => setConfirm('clear')}>Clear data</button>
          <button class="danger" onClick={() => setConfirm('delete')}>Delete</button>
        </>
      )}
    </div>
  );
}

function Rules({ state }: { state: AppState }) {
  const [rules, setRules] = useState<Rule[]>(state.rules);
  const [saved, setSaved] = useState('');
  useEffect(() => setRules(state.rules), [state.rules]);
  const dirty = JSON.stringify(rules) !== JSON.stringify(state.rules);
  const invalid = rules.some((r) => !isValidPattern(r.pattern));
  const patch = (id: string, p: Partial<Rule>) => setRules(rules.map((r) => (r.id === id ? { ...r, ...p } : r)));

  if (!state.sessions.length) return <p class="muted">Create a session first.</p>;
  return (
    <>
      <div class="card">
        {rules.length === 0 && <p class="empty muted">No rules. Example: <code>*.staging.example.com</code> → Staging.</p>}
        {rules.map((r) => (
          <div class="row" key={r.id}>
            <input type="checkbox" aria-label="Enabled" checked={r.enabled} onChange={(e) => patch(r.id, { enabled: e.currentTarget.checked })} />
            <input
              class="grow"
              aria-label="URL pattern"
              placeholder="*.dev.example.com or https://example.com/admin/*"
              aria-invalid={!isValidPattern(r.pattern)}
              value={r.pattern}
              onInput={(e) => patch(r.id, { pattern: e.currentTarget.value })}
            />
            <span class="muted">→</span>
            <select aria-label="Session" value={r.sessionId} onChange={(e) => patch(r.id, { sessionId: e.currentTarget.value })}>
              {state.sessions.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <input class="prio" type="number" aria-label="Priority" title="Higher wins" value={r.priority} onInput={(e) => patch(r.id, { priority: Number(e.currentTarget.value) || 0 })} />
            <button class="danger" onClick={() => setRules(rules.filter((x) => x.id !== r.id))}>Remove</button>
          </div>
        ))}
      </div>
      <div class="row actions">
        <button onClick={() => setRules([...rules, { id: newId(), pattern: '', sessionId: state.sessions[0]!.id, priority: 0, enabled: true }])}>Add rule</button>
        <button
          class="primary"
          disabled={!dirty || invalid}
          onClick={() => void call('saveRules', { rules }).then(() => setSaved('Rules saved.'), (e) => setSaved(errorText(e)))}
        >
          Save rules
        </button>
        {invalid && <span class="error">Fix the highlighted patterns.</span>}
        {!dirty && saved && <span class="muted">{saved}</span>}
      </div>
    </>
  );
}

function Backup() {
  const [passphrase, setPassphrase] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const act = (fn: () => Promise<string>) => async () => {
    setBusy(true);
    setStatus(null);
    try {
      setStatus({ text: await fn() });
    } catch (e) {
      setStatus({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const doExport = act(async () => {
    const text = await call('exportData', { passphrase });
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `sessionstack-${new Date().toISOString().slice(0, 10)}.sessionstack.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return 'Export downloaded. Keep it private: it contains live sign-in cookies.';
  });

  const doImport = act(async () => {
    const r = await call('importData', { text: await file!.text(), passphrase, mode });
    return `Imported ${r.sessions} session(s) and ${r.rules} rule(s).`;
  });

  return (
    <div class="card">
      <div class="row">
        <input class="grow" type="password" placeholder="Passphrase (8+ characters)" autocomplete="new-password" value={passphrase} onInput={(e) => setPassphrase(e.currentTarget.value)} />
        <button class="primary" disabled={busy || passphrase.length < 8} onClick={doExport}>Export</button>
      </div>
      <div class="row">
        <input class="grow" type="file" accept=".json,application/json" onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
        <select aria-label="Import mode" value={mode} onChange={(e) => setMode(e.currentTarget.value as 'merge' | 'replace')}>
          <option value="merge">Merge</option>
          <option value="replace">Replace all</option>
        </select>
        <button disabled={busy || !file || !passphrase} onClick={doImport}>Import</button>
      </div>
      {status && <div class={`row status ${status.error ? 'error' : 'muted'}`}>{status.text}</div>}
    </div>
  );
}

function Options() {
  const state = useAppState();
  if (!state) return null;
  return (
    <main>
      <h1>SessionStack</h1>
      <p class="muted">Each session has its own cookies and site storage. Open a tab in a session and sign in. Other tabs stay signed in as someone else.</p>

      <section>
        <h2>Sessions</h2>
        <p class="muted">The tag shows on the toolbar badge. The first four sessions have hotkeys (Alt+Shift+1…4).</p>
        <div class="card">
          {state.sessions.length === 0 && <p class="empty muted">No sessions yet.</p>}
          {state.sessions.map((s) => (
            <SessionRow key={s.id} session={s} />
          ))}
        </div>
        <div class="row actions">
          <button class="primary" onClick={() => void call('saveSession', { session: draftSession(state.sessions) })}>New session</button>
        </div>
      </section>

      <section>
        <h2>Auto-session rules</h2>
        <p class="muted">Navigating to a matching URL moves the tab into that session. A bare host glob matches any scheme and path. The highest priority wins.</p>
        <Rules state={state} />
      </section>

      {!isFirefox && (
        <section>
          <h2>Preferences</h2>
          <label class="check">
            <input type="checkbox" checked={state.prefs.inheritOpener} onChange={(e) => void call('setPrefs', { prefs: { inheritOpener: e.currentTarget.checked } })} />
            <span>Links and pop-ups opened from a session tab stay in that session</span>
          </label>
          <label class="check">
            <input type="checkbox" checked={state.prefs.titlePrefix} onChange={(e) => void call('setPrefs', { prefs: { titlePrefix: e.currentTarget.checked } })} />
            <span>Prefix tab titles with the session tag, e.g. <code>[DEV] Dashboard</code></span>
          </label>
        </section>
      )}

      <section>
        <h2>Export / import</h2>
        <p class="muted">Sessions, rules and cookies, encrypted with your passphrase (AES-GCM-256). Site storage is not included.</p>
        <Backup />
      </section>

      <section>
        <h2>Known limitations</h2>
        {isFirefox ? (
          <ul class="limits muted">
            <li>Sessions are Firefox containers. Moving a tab between sessions reopens it, because Firefox can't move a tab between containers.</li>
          </ul>
        ) : (
          <ul class="limits muted">
            <li>Isolation covers cookies, <code>localStorage</code> and <code>sessionStorage</code>. IndexedDB, Cache Storage and site service workers are shared with the default session.</li>
            <li>A pop-up or link opened from a session tab may send one request with default-session cookies before it reloads in the session.</li>
            <li>After a browser restart, session tabs are matched back by URL. Tabs that can't be matched return to the default session.</li>
          </ul>
        )}
      </section>
    </main>
  );
}

render(<Options />, document.getElementById('app')!);
