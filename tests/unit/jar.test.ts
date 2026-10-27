import { describe, expect, it } from 'vitest';
import { SessionJar } from '../../src/engines/chromium/jar';

describe('SessionJar', () => {
  it('applies domain, path and secure scoping', () => {
    const jar = new SessionJar();
    jar.set('a=1; Path=/', 'https://example.com/');
    jar.set('b=2; Domain=example.com; Path=/', 'https://example.com/');
    jar.set('c=3; Path=/admin', 'https://example.com/admin');
    jar.set('s=4; Secure', 'https://example.com/');
    expect(jar.header('https://example.com/', 'strict')).toBe('a=1; b=2; s=4');
    expect(jar.header('https://example.com/admin/x', 'strict')).toBe('c=3; a=1; b=2; s=4');
    expect(jar.header('http://example.com/', 'strict')).toBe('a=1; b=2');
    expect(jar.header('https://sub.example.com/', 'strict')).toBe('b=2');
  });

  it('applies SameSite by context with Lax as the default', () => {
    const jar = new SessionJar();
    jar.set('def=1', 'https://example.com/');
    jar.set('lax=1; SameSite=Lax', 'https://example.com/');
    jar.set('strict=1; SameSite=Strict', 'https://example.com/');
    jar.set('none=1; SameSite=None; Secure', 'https://example.com/');
    const names = (ctx: 'strict' | 'lax' | 'none') => jar.match('https://example.com/', ctx).map((c) => c.key).sort();
    expect(names('strict')).toEqual(['def', 'lax', 'none', 'strict']);
    expect(names('lax')).toEqual(['def', 'lax', 'none']);
    expect(names('none')).toEqual(['none']);
  });

  it('keeps HttpOnly cookies away from script access', () => {
    const jar = new SessionJar();
    jar.set('sid=x; HttpOnly', 'https://example.com/');
    jar.set('csrf=y', 'https://example.com/');
    expect(jar.header('https://example.com/', 'strict', false)).toBe('csrf=y');
    expect(jar.set('sid=evil', 'https://example.com/', false)).toBe(false);
    expect(jar.header('https://example.com/', 'strict')).toBe('sid=x; csrf=y');
  });

  it('accepts localhost and rejects public-suffix domains', () => {
    const jar = new SessionJar();
    expect(jar.set('a=1', 'http://localhost:3000/')).toBe(true);
    expect(jar.set('b=1; Domain=co.uk', 'https://example.co.uk/')).toBe(false);
  });

  it('round-trips through serialization and portable export', () => {
    const jar = new SessionJar();
    jar.set('a=1; Domain=example.com; Secure; HttpOnly; SameSite=Strict; Max-Age=3600', 'https://www.example.com/');
    jar.set('b=2; Path=/p', 'https://example.com/p');
    const revived = new SessionJar(jar.serialize());
    expect(revived.header('https://www.example.com/', 'strict')).toBe('a=1');
    const copy = new SessionJar();
    copy.importPortable(jar.exportPortable());
    expect(copy.header('https://x.example.com/', 'strict')).toBe('a=1');
    expect(copy.header('https://example.com/p', 'strict')).toBe('b=2; a=1');
    expect(copy.exportPortable().find((c) => c.name === 'a')).toMatchObject({ hostOnly: false, httpOnly: true, sameSite: 'strict', secure: true });
  });
});
