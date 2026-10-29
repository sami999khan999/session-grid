import type { AppState, PortableCookie } from '../core/types';

export interface IsolationEngine {
  /** Register browser event listeners. Must run synchronously at service-worker startup. */
  attach(): void;
  /** Bring engine-side resources (containers, rules) in line with the saved sessions. */
  sync(state: AppState): Promise<void>;
  getTabSession(tabId: number): Promise<string | null>;
  openInSession(sessionId: string, url?: string, active?: boolean): Promise<void>;
  /** Move a tab into a session (`null` = the browser's default session). */
  assignTab(tabId: number, sessionId: string | null): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
  exportCookies(sessionId: string): Promise<PortableCookie[]>;
  importCookies(sessionId: string, cookies: PortableCookie[]): Promise<void>;
}

/** Background-owned view of the current state, shared with the engine. */
export interface StateSource {
  get(): Promise<AppState>;
}

export function isWebUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}
