import { chromium, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import path from 'node:path';
import { startServer } from './server';

const extensionPath = path.resolve('.output/chrome-mv3');

interface Fixtures {
  context: BrowserContext;
  sw: Worker;
  port: number;
  /** Call the extension API the way the popup does. */
  api: <T = unknown>(type: string, req?: object) => Promise<T>;
  /** Wait for the tab the extension opens next. */
  nextTab: (action: () => Promise<unknown>) => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  port: async ({}, use) => {
    const server = await startServer();
    await use(server.port);
    server.close();
  },
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        // *.test resolves to the local server: a non-secure origin, unlike localhost.
        '--host-resolver-rules=MAP *.test 127.0.0.1',
      ],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },
  api: async ({ context, sw }, use) => {
    const id = new URL(sw.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    await use(async (type, req = {}) => {
      const res = await page.evaluate(([t, r]) => (globalThis as any).chrome.runtime.sendMessage({ type: t, ...(r as object) }), [type, req] as const);
      if (!res.ok) throw new Error(res.error);
      return res.value;
    });
  },
  nextTab: async ({ context }, use) => {
    await use(async (action) => {
      const [page] = await Promise.all([context.waitForEvent('page'), action()]);
      return page;
    });
  },
});

export const expect = test.expect;

/** Poll the server's view of the cookies sent from a tab. */
export async function whoami(page: Page, base: string): Promise<string> {
  return page.evaluate(async (u) => (await fetch(u + '/whoami', { cache: 'no-store' })).text(), base);
}
