import { render, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { call } from '../../src/core/messages';
import { isValidPattern } from '../../src/core/rules';
import { SESSION_COLORS, newId, type AppState, type Rule, type Session, type SessionColor } from '../../src/core/types';
import { mountGlassScroll } from '../../src/ui/scroll';
import { draftSession } from '../../src/ui/sessions';
import { isFirefox, useAppState } from '../../src/ui/useAppState';
import '../../src/ui/theme.css';
import './style.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type View = 'sessions' | 'rules' | 'prefs' | 'backup' | 'about';
const VIEWS: View[] = ['sessions', 'rules', ...(isFirefox ? [] : (['prefs'] as View[])), 'backup', 'about'];

/** The current view, kept in the URL hash so reloads and links land on the same tab. */
function useView(): View {
  const read = () => {
    const v = location.hash.slice(1) as View;
    return VIEWS.includes(v) ? v : 'sessions';
  };
  const [view, setView] = useState(read);
  useEffect(() => {
    const on = () => {
      setView(read());
      window.scrollTo({ top: 0 });
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return view;
}

function ViewHead({ title, children, actions }: { title: string; children?: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <div class="view-head">
      <div class="grow">
        <h2>{title}</h2>
        {children && <p class="muted">{children}</p>}
      </div>
      {actions && <div class="row actions">{actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ sessions

function SessionEditor({ session, onDone }: { session: Session; onDone: () => void }) {
  const [draft, setDraft] = useState(session);
  const dirty = JSON.stringify(draft) !== JSON.stringify(session);
  const save = async () => {
    if (dirty) await call('saveSession', { session: { ...draft, name: draft.name.trim() || session.name } });
    onDone();
  };

  return (
    <form
      class="editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label class="field">
        <span>Name</span>
        <input value={draft.name} autoFocus onInput={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
      </label>
      <label class="field">
        <span>Badge</span>
        <input class="tag" maxLength={12} value={draft.tag} onInput={(e) => setDraft({ ...draft, tag: e.currentTarget.value })} />
      </label>
      <div class="field">
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
      <div class="row foot">
        <span class="grow" />
        <button type="button" class="ghost" onClick={onDone}>Cancel</button>
        <button type="submit" class="primary small">Save</button>
      </div>
    </form>
  );
}

function SessionCard({ session, index, editing, setEditing }: { session: Session; index: number; editing: boolean; setEditing: (on: boolean) => void }) {
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState<'clear' | 'delete' | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => ref.current?.querySelector('.menu')?.contains(e.target as Node) || setMenu(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);

  return (
    <article ref={ref} class={`session plate ${editing ? 'editing' : ''}`} style={{ '--lamp': SESSION_COLORS[session.color] } as Record<string, string>}>
      <header class="row">
        <span class="dot lg" style={{ background: SESSION_COLORS[session.color] }} />
        <div class="grow">
          <h3 class="truncate">{session.name}</h3>
          <div class="meta row">
            <span class="chip">{session.tag}</span>
            {index < 4 && <kbd title="Opens a new tab in this session">Alt+Shift+{index + 1}</kbd>}
          </div>
        </div>
        {!editing && (
          <div class="menu">
            <button class="ghost icon" aria-label="More actions" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>
            {menu && (
              <div class="popover plate" role="menu">
                <button role="menuitem" class="ghost" onClick={() => (setMenu(false), setConfirm('clear'))}>Clear cookies &amp; data</button>
                <button role="menuitem" class="ghost danger" onClick={() => (setMenu(false), setConfirm('delete'))}>Delete session</button>
              </div>
            )}
          </div>
        )}
      </header>

      {editing ? (
        <SessionEditor session={session} onDone={() => setEditing(false)} />
      ) : confirm ? (
        <div class="row foot confirm">
          <span class="grow error">{confirm === 'clear' ? 'Sign out everywhere in this session?' : 'Delete this session?'}</span>
          <button class="ghost" onClick={() => setConfirm(null)}>Cancel</button>
          <button
            class="danger small"
            onClick={() => {
              setConfirm(null);
              void (confirm === 'clear' ? call('clearSession', { id: session.id }) : call('deleteSession', { id: session.id }));
            }}
          >
            {confirm === 'clear' ? 'Clear' : 'Delete'}
          </button>
        </div>
      ) : (
        <div class="row foot">
          <button class="primary small" onClick={() => void call('openInSession', { sessionId: session.id })}>Open tab</button>
          <span class="grow" />
          <button class="ghost" onClick={() => setEditing(true)}>Edit</button>
        </div>
      )}
    </article>
  );
}

function Sessions({ state }: { state: AppState }) {
  const [editing, setEditing] = useState<string | null>(null);
  const create = async () => {
    const session = draftSession(state.sessions);
    await call('saveSession', { session });
    setEditing(session.id);
  };

  return (
    <>
      <ViewHead title="Sessions" actions={<button class="primary" onClick={() => void create()}>＋ New session</button>}>
        Each session has its own cookies and site storage. Open a tab in a session and sign in; other tabs stay signed in as someone else.
      </ViewHead>
      {state.sessions.length === 0 ? (
        <div class="empty-state plate">
          <span class="island bob" aria-hidden="true" />
          <h3>No sessions yet</h3>
          <p class="muted">Create one, open a tab in it and sign in.</p>
          <button class="primary" onClick={() => void create()}>Create your first session</button>
        </div>
      ) : (
        <div class="sessions">
          {state.sessions.map((s, i) => (
            <SessionCard key={s.id} session={s} index={i} editing={editing === s.id} setEditing={(on) => setEditing(on ? s.id : null)} />
          ))}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ rules

function Rules({ state }: { state: AppState }) {
  const [rules, setRules] = useState<Rule[]>(state.rules);
  const [saved, setSaved] = useState('');
  useEffect(() => setRules(state.rules), [state.rules]);
  const dirty = JSON.stringify(rules) !== JSON.stringify(state.rules);
  const invalid = rules.some((r) => !isValidPattern(r.pattern));
  const patch = (id: string, p: Partial<Rule>) => setRules(rules.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const add = () => setRules([...rules, { id: newId(), pattern: '', sessionId: state.sessions[0]!.id, priority: 0, enabled: true }]);

  const head = (
    <ViewHead
      title="Auto-session rules"
      actions={
        state.sessions.length > 0 && (
          <>
            <button onClick={add}>＋ Add rule</button>
            <button
              class="primary"
              disabled={!dirty || invalid}
              onClick={() => void call('saveRules', { rules }).then(() => setSaved('Rules saved.'), (e) => setSaved(errorText(e)))}
            >
              Save rules
            </button>
          </>
        )
      }
    >
      Navigating to a matching URL moves the tab into that session. A bare host glob matches any scheme and path; the highest priority wins.
    </ViewHead>
  );

  if (!state.sessions.length) {
    return (
      <>
        {head}
        <div class="empty-state plate">
          <h3>Create a session first</h3>
          <p class="muted">Rules send matching pages into one of your sessions.</p>
          <a class="button-link" href="#sessions">Go to sessions</a>
        </div>
      </>
    );
  }

  return (
    <>
      {head}
      <div class="status-line">
        {invalid && <span class="error">Fix the highlighted patterns.</span>}
        {!invalid && dirty && <span class="muted">Unsaved changes</span>}
        {!invalid && !dirty && saved && <span class="muted">{saved}</span>}
      </div>
      {rules.length === 0 ? (
        <div class="empty-state plate">
          <h3>No rules yet</h3>
          <p class="muted">Example: <code>*.staging.example.com</code> → Staging.</p>
          <button onClick={add}>＋ Add rule</button>
        </div>
      ) : (
        <div class="rules plate">
          <div class="rule head" aria-hidden="true">
            <span>On</span>
            <span>URL pattern</span>
            <span>Session</span>
            <span>Priority</span>
            <span />
          </div>
          {rules.map((r) => (
            <div class="rule" key={r.id}>
              <label class="cell on">
                <input type="checkbox" checked={r.enabled} onChange={(e) => patch(r.id, { enabled: e.currentTarget.checked })} />
                <span class="cell-label">Enabled</span>
              </label>
              <label class="cell pattern">
                <span class="cell-label">URL pattern</span>
                <input
                  placeholder="*.dev.example.com or https://example.com/admin/*"
                  aria-invalid={!isValidPattern(r.pattern)}
                  value={r.pattern}
                  onInput={(e) => patch(r.id, { pattern: e.currentTarget.value })}
                />
              </label>
              <label class="cell">
                <span class="cell-label">Session</span>
                <select value={r.sessionId} onChange={(e) => patch(r.id, { sessionId: e.currentTarget.value })}>
                  {state.sessions.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <label class="cell prio">
                <span class="cell-label">Priority</span>
                <input type="number" title="Higher wins" value={r.priority} onInput={(e) => patch(r.id, { priority: Number(e.currentTarget.value) || 0 })} />
              </label>
              <button class="ghost danger remove" aria-label="Remove rule" title="Remove rule" onClick={() => setRules(rules.filter((x) => x.id !== r.id))}>✕</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ preferences

function Toggle({ checked, onChange, title, children }: { checked: boolean; onChange: (v: boolean) => void; title: string; children: ComponentChildren }) {
  return (
    <label class="toggle">
      <span class="grow">
        <strong>{title}</strong>
        <span class="muted">{children}</span>
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span class="lever" aria-hidden="true" />
    </label>
  );
}

function Prefs({ state }: { state: AppState }) {
  const set = (prefs: Partial<AppState['prefs']>) => void call('setPrefs', { prefs });
  return (
    <>
      <ViewHead title="Preferences">How session tabs behave and how they're marked in the tab strip.</ViewHead>
      <div class="prefs">
        <section class="plate">
          <h3>Behaviour</h3>
          <Toggle title="Inherit session" checked={state.prefs.inheritOpener} onChange={(v) => set({ inheritOpener: v })}>
            Links and pop-ups opened from a session tab stay in that session.
          </Toggle>
        </section>
        <section class="plate">
          <h3>Tab marking</h3>
          <Toggle title="Group tabs by session" checked={state.prefs.tabGroups} onChange={(v) => set({ tabGroups: v })}>
            Keep each session's tabs in a tab group showing the session's full name and colour. Dragging a tab into a group moves it into that session.
          </Toggle>
          <Toggle title="Badge tab icons" checked={state.prefs.faviconBadge} onChange={(v) => set({ faviconBadge: v })}>
            Put the session's lamp on each tab's site icon.
          </Toggle>
          <Toggle title="Tag tab titles" checked={state.prefs.titlePrefix} onChange={(v) => set({ titlePrefix: v })}>
            Prefix tab titles with the session tag, e.g. <code>[DEV] Dashboard</code>.
          </Toggle>
        </section>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ backup

type Status = { text: string; error?: boolean } | null;

function useAction() {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<string>) => async () => {
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
  return { status, busy, run };
}

function StatusText({ status }: { status: Status }) {
  return status ? <p class={`status ${status.error ? 'error' : 'muted'}`}>{status.text}</p> : null;
}

function Export() {
  const [passphrase, setPassphrase] = useState('');
  const { status, busy, run } = useAction();
  const doExport = run(async () => {
    const text = await call('exportData', { passphrase });
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `sessionstack-${new Date().toISOString().slice(0, 10)}.sessionstack.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return 'Export downloaded. Keep it private: it contains live sign-in cookies.';
  });

  return (
    <section class="plate backup-card">
      <h3>Export</h3>
      <p class="muted">Download an encrypted file with every session, rule and cookie.</p>
      <label class="field">
        <span>Passphrase</span>
        <input type="password" placeholder="At least 8 characters" autocomplete="new-password" value={passphrase} onInput={(e) => setPassphrase(e.currentTarget.value)} />
      </label>
      <button class="primary" disabled={busy || passphrase.length < 8} onClick={doExport}>Download export</button>
      <StatusText status={status} />
    </section>
  );
}

function Import() {
  const [passphrase, setPassphrase] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [file, setFile] = useState<File | null>(null);
  const { status, busy, run } = useAction();
  const doImport = run(async () => {
    const r = await call('importData', { text: await file!.text(), passphrase, mode });
    return `Imported ${r.sessions} session(s) and ${r.rules} rule(s).`;
  });

  return (
    <section class="plate backup-card">
      <h3>Import</h3>
      <p class="muted">Restore an export file, merged into your setup or replacing it.</p>
      <label class="field">
        <span>Export file</span>
        <input type="file" accept=".json,application/json" onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
      </label>
      <label class="field">
        <span>Passphrase</span>
        <input type="password" autocomplete="off" value={passphrase} onInput={(e) => setPassphrase(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span>Mode</span>
        <select value={mode} onChange={(e) => setMode(e.currentTarget.value as 'merge' | 'replace')}>
          <option value="merge">Merge with current sessions</option>
          <option value="replace">Replace everything</option>
        </select>
      </label>
      <button disabled={busy || !file || !passphrase} onClick={doImport}>Import</button>
      <StatusText status={status} />
    </section>
  );
}

function Backup() {
  return (
    <>
      <ViewHead title="Export / import">Sessions, rules and cookies, encrypted with your passphrase (AES-GCM-256). Site storage is not included.</ViewHead>
      <div class="backup">
        <Export />
        <Import />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ about

function About() {
  return (
    <>
      <ViewHead title="About">Several logins to the same site, side by side in one window.</ViewHead>
      <div class="about">
        <section class="plate">
          <h3>How to use it</h3>
          <ol class="steps">
            <li>Create a session, e.g. <em>Attorney</em>.</li>
            <li>Open a tab in it from the toolbar popup and sign in.</li>
            <li>Create another session and sign in as someone else. Both stay signed in.</li>
            <li>The first four sessions open with <kbd>Alt+Shift+1</kbd> … <kbd>Alt+Shift+4</kbd>.</li>
          </ol>
        </section>
        <section class="plate">
          <h3>Known limitations</h3>
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
      </div>
    </>
  );
}

// ------------------------------------------------------------------ page

function Options() {
  const state = useAppState();
  const view = useView();
  // On narrow screens the tab strip scrolls; keep the current tab in sight.
  useEffect(() => document.querySelector('.tabs [aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }), [view, !!state]);
  if (!state) return null;
  const tabs: [View, string, number?][] = [
    ['sessions', 'Sessions', state.sessions.length],
    ['rules', 'Rules', state.rules.length],
    ...(isFirefox ? [] : [['prefs', 'Preferences'] as [View, string]]),
    ['backup', 'Backup'],
    ['about', 'About'],
  ];

  return (
    <>
      <header class="topbar sky">
        <div class="bar">
          <a class="brand row" href="#sessions">
            <span class="cube bob" aria-hidden="true" />
            <span class="title">SessionStack</span>
          </a>
          <nav class="tabs" aria-label="Sections">
            {tabs.map(([id, label, count]) => (
              <a key={id} href={`#${id}`} aria-current={view === id ? 'page' : undefined}>
                {label}
                {count !== undefined && <span class="count">{count}</span>}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main class="page">
        {view === 'sessions' && <Sessions state={state} />}
        {view === 'rules' && <Rules state={state} />}
        {view === 'prefs' && <Prefs state={state} />}
        {view === 'backup' && <Backup />}
        {view === 'about' && <About />}
      </main>
    </>
  );
}

render(<Options />, document.getElementById('app')!);
mountGlassScroll();
