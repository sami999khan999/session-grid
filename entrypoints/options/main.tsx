import { render, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { call } from '../../src/core/messages';
import { isValidPattern } from '../../src/core/rules';
import { SESSION_COLORS, newId, type AppState, type Rule, type Session, type SessionColor } from '../../src/core/types';
import { mountGlassScroll } from '../../src/ui/scroll';
import { draftSession } from '../../src/ui/sessions';
import { isFirefox, useAppState } from '../../src/ui/useAppState';
import '../../src/ui/theme.css';
import './style.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function SessionCard({ session, index }: { session: Session; index: number }) {
  const [draft, setDraft] = useState(session);
  const [confirm, setConfirm] = useState<'clear' | 'delete' | null>(null);
  useEffect(() => setDraft(session), [session]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(session);

  return (
    <article class="session plate" style={{ '--lamp': SESSION_COLORS[draft.color] } as Record<string, string>}>
      <div class="row">
        <span class="dot lg" style={{ background: SESSION_COLORS[draft.color] }} />
        <input class="grow name" aria-label="Name" value={draft.name} onInput={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
        {index < 4 && <kbd title="Opens a new tab in this session">Alt+Shift+{index + 1}</kbd>}
      </div>
      <div class="fields">
        <label class="field">
          <span>Badge</span>
          <input class="tag" maxLength={12} value={draft.tag} onInput={(e) => setDraft({ ...draft, tag: e.currentTarget.value })} />
        </label>
        <div class="field grow">
          <span id={`color-${session.id}`}>Lamp</span>
          <div class="swatches" role="radiogroup" aria-labelledby={`color-${session.id}`}>
            {(Object.keys(SESSION_COLORS) as SessionColor[]).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={draft.color === c}
                aria-label={c}
                title={c}
                class="swatch"
                style={{ background: SESSION_COLORS[c] }}
                onClick={() => setDraft({ ...draft, color: c })}
              />
            ))}
          </div>
        </div>
      </div>
      <div class="row foot">
        {confirm ? (
          <>
            <span class="grow error">{confirm === 'clear' ? 'Sign out everywhere in this session?' : 'Delete this session?'}</span>
            <button class="small" onClick={() => setConfirm(null)}>Cancel</button>
            <button
              class="danger small"
              onClick={() => {
                setConfirm(null);
                void (confirm === 'clear' ? call('clearSession', { id: session.id }) : call('deleteSession', { id: session.id }));
              }}
            >
              {confirm === 'clear' ? 'Clear data' : 'Delete'}
            </button>
          </>
        ) : (
          <>
            <button class="primary small" onClick={() => void call('openInSession', { sessionId: session.id })}>Open tab</button>
            {dirty && <button class="small" onClick={() => void call('saveSession', { session: draft })}>Save</button>}
            <span class="grow" />
            <button class="ghost" title="Delete this session's cookies and site data" onClick={() => setConfirm('clear')}>Clear data</button>
            <button class="ghost danger" onClick={() => setConfirm('delete')}>Delete</button>
          </>
        )}
      </div>
    </article>
  );
}

function Rules({ state }: { state: AppState }) {
  const [rules, setRules] = useState<Rule[]>(state.rules);
  const [saved, setSaved] = useState('');
  useEffect(() => setRules(state.rules), [state.rules]);
  const dirty = JSON.stringify(rules) !== JSON.stringify(state.rules);
  const invalid = rules.some((r) => !isValidPattern(r.pattern));
  const patch = (id: string, p: Partial<Rule>) => setRules(rules.map((r) => (r.id === id ? { ...r, ...p } : r)));

  if (!state.sessions.length) return <p class="card plate empty muted">Create a session first.</p>;
  return (
    <div class="card plate">
      {rules.length === 0 ? (
        <p class="empty muted">No rules. Example: <code>*.staging.example.com</code> → Staging.</p>
      ) : (
        <div class="rules">
          <div class="rule-row head" aria-hidden="true">
            <span>On</span>
            <span>URL pattern</span>
            <span />
            <span>Session</span>
            <span>Priority</span>
            <span />
          </div>
          {rules.map((r) => (
            <div class="rule-row" key={r.id}>
              <input type="checkbox" aria-label="Enabled" checked={r.enabled} onChange={(e) => patch(r.id, { enabled: e.currentTarget.checked })} />
              <input
                aria-label="URL pattern"
                placeholder="*.dev.example.com or https://example.com/admin/*"
                aria-invalid={!isValidPattern(r.pattern)}
                value={r.pattern}
                onInput={(e) => patch(r.id, { pattern: e.currentTarget.value })}
              />
              <span class="arrow" aria-hidden="true">→</span>
              <select aria-label="Session" value={r.sessionId} onChange={(e) => patch(r.id, { sessionId: e.currentTarget.value })}>
                {state.sessions.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <input type="number" aria-label="Priority" title="Higher wins" value={r.priority} onInput={(e) => patch(r.id, { priority: Number(e.currentTarget.value) || 0 })} />
              <button class="ghost danger" aria-label="Remove rule" title="Remove rule" onClick={() => setRules(rules.filter((x) => x.id !== r.id))}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div class="row bar">
        <button class="small" onClick={() => setRules([...rules, { id: newId(), pattern: '', sessionId: state.sessions[0]!.id, priority: 0, enabled: true }])}>Add rule</button>
        <span class="grow">
          {invalid && <span class="error">Fix the highlighted patterns.</span>}
          {!invalid && !dirty && saved && <span class="muted">{saved}</span>}
          {!invalid && dirty && <span class="muted">Unsaved changes</span>}
        </span>
        <button
          class="primary small"
          disabled={!dirty || invalid}
          onClick={() => void call('saveRules', { rules }).then(() => setSaved('Rules saved.'), (e) => setSaved(errorText(e)))}
        >
          Save rules
        </button>
      </div>
    </div>
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
    <div class="card plate backup">
      <label class="field">
        <span>Passphrase</span>
        <input type="password" placeholder="8+ characters, used for both export and import" autocomplete="new-password" value={passphrase} onInput={(e) => setPassphrase(e.currentTarget.value)} />
      </label>
      <div class="split">
        <div class="pane">
          <h3>Export</h3>
          <p class="muted">Download an encrypted file with all sessions, rules and cookies.</p>
          <button class="primary" disabled={busy || passphrase.length < 8} onClick={doExport}>Export</button>
        </div>
        <div class="pane">
          <h3>Import</h3>
          <input type="file" aria-label="Export file" accept=".json,application/json" onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
          <div class="row">
            <select class="grow" aria-label="Import mode" value={mode} onChange={(e) => setMode(e.currentTarget.value as 'merge' | 'replace')}>
              <option value="merge">Merge with current</option>
              <option value="replace">Replace all</option>
            </select>
            <button disabled={busy || !file || !passphrase} onClick={doImport}>Import</button>
          </div>
        </div>
      </div>
      {status && <div class={`status ${status.error ? 'error' : 'muted'}`}>{status.text}</div>}
    </div>
  );
}

function Toggle({ checked, onChange, title, children }: { checked: boolean; onChange: (v: boolean) => void; title: string; children: ComponentChildren }) {
  return (
    <label class="toggle">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span class="lever" aria-hidden="true" />
      <span class="grow">
        <strong>{title}</strong>
        <span class="muted">{children}</span>
      </span>
    </label>
  );
}

function Options() {
  const state = useAppState();
  if (!state) return null;
  const nav = [
    ['sessions', 'Sessions', state.sessions.length],
    ['rules', 'Auto-session rules', state.rules.length],
    ...(isFirefox ? [] : [['prefs', 'Preferences']]),
    ['backup', 'Export / import'],
    ['limits', 'Known limitations'],
  ] as [string, string, number?][];

  return (
    <div class="layout">
      <header class="masthead sky">
        <span class="cog spin" aria-hidden="true" />
        <div>
          <h1 class="title">SessionStack</h1>
          <p class="muted">Each session has its own cookies and site storage. Open a tab in a session and sign in. Other tabs stay signed in as someone else.</p>
        </div>
      </header>

      <nav class="plate" aria-label="Sections">
        {nav.map(([id, label, count]) => (
          <a key={id} href={`#${id}`}>
            <span class="grow">{label}</span>
            {count !== undefined && <span class="count">{count}</span>}
          </a>
        ))}
      </nav>

      <main>
        <section id="sessions">
          <h2>Sessions</h2>
          <p class="muted">The badge shows on the toolbar. The first four sessions have hotkeys.</p>
          <div class="sessions">
            {state.sessions.map((s, i) => (
              <SessionCard key={s.id} session={s} index={i} />
            ))}
            <button class="add-card" onClick={() => void call('saveSession', { session: draftSession(state.sessions) })}>
              <span class="cog" aria-hidden="true" />
              New session
            </button>
          </div>
        </section>

        <section id="rules">
          <h2>Auto-session rules</h2>
          <p class="muted">Navigating to a matching URL moves the tab into that session. A bare host glob matches any scheme and path. The highest priority wins.</p>
          <Rules state={state} />
        </section>

        {!isFirefox && (
          <section id="prefs">
            <h2>Preferences</h2>
            <div class="card plate">
              <Toggle title="Inherit session" checked={state.prefs.inheritOpener} onChange={(v) => void call('setPrefs', { prefs: { inheritOpener: v } })}>
                Links and pop-ups opened from a session tab stay in that session.
              </Toggle>
              <Toggle title="Badge tab icons" checked={state.prefs.faviconBadge} onChange={(v) => void call('setPrefs', { prefs: { faviconBadge: v } })}>
                Put the session's lamp on each tab's site icon, so sessions are easy to tell apart in the tab strip.
              </Toggle>
              <Toggle title="Tag tab titles" checked={state.prefs.titlePrefix} onChange={(v) => void call('setPrefs', { prefs: { titlePrefix: v } })}>
                Prefix tab titles with the session tag, e.g. <code>[DEV] Dashboard</code>.
              </Toggle>
            </div>
          </section>
        )}

        <section id="backup">
          <h2>Export / import</h2>
          <p class="muted">Sessions, rules and cookies, encrypted with your passphrase (AES-GCM-256). Site storage is not included.</p>
          <Backup />
        </section>

        <section id="limits">
          <h2>Known limitations</h2>
          <div class="card plate">
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
          </div>
        </section>
      </main>
    </div>
  );
}

render(<Options />, document.getElementById('app')!);
mountGlassScroll();
