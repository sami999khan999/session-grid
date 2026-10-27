export const SESSION_COLORS = {
  blue: '#37adff',
  turquoise: '#00c79a',
  green: '#51cd00',
  yellow: '#ffcb00',
  orange: '#ff9f00',
  red: '#ff613d',
  pink: '#ff4bda',
  purple: '#af51f5',
} as const;

export type SessionColor = keyof typeof SESSION_COLORS;

export interface Session {
  id: string;
  name: string;
  /** Short label shown on the toolbar badge (max 4 chars visible). */
  tag: string;
  color: SessionColor;
  createdAt: number;
}

export interface Rule {
  id: string;
  /** Host glob (`*.dev.example.com`) or URL glob (`https://example.com/admin/*`). */
  pattern: string;
  sessionId: string;
  priority: number;
  enabled: boolean;
}

export interface Prefs {
  /** Prefix page titles with `[tag]` in partitioned tabs (Chrome only). */
  titlePrefix: boolean;
  /** Tabs opened from a partitioned tab join the opener's session. */
  inheritOpener: boolean;
  /** Mark the favicon of partitioned tabs with the session's colour (Chrome only). */
  faviconBadge: boolean;
  /** Keep each session's tabs in a tab group named after it (Chrome only). */
  tabGroups: boolean;
}

export interface AppState {
  sessions: Session[];
  rules: Rule[];
  prefs: Prefs;
}

/** Browser-neutral cookie representation used for export/import. */
export interface PortableCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'strict' | 'lax' | 'none' | 'unspecified';
  /** Expiry as epoch seconds; absent for session cookies. */
  expires?: number;
}

export const DEFAULT_PREFS: Prefs = { titlePrefix: true, inheritOpener: true, faviconBadge: true, tabGroups: true };

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
