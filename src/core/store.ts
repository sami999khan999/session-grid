import { browser } from 'wxt/browser';
import { DEFAULT_PREFS, type AppState } from './types';

const STATE_KEY = 'state';

export async function loadState(): Promise<AppState> {
  const { [STATE_KEY]: raw } = await browser.storage.local.get(STATE_KEY);
  const s = (raw ?? {}) as Partial<AppState>;
  return {
    sessions: s.sessions ?? [],
    rules: s.rules ?? [],
    prefs: { ...DEFAULT_PREFS, ...s.prefs },
  };
}

export async function saveState(state: AppState): Promise<void> {
  await browser.storage.local.set({ [STATE_KEY]: state });
}

export function onStateChanged(cb: (state: AppState) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && STATE_KEY in changes) void loadState().then(cb);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/** Typed get/set for a single key in storage.local or storage.session. */
export function kv<T>(area: 'local' | 'session', key: string, fallback: T) {
  const store = () => browser.storage[area];
  return {
    async get(): Promise<T> {
      const { [key]: v } = await store().get(key);
      return (v as T | undefined) ?? fallback;
    },
    set: (value: T) => store().set({ [key]: value }),
    remove: () => store().remove(key),
  };
}
