// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { CookieView } from '../../src/page/cookies';
import { eventKey, namespacedStorage } from '../../src/page/storage';

describe('namespacedStorage', () => {
  it('isolates sessions and hides SessionStack keys from the default view', () => {
    localStorage.clear();
    localStorage.setItem('plain', 'default');
    const a = namespacedStorage(localStorage, '__ssx:a.0:');
    const b = namespacedStorage(localStorage, '__ssx:b.0:');
    const def = namespacedStorage(localStorage, null);

    a.setItem('token', 'alice');
    (b as unknown as Record<string, string>).token = 'bob';
    expect(a.getItem('token')).toBe('alice');
    expect((b as unknown as Record<string, string>).token).toBe('bob');
    expect(a.getItem('plain')).toBeNull();
    expect(def.getItem('plain')).toBe('default');
    expect(Object.keys(def)).toEqual(['plain']);
    expect(def.length).toBe(1);
    expect(Object.keys(a)).toEqual(['token']);
    expect(a.key(0)).toBe('token');
    expect('token' in a).toBe(true);
    expect(a instanceof Storage).toBe(true);

    a.clear();
    expect(a.length).toBe(0);
    expect(b.getItem('token')).toBe('bob');
    delete (b as unknown as Record<string, string>).token;
    expect(b.length).toBe(0);
    expect(localStorage.getItem('plain')).toBe('default');
  });

  it('maps storage event keys into the namespace', () => {
    expect(eventKey('__ssx:a.0:k', '__ssx:a.0:')).toBe('k');
    expect(eventKey('__ssx:b.0:k', '__ssx:a.0:')).toBeUndefined();
    expect(eventKey('k', null)).toBe('k');
    expect(eventKey('__ssx:a.0:k', null)).toBeUndefined();
  });
});

describe('CookieView', () => {
  it('applies writes and deletions', () => {
    const v = new CookieView('a=1; b=2');
    v.apply('c=3; Path=/');
    v.apply('a=; Max-Age=0');
    v.apply('b=9; Expires=Thu, 01 Jan 2099 00:00:00 GMT');
    v.apply('h=1; HttpOnly');
    expect(v.toString()).toBe('c=3; b=9');
    expect(v.get('c')).toBe('3');
  });
});
