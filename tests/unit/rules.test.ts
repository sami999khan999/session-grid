import { describe, expect, it } from 'vitest';
import { compilePattern, isValidPattern, resolveSession } from '../../src/core/rules';
import type { Rule } from '../../src/core/types';

const rule = (pattern: string, sessionId: string, priority = 0, enabled = true): Rule => ({ id: pattern, pattern, sessionId, priority, enabled });

describe('compilePattern', () => {
  it('matches host globs on any scheme, port and path', () => {
    const re = compilePattern('*.dev.example.com')!;
    expect(re.test('https://api.dev.example.com/x?y')).toBe(true);
    expect(re.test('http://a.b.dev.example.com:8080/')).toBe(true);
    expect(re.test('https://dev.example.com/')).toBe(false);
    expect(re.test('https://evil.com/?q=.dev.example.com')).toBe(false);
    expect(re.test('https://dev.example.com.evil.com/')).toBe(false);
  });

  it('matches exact hosts', () => {
    const re = compilePattern('example.com')!;
    expect(re.test('https://example.com')).toBe(true);
    expect(re.test('https://www.example.com/')).toBe(false);
  });

  it('treats patterns with a scheme as whole-URL globs', () => {
    const re = compilePattern('https://example.com/admin/*')!;
    expect(re.test('https://example.com/admin/users')).toBe(true);
    expect(re.test('https://example.com/public')).toBe(false);
  });

  it('rejects empty and path-only host patterns', () => {
    expect(isValidPattern('')).toBe(false);
    expect(isValidPattern('example.com/admin')).toBe(false);
  });
});

describe('resolveSession', () => {
  it('picks the highest priority, earlier rule on ties, skipping disabled', () => {
    const rules = [rule('*.example.com', 'a'), rule('api.example.com', 'b', 5), rule('api.example.com', 'c', 9, false), rule('*.example.com', 'd')];
    expect(resolveSession(rules, 'https://api.example.com/')).toBe('b');
    expect(resolveSession(rules, 'https://www.example.com/')).toBe('a');
    expect(resolveSession(rules, 'https://other.org/')).toBeNull();
    expect(resolveSession(rules, 'chrome://newtab/')).toBeNull();
  });
});
