import { describe, expect, it } from 'vitest';
import { compileSessionRules, parseTiming, pathMatches, timingHeader } from '../../src/engines/chromium/dnr';
import { SessionJar } from '../../src/engines/chromium/jar';

type Rule = ReturnType<typeof compileSessionRules>['rules'][number];

/** Emulate DNR header resolution: highest-priority matching rule decides each header. */
function resolve(rules: Rule[], url: string, type = 'main_frame', party: 'firstParty' | 'thirdParty' = 'firstParty') {
  const matching = rules
    .filter((r) => r.condition.resourceTypes.includes(type as never))
    .filter((r) => !r.condition.domainType || r.condition.domainType === party)
    .filter((r) => !r.condition.regexFilter || new RegExp(r.condition.regexFilter).test(url))
    .sort((a, b) => b.priority - a.priority);
  const header = (list: 'requestHeaders' | 'responseHeaders', name: string) => {
    const op = matching.flatMap((r) => r.action[list]).find((h) => h.header === name);
    return op?.operation === 'set' ? op.value : op?.operation === 'remove' ? null : undefined;
  };
  return { cookie: header('requestHeaders', 'cookie'), setCookie: header('responseHeaders', 'set-cookie'), timing: header('responseHeaders', 'server-timing') };
}

describe('compileSessionRules', () => {
  const jar = new SessionJar();
  jar.set('host=1', 'https://app.example.com/');
  jar.set('dom=2; Domain=example.com', 'https://app.example.com/');
  jar.set('adm=3; Path=/admin', 'https://app.example.com/admin');
  jar.set('sec=4; Secure; HttpOnly', 'https://app.example.com/');
  jar.set('xs=5; SameSite=None; Secure', 'https://app.example.com/');
  const { rules } = compileSessionRules('abc.0', [7], jar, 1000);

  it('always installs a fail-closed base rule for the tabs', () => {
    const base = rules.find((r) => r.priority === 1)!;
    expect(base.condition).toMatchObject({ tabIds: [7] });
    expect(base.condition.resourceTypes).toContain('main_frame');
    expect(resolve(rules, 'https://unrelated.org/')).toMatchObject({ cookie: null, setCookie: null });
  });

  it('sends host, domain, path and secure cookies to the right URLs', () => {
    expect(resolve(rules, 'https://app.example.com/').cookie).toBe('host=1; dom=2; sec=4; xs=5');
    expect(resolve(rules, 'https://app.example.com/admin/users').cookie).toBe('adm=3; host=1; dom=2; sec=4; xs=5');
    expect(resolve(rules, 'https://app.example.com/administrator').cookie).toBe('host=1; dom=2; sec=4; xs=5');
    expect(resolve(rules, 'http://app.example.com/').cookie).toBe('host=1; dom=2');
    expect(resolve(rules, 'https://example.com/').cookie).toBe('dom=2');
    expect(resolve(rules, 'https://new.example.com:8443/').cookie).toBe('dom=2');
    expect(resolve(rules, 'https://evil.com/?https://app.example.com/').cookie).toBeNull();
    expect(resolve(rules, 'https://app.example.com.evil.com/').cookie).toBeNull();
  });

  it('honours SameSite for third-party requests', () => {
    expect(resolve(rules, 'https://app.example.com/', 'xmlhttprequest', 'thirdParty').cookie).toBe('xs=5');
    expect(resolve(rules, 'https://app.example.com/', 'main_frame', 'thirdParty').cookie).toBe('host=1; dom=2; sec=4; xs=5');
  });

  it('stamps the session key and JS-visible cookies into Server-Timing', () => {
    const timing = resolve(rules, 'https://app.example.com/').timing!;
    expect(timing.startsWith('ssx;desc="')).toBe(true);
    expect(parseTiming(timing.slice('ssx;desc="'.length, -1))).toEqual({ sessionKey: 'abc.0', cookies: 'host=1; dom=2; xs=5' });
    expect(resolve(rules, 'https://unrelated.org/').timing).toBe(timingHeader('abc.0', ''));
  });

  it('drops the oldest hosts when over the regex budget', () => {
    const big = new SessionJar();
    for (let i = 0; i < 20; i++) big.set(`c=${i}`, `https://h${i}.test/`);
    // Each default-Lax host needs 3 rules: first-party, third-party navigation, third-party subresource.
    const { rules: limited, dropped } = compileSessionRules('k.0', [1], big, 9);
    expect(limited.length).toBe(1 + 9);
    expect(dropped.length).toBe(17);
  });
});

describe('pathMatches', () => {
  it('follows RFC 6265 path-match', () => {
    expect(pathMatches('/admin', '/admin')).toBe(true);
    expect(pathMatches('/admin/x', '/admin')).toBe(true);
    expect(pathMatches('/administrator', '/admin')).toBe(false);
    expect(pathMatches('/a/b', '/a/')).toBe(true);
  });
});

describe('sameSite', async () => {
  const { sameSite } = await import('../../src/engines/chromium/index');
  it('compares registrable domains and tolerates special-use hosts', () => {
    expect(sameSite('https://a.example.com/', 'https://b.example.com/x')).toBe(true);
    expect(sameSite('https://example.com/', 'https://example.org/')).toBe(false);
    expect(sameSite('http://localhost:1/', 'http://localhost:2/')).toBe(true);
    expect(sameSite('http://app.dev.test/', 'http://api.dev.test/')).toBe(true);
    expect(sameSite('https://a.github.io/', 'https://b.github.io/')).toBe(false);
  });
});
