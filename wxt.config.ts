import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

export default defineConfig({
  srcDir: '.',
  manifestVersion: 3,
  vite: () => ({ plugins: [preact()] }),
  // Keep previous release artifacts out of the Firefox sources zip.
  zip: { excludeSources: ['release/**'] },
  manifest: ({ browser }) => ({
    name: 'SessionStack',
    description: 'Run several isolated logins for the same site side by side, one session per tab.',
    permissions: [
      'tabs',
      'storage',
      'webRequest',
      'webNavigation',
      ...(browser === 'firefox'
        ? ['cookies', 'contextualIdentities', 'webRequestBlocking', 'browsingData']
        : ['declarativeNetRequestWithHostAccess']),
    ],
    host_permissions: ['<all_urls>'],
    commands: Object.fromEntries(
      [1, 2, 3, 4].map((n) => [
        `open-session-${n}`,
        {
          description: `Open a new tab in session ${n}`,
          suggested_key: { default: `Alt+Shift+${n}` },
        },
      ]),
    ),
    // Auto-mapping redirects land on this page (Chrome); DNR can only redirect to accessible resources.
    ...(browser === 'firefox' ? {} : { web_accessible_resources: [{ resources: ['switch.html'], matches: ['<all_urls>'] }] }),
    ...(browser === 'firefox'
      ? { browser_specific_settings: { gecko: { id: 'sessionstack@session-grid', strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } } } }
      : {}),
  }),
});
