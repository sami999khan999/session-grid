import { call } from '../../src/core/messages';

// Hash: "<sessionId>|<original URL>", written by the auto-mapping redirect rule. Not decoded:
// that would also decode the original URL's own escapes.
const hash = location.hash.slice(1);
const i = hash.indexOf('|');
const sessionId = hash.slice(0, i);
const target = hash.slice(i + 1);

if (i > 0 && /^https?:\/\//i.test(target)) {
  call('joinSession', { sessionId })
    .then(() => location.replace(target))
    .catch((err: unknown) => {
      document.getElementById('msg')!.textContent = `Could not switch session: ${err instanceof Error ? err.message : String(err)}`;
    });
} else {
  document.getElementById('msg')!.textContent = 'Nothing to open.';
}
