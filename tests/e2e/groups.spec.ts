import { expect, test } from './fixtures';

const draft = (name: string) => ({ id: name.toLowerCase(), name, tag: name.slice(0, 3).toUpperCase(), color: 'blue', createdAt: 0 });

test('Show reopens every saved tab in the session and its group', async ({ context, sw, api, port }) => {
  const base = `http://localhost:${port}`;
  await api('saveSession', { session: draft('Admin') });
  await sw.evaluate(async (urls) => {
    await (globalThis as any).chrome.storage.local.set({ savedTabs: { admin: urls } });
  }, [1, 2, 3, 4].map((n) => `${base}/p${n}?delay=500`));

  // Like the real popup: the user is on an ordinary web page when they press Show.
  const home = await context.newPage();
  await home.goto(base + '/home');
  await home.bringToFront();
  await api('resumeSession', { sessionId: 'admin' });

  const id = new URL(sw.url()).host;
  const extPage = context.pages().find((p) => p.url().includes(id))!;
  const sessionTabs = () =>
    extPage.evaluate(async () => {
      const c = (globalThis as any).chrome;
      const { tabs: map = {} } = await c.storage.session.get('tabs');
      const tabs = await c.tabs.query({});
      return tabs
        .filter((t: any) => /\/p\d/.test(t.url ?? ''))
        .map((t: any) => ({ path: new URL(t.url).pathname, group: t.groupId, session: map[t.id] ?? null }));
    });

  await expect.poll(async () => (await sessionTabs()).map((t) => t.path)).toEqual(['/p1', '/p2', '/p3', '/p4']);
  // Give the group-change handlers time to act, then everything must still be in place.
  await new Promise((r) => setTimeout(r, 1500));
  const tabs = await sessionTabs();
  expect(tabs.every((t) => t.session === 'admin')).toBe(true);
  expect(tabs[0]!.group).not.toBe(-1);
  expect(new Set(tabs.map((t) => t.group)).size).toBe(1);
});
