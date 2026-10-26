import type { SameSiteContext, SessionJar } from './jar';

type ResourceType = Browser.declarativeNetRequest.ResourceType;
type HeaderInfo = Browser.declarativeNetRequest.ModifyHeaderInfo;

/** Rule shape without an id; ids are assigned when the rules are installed. */
export interface DraftRule {
  priority: number;
  condition: {
    tabIds: number[];
    resourceTypes: ResourceType[];
    regexFilter?: string;
    domainType?: 'firstParty' | 'thirdParty';
  };
  action: { type: 'modifyHeaders'; requestHeaders: HeaderInfo[]; responseHeaders: HeaderInfo[] };
}

// A rule without resourceTypes skips main_frame, so every rule lists them explicitly.
export const ALL_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
  'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other',
] as ResourceType[];
const NON_NAV_TYPES = ALL_TYPES.filter((t) => t !== 'main_frame');

/** Server-Timing metric that carries the session id and JS-visible cookies to the page shim. */
export const TIMING_NAME = 'ssx';

export function timingHeader(sessionKey: string, jsCookies: string): string {
  return `${TIMING_NAME};desc="${sessionKey}|${encodeURIComponent(jsCookies)}"`;
}

export function parseTiming(desc: string): { sessionKey: string; cookies: string } | null {
  const i = desc.indexOf('|');
  if (i <= 0) return null;
  try {
    return { sessionKey: desc.slice(0, i), cookies: decodeURIComponent(desc.slice(i + 1)) };
  } catch {
    return null;
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Target {
  host: string;
  /** Matches strict subdomains of `host` instead of `host` itself. */
  wildcard: boolean;
  recency: number;
}

interface Values {
  strict: string;
  lax: string;
  none: string;
  js: string;
}

export interface CompileResult {
  rules: DraftRule[];
  /** Hosts left out because the regex rule budget ran out. */
  dropped: string[];
}

/**
 * Compile one session's jar into DNR session rules for the given tabs.
 *
 * A priority-1 base rule strips the real browser cookies (fail-closed) and stamps the session
 * key. Higher-priority rules per (host, path, scheme, SameSite context) set the jar's Cookie
 * header. More specific host/path rules win because DNR applies a header's highest-priority
 * operation only.
 */
export function compileSessionRules(
  sessionKey: string,
  tabIds: number[],
  jar: SessionJar,
  regexBudget: number,
): CompileResult {
  const rules: DraftRule[] = [
    {
      priority: 1,
      condition: { tabIds, resourceTypes: ALL_TYPES },
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'cookie', operation: 'remove' as HeaderInfo['operation'] }],
        responseHeaders: [
          { header: 'set-cookie', operation: 'remove' as HeaderInfo['operation'] },
          { header: 'server-timing', operation: 'set' as HeaderInfo['operation'], value: timingHeader(sessionKey, '') },
        ],
      },
    },
  ];

  const cookies = jar.all();
  const targets = new Map<string, Target>();
  const paths = new Set<string>(['/']);
  for (const c of cookies) {
    if (!c.domain) continue;
    // Not lastAccessed: compiling probes every cookie, which would touch them all equally.
    const recency = c.creation instanceof Date ? c.creation.getTime() : 0;
    for (const wildcard of c.hostOnly ? [false] : [false, true]) {
      const key = `${wildcard ? '*.' : ''}${c.domain}`;
      const prev = targets.get(key);
      targets.set(key, { host: c.domain, wildcard, recency: Math.max(prev?.recency ?? 0, recency) });
    }
    if (c.path) paths.add(c.path);
  }

  const sortedPaths = [...paths].sort((a, b) => a.length - b.length);
  const dropped: string[] = [];
  let used = 0;

  for (const target of [...targets.values()].sort((a, b) => b.recency - a.recency)) {
    const targetRules = compileTarget(sessionKey, tabIds, jar, target, sortedPaths);
    if (used + targetRules.length > regexBudget) {
      dropped.push((target.wildcard ? '*.' : '') + target.host);
      continue;
    }
    used += targetRules.length;
    rules.push(...targetRules);
  }
  return { rules, dropped };
}

function compileTarget(sessionKey: string, tabIds: number[], jar: SessionJar, target: Target, paths: string[]): DraftRule[] {
  const probeHost = target.wildcard ? `ssx-probe.${target.host}` : target.host;
  const hostRe = target.wildcard ? `(?:[^/?#.:]+\\.)+${escapeRe(target.host)}` : escapeRe(target.host);
  const labels = target.host.split('.').length;
  const out: DraftRule[] = [];
  const emitted: { path: string; https: Values; http: Values }[] = [];

  for (const path of paths) {
    const https = values(jar, `https://${probeHost}${path}`);
    const http = values(jar, `http://${probeHost}${path}`);
    // The closest shorter path already emitted (or nothing, i.e. the base rule) covers this URL
    // space; skip if this path would send the same headers.
    const parent = [...emitted].reverse().find((e) => pathMatches(path, e.path));
    const same = parent ? sameValues(parent.https, https) && sameValues(parent.http, http) : isEmpty(https) && isEmpty(http);
    if (same) continue;
    emitted.push({ path, https, http });

    const pathRe = path === '/' ? '/' : escapeRe(path) + (path.endsWith('/') ? '' : '(?:[/?#]|$)');
    const priority = (target.wildcard ? 2 : 3) * 100_000 + labels * 1_000 + Math.min(path.length, 999);
    const schemes: [string, Values][] = sameValues(https, http)
      ? [['(?:https?|wss?)', https]]
      : [['(?:https|wss)', https], ['(?:http|ws)', http]];
    for (const [schemeRe, v] of schemes) {
      const regexFilter = `^${schemeRe}://${hostRe}(?::\\d+)?${pathRe}`;
      out.push(...contextRules(sessionKey, tabIds, regexFilter, priority, v));
    }
  }
  return out;
}

function contextRules(sessionKey: string, tabIds: number[], regexFilter: string, priority: number, v: Values): DraftRule[] {
  const rule = (value: string, resourceTypes: ResourceType[], domainType?: 'firstParty' | 'thirdParty'): DraftRule => ({
    priority,
    condition: { tabIds, resourceTypes, regexFilter, ...(domainType ? { domainType } : {}) },
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        value
          ? { header: 'cookie', operation: 'set' as HeaderInfo['operation'], value }
          : { header: 'cookie', operation: 'remove' as HeaderInfo['operation'] },
      ],
      responseHeaders: [
        { header: 'server-timing', operation: 'set' as HeaderInfo['operation'], value: timingHeader(sessionKey, v.js) },
      ],
    },
  });

  if (v.strict === v.lax && v.lax === v.none) return [rule(v.strict, ALL_TYPES)];
  const out = [rule(v.strict, ALL_TYPES, 'firstParty')];
  if (v.lax === v.none) out.push(rule(v.none, ALL_TYPES, 'thirdParty'));
  else out.push(rule(v.lax, ['main_frame' as ResourceType], 'thirdParty'), rule(v.none, NON_NAV_TYPES, 'thirdParty'));
  return out;
}

function values(jar: SessionJar, url: string): Values {
  const ctx = (c: SameSiteContext) => jar.header(url, c);
  return { strict: ctx('strict'), lax: ctx('lax'), none: ctx('none'), js: jar.header(url, 'strict', false) };
}

const sameValues = (a: Values, b: Values) => a.strict === b.strict && a.lax === b.lax && a.none === b.none && a.js === b.js;
const isEmpty = (v: Values) => !v.strict && !v.lax && !v.none && !v.js;

/** RFC 6265 path-match: does request path `path` fall under cookie path `prefix`? */
export function pathMatches(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  if (!path.startsWith(prefix)) return false;
  return prefix.endsWith('/') || path[prefix.length] === '/';
}

export interface MappingRule {
  priority: number;
  condition: { regexFilter: string; resourceTypes: ResourceType[]; isUrlFilterCaseSensitive: false; excludedTabIds?: number[] };
  action: { type: 'redirect'; redirect: { regexSubstitution: string } };
}

/** Extension page that joins a session and then continues to the original URL. */
export const SWITCH_PAGE = 'switch.html';

/**
 * Auto-mapping rules as DNR redirects. A top-level navigation to a mapped URL from a tab outside
 * the target session goes to the switch page before any request leaves, so no cookies from
 * the wrong session reach the site and no response cookies land in the wrong jar.
 */
export function compileMappingRules(
  rules: { pattern: RegExp; sessionId: string; priority: number }[],
  tabsBySession: Map<string, number[]>,
  extensionOrigin: string,
): MappingRule[] {
  return rules.map((r, i) => {
    const excluded = tabsBySession.get(r.sessionId) ?? [];
    return {
      // Higher user priority first; earlier rules win ties, as in resolveSession.
      priority: 1_000 + Math.max(-900, Math.min(r.priority, 100_000)) * 1_000 + (rules.length - i),
      condition: {
        regexFilter: r.pattern.source,
        resourceTypes: ['main_frame' as ResourceType],
        isUrlFilterCaseSensitive: false,
        ...(excluded.length ? { excludedTabIds: excluded } : {}),
      },
      // \0 is the matched prefix; DNR appends the unmatched rest of the URL after it.
      action: { type: 'redirect', redirect: { regexSubstitution: `${extensionOrigin}/${SWITCH_PAGE}#${r.sessionId}|\\0` } },
    };
  });
}
