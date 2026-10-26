# SessionStack

A browser extension for several logins to the same site side by side in one window. Each tab belongs to a **session** with its own cookies and site storage. Examples: production admin in one tab, a staging developer in the next, a client QA account in a third.

Works in Chrome/Chromium (Manifest V3) and Firefox (Manifest V3, 140+).

## Features

- **Per-tab sessions.** Open a new tab in a session, or move the current tab into one, from the toolbar popup. The toolbar badge shows the tab's session tag.
- **Isolation.** Cookies, `document.cookie`, `cookieStore`, `localStorage` and `sessionStorage`.
- **Auto-session rules.** URL globs such as `*.staging.example.com` or `https://example.com/admin/*` route navigations into a session.
- **Encrypted export/import.** Sessions, rules and cookies go into a passphrase-protected file (PBKDF2-SHA-256 with 600k iterations, then AES-GCM-256). Merge into or replace the current setup.
- **Hotkeys.** `Alt+Shift+1…4` open a new tab in the first four sessions.

## How it works

Both engines sit behind one interface in `src/engines/engine.ts`.

**Firefox** maps each session to a native container (`contextualIdentities`). The browser itself isolates cookies, storage and IndexedDB. Rules are enforced with a blocking `webRequest` listener that reopens the URL in the right container.

**Chrome** has no containers, so SessionStack keeps its own RFC 6265 cookie jar per session (`src/engines/chromium/`):

- A non-blocking `webRequest.onHeadersReceived` listener (`extraHeaders`) stores each response's `Set-Cookie` in the session jar.
- The jar is compiled into `declarativeNetRequest` session rules scoped to the session's `tabIds`:
  - A fail-closed base rule removes the browser's own `Cookie` header and strips `Set-Cookie`, so the real jar is never touched.
  - Per host/path/scheme/SameSite rules set the jar's `Cookie` header.
- The same rules stamp a `Server-Timing` response header with the session key and the script-visible cookies.
- A MAIN-world content script (`entrypoints/shim.content.ts`) reads that header synchronously at `document_start`, before any page script runs. It then serves `document.cookie` from it and namespaces web storage per session.
  - On plain-http pages `Server-Timing` isn't exposed. The shim falls back to a per-tab cache that the isolated-world bridge keeps up to date, and the bridge reloads once if the cache was wrong.
- Auto-session rules compile to DNR redirects through `switch.html`. The tab joins the session *before* the first request is sent.
- Login flows where a redirect races the rule update are detected. The extension compares the `Cookie` header that was actually sent with the jar, and reloads the page when they differ.

## Known limitations (Chrome)

- **Not isolated:** IndexedDB, Cache Storage and site service workers (requests from a service worker have no tab). On these, partitioned tabs share data with the default session.
- **Pop-ups and links:** a tab opened from a session tab (with the "inherit" preference on) may send its first request with default-session cookies before it is moved and reloaded.
- **Restarts:** after a browser restart, session tabs are matched back by URL and position. Unmatched tabs fall back to the default session. This is safe: no cookies cross between sessions.
- **Rule budget:** Chrome caps regex rules at 1000. Sessions with cookies for very many hosts stop sending cookies to their oldest hosts first (fail-closed), and a warning is logged.
- **Storage on disk:** session jars are kept unencrypted in the extension's local storage, like the browser's own cookie store. Export files are encrypted.

## Development

```sh
pnpm install
pnpm dev               # Chrome with hot reload
pnpm dev:firefox       # Firefox
pnpm build             # .output/chrome-mv3
pnpm build:firefox     # .output/firefox-mv3
pnpm zip && pnpm zip:firefox   # store packages
```

### Tests

```sh
pnpm compile           # type-check
pnpm test              # unit tests (Vitest): rules, crypto, cookie jar, DNR compiler, page shims
pnpm test:e2e          # builds, then drives Chromium with the extension against a local test server
```

The end-to-end suite (`tests/e2e/`) needs Playwright's Chromium (`pnpm exec playwright install chromium`). It covers:
- two simultaneous logins on the same site
- the real cookie jar staying clean
- `document.cookie` at inline-script time
- script-set cookies
- web-storage namespacing
- login redirects
- auto-mapping on a non-secure origin
- pop-up inheritance
- export → clear → import

There is no automated Firefox run yet. Use `pnpm dev:firefox` and check the same flows by hand. `pnpm exec web-ext lint -s .output/firefox-mv3` validates the package.

## Layout

```
entrypoints/
  background.ts          service worker: state, API, badges, hotkeys
  popup/  options/       Preact UI
  switch/                auto-mapping redirect target (Chrome)
  shim.content.ts        MAIN-world cookie/storage shim (Chrome)
  bridge.content.ts      isolated-world bridge between shim and background (Chrome)
src/core/                types, storage, messaging, URL rules, crypto
src/engines/chromium/    cookie jar, DNR rule compiler, engine
src/engines/firefox/     container engine
src/page/                storage proxy and cookie view used by the shim
```
