import { EV_TIME, TIME_KEY, installClock, type TimeConfig } from '../src/page/time';

/**
 * Page-world clock for session tabs: applies the session's time zone and time shift to Date and
 * Intl. Starts from the config this tab last saw, then the bridge pushes the current one.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: true,
  matchAboutBlank: true,
  exclude: ['firefox'],
  main() {
    const store = (() => {
      try {
        return window.sessionStorage;
      } catch {
        return null;
      }
    })();
    let config: TimeConfig = { offset: 0 };
    try {
      const cached = store?.getItem(TIME_KEY);
      if (cached) config = JSON.parse(cached) as TimeConfig;
    } catch {}
    // Frames inherit the parent's clock when they can see it.
    if (window !== window.parent) {
      try {
        const parent = (window.parent as unknown as Record<symbol, () => TimeConfig>)[Symbol.for('sessionstack.clock')];
        if (parent) config = parent();
      } catch {}
    }
    Object.defineProperty(window, Symbol.for('sessionstack.clock'), { value: () => config });

    document.addEventListener(EV_TIME, (e) => {
      try {
        config = JSON.parse(String((e as CustomEvent).detail)) as TimeConfig;
        if (config.timeZone || config.offset) store?.setItem(TIME_KEY, JSON.stringify(config));
        else store?.removeItem(TIME_KEY);
      } catch {}
    });

    installClock(() => config);
  },
});
