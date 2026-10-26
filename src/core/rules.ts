import type { Rule } from './types';

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compile a user glob into a RegExp over the full URL.
 * - No scheme: a host glob, matched against the hostname only (`*.example.com`
 *   matches subdomains, not the apex).
 * - With scheme: a whole-URL glob where `*` matches any run of characters.
 */
export function compilePattern(pattern: string): RegExp | null {
  const p = pattern.trim();
  if (!p) return null;
  if (p.includes('://')) {
    return new RegExp('^' + p.split('*').map(escape).join('.*') + '$', 'i');
  }
  if (/[/?#]/.test(p)) return null;
  const host = p.split('*').map(escape).join('[^/?#]*');
  return new RegExp(`^[a-z][a-z0-9+.-]*://(?:[^/?#@]*@)?${host}(?::\\d+)?(?:[/?#]|$)`, 'i');
}

export function isValidPattern(pattern: string): boolean {
  return compilePattern(pattern) !== null;
}

/** The session for the highest-priority enabled rule matching `url`; earlier rules win ties. */
export function resolveSession(rules: Rule[], url: string): string | null {
  if (!/^(https?|wss?):/i.test(url)) return null;
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!rule.enabled || (best && rule.priority <= best.priority)) continue;
    if (compilePattern(rule.pattern)?.test(url)) best = rule;
  }
  return best?.sessionId ?? null;
}
