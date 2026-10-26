import type { Page } from '@playwright/test';
import { expect, test, whoami } from './fixtures';

interface Session {
  id: string;
}

const draft = (name: string) => ({ id: name.toLowerCase(), name, tag: name.slice(0, 3).toUpperCase(), color: 'blue', createdAt: 0 });

async function openSessionTab(api: (t: string, r?: object) => Promise<unknown>, nextTab: (a: () => Promise<unknown>) => Promise<Page>, sessionId: string, url: string) {
  const page = await nextTab(() => api('openInSession', { sessionId }));
  await page.goto(url);
  return page;
}

test('two sessions on the same site stay isolated from each other and from the default jar', async ({ context, api, nextTab, port }) => {
  const base = `http://localhost:${port}`;
  await api<Session>('saveSession', { session: draft('Alice') });
  await api<Session>('saveSession', { session: draft('Bob') });

  const def = await context.newPage();
  await def.goto(`${base}/login?u=default`);

  const a = await openSessionTab(api, nextTab, 'alice', `${base}/login?u=alice`);
  const b = await openSessionTab(api, nextTab, 'bob', `${base}/login?u=bob`);
  await a.goto(base + '/');
  await b.goto(base + '/');

  await expect(a.locator('#server')).toHaveText('sid=alice; ui=alice');
  await expect(b.locator('#server')).toHaveText('sid=bob; ui=bob');
  expect(await whoami(a, base)).toBe('sid=alice; ui=alice');
  expect(await whoami(def, base)).toBe('sid=default; ui=default');

  // The browser's real jar only ever saw the default login.
  expect((await context.cookies()).map((c) => `${c.name}=${c.value}`).sort()).toEqual(['sid=default', 'ui=default']);

  // document.cookie is the session's, without HttpOnly cookies, already for inline head scripts.
  expect(await a.evaluate(() => (window as unknown as { __early: string }).__early)).toBe('ui=alice');
  expect(await b.evaluate(() => document.cookie)).toBe('ui=bob');
  expect(await def.evaluate(() => document.cookie)).toBe('sid=default; ui=default'.replace('sid=default; ', ''));

  await a.reload();
  await expect(a.locator('#server')).toHaveText('sid=alice; ui=alice');
});

test('script-set cookies reach the server and stay in their session', async ({ api, nextTab, port, context }) => {
  const base = `http://localhost:${port}`;
  await api('saveSession', { session: draft('Alice') });
  const a = await openSessionTab(api, nextTab, 'alice', base + '/');
  await a.evaluate(() => {
    document.cookie = 'js=1; Path=/';
  });
  expect(await a.evaluate(() => document.cookie)).toBe('js=1');
  await expect.poll(() => whoami(a, base)).toBe('js=1');

  const def = await context.newPage();
  await def.goto(base + '/');
  expect(await def.evaluate(() => document.cookie)).toBe('');

  await a.evaluate(() => {
    document.cookie = 'js=; Max-Age=0; Path=/';
  });
  expect(await a.evaluate(() => document.cookie)).toBe('');
  await expect.poll(() => whoami(a, base)).toBe('');
});

test('web storage is namespaced per session and hidden from default tabs', async ({ api, nextTab, port, context }) => {
  const base = `http://localhost:${port}`;
  await api('saveSession', { session: draft('Alice') });
  await api('saveSession', { session: draft('Bob') });
  const a = await openSessionTab(api, nextTab, 'alice', base + '/');
  const b = await openSessionTab(api, nextTab, 'bob', base + '/');
  const def = await context.newPage();
  await def.goto(base + '/');

  await def.evaluate(() => localStorage.setItem('who', 'default'));
  await a.evaluate(() => localStorage.setItem('who', 'alice'));
  await b.evaluate(() => {
    localStorage.who = 'bob';
    sessionStorage.setItem('s', 'bob-session');
  });

  expect(await a.evaluate(() => [localStorage.getItem('who'), localStorage.length, Object.keys(localStorage)])).toEqual(['alice', 1, ['who']]);
  expect(await b.evaluate(() => [localStorage.who, sessionStorage.getItem('s')])).toEqual(['bob', 'bob-session']);

  await def.reload();
  expect(await def.evaluate(() => [localStorage.getItem('who'), localStorage.length, Object.keys(localStorage)])).toEqual(['default', 1, ['who']]);
});

test('a 302 right after login lands signed in', async ({ api, nextTab, port }) => {
  const base = `http://localhost:${port}`;
  await api('saveSession', { session: draft('Alice') });
  const a = await openSessionTab(api, nextTab, 'alice', `${base}/login?u=alice&next=/`);
  await expect(a.locator('#server')).toHaveText('sid=alice; ui=alice');
});

test('auto-mapping rules move navigations into a session, including on non-secure origins', async ({ api, context, port }) => {
  await api('saveSession', { session: draft('Dev') });
  await api('saveRules', { rules: [{ id: 'r1', pattern: '*.dev.test', sessionId: 'dev', priority: 0, enabled: true }] });

  const tab = await context.newPage();
  // The mapping redirect goes through the switch page, which then continues to the URL.
  await tab.goto(`http://app.dev.test:${port}/login?u=dev`);
  await tab.waitForURL(`http://app.dev.test:${port}/login?u=dev`);
  await expect(tab.locator('body')).toHaveText('ok');
  await tab.goto(`http://app.dev.test:${port}/`);
  await expect(tab.locator('#server')).toHaveText('sid=dev; ui=dev');
  // Plain http: no Server-Timing, so the shim relies on the bridge-repaired cache.
  await expect.poll(() => tab.evaluate(() => document.cookie)).toBe('ui=dev');
  expect((await context.cookies()).filter((c) => c.domain.includes('dev.test'))).toEqual([]);

  const other = await context.newPage();
  await other.goto(`http://other.test:${port}/`);
  await expect(other.locator('#server')).toHaveText('');
});

test('links opened from a session tab inherit its session', async ({ api, nextTab, port, context }) => {
  const base = `http://localhost:${port}`;
  await api('saveSession', { session: draft('Alice') });
  const a = await openSessionTab(api, nextTab, 'alice', `${base}/login?u=alice`);
  await a.goto(base + '/');
  const [popup] = await Promise.all([context.waitForEvent('page'), a.evaluate((u) => window.open(u + '/?child'), base)]);
  await expect(popup.locator('#server')).toHaveText('sid=alice; ui=alice');
});

test('export, clear and import restores a signed-in session', async ({ api, nextTab, port }) => {
  const base = `http://localhost:${port}`;
  await api('saveSession', { session: draft('Alice') });
  const a = await openSessionTab(api, nextTab, 'alice', `${base}/login?u=alice`);
  await a.goto(base + '/');
  await expect(a.locator('#server')).toHaveText('sid=alice; ui=alice');

  const backup = await api<string>('exportData', { passphrase: 'correct horse' });
  expect(backup).not.toContain('alice');
  await expect(api('importData', { text: backup, passphrase: 'wrong horse!', mode: 'merge' })).rejects.toThrow('Wrong passphrase');

  // Clearing reloads the session's tabs.
  await Promise.all([a.waitForEvent('load'), api('clearSession', { id: 'alice' })]);
  await expect(a.locator('#server')).toHaveText('');

  await api('importData', { text: backup, passphrase: 'correct horse', mode: 'merge' });
  await a.reload();
  await expect(a.locator('#server')).toHaveText('sid=alice; ui=alice');
});
