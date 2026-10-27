import { buildCSS, createGlassScroll } from 'glass-scroll/core';

// Brass-tinted glass thumb. Injected as a string: the package is `sideEffects: false`, so a bare
// CSS import could be dropped from the build.
const css = buildCSS({
  theme: {
    thumbSize: 7,
    thumbSizeHover: 9,
    thumbBlur: 3,
    thumbBg: 'rgba(176, 118, 38, 0.55)',
    thumbBgHover: 'rgba(176, 118, 38, 0.75)',
    thumbBgActive: 'rgba(196, 83, 28, 0.85)',
    thumbShadow: 'inset 0 0 0 1px rgba(255, 228, 160, 0.55), 0 1px 3px rgba(43, 29, 18, 0.35)',
    dark: {
      thumbBg: 'rgba(217, 164, 65, 0.45)',
      thumbBgHover: 'rgba(217, 164, 65, 0.7)',
      thumbBgActive: 'rgba(224, 117, 47, 0.85)',
      thumbShadow: 'inset 0 0 0 1px rgba(246, 213, 138, 0.4), 0 1px 4px rgba(0, 0, 0, 0.6)',
    },
  },
});

export function mountGlassScroll() {
  document.head.append(Object.assign(document.createElement('style'), { textContent: css }));
  return createGlassScroll(window, { axis: 'y' });
}
