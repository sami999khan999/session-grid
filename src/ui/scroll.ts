import { buildCSS, createGlassScroll } from 'glass-scroll/core';

// Water-tinted glass thumb. Injected as a string: the package is `sideEffects: false`, so a bare
// CSS import could be dropped from the build.
const css = buildCSS({
  theme: {
    thumbSize: 7,
    thumbSizeHover: 9,
    thumbBlur: 3,
    thumbBg: 'rgba(42, 166, 184, 0.5)',
    thumbBgHover: 'rgba(42, 166, 184, 0.72)',
    thumbBgActive: 'rgba(94, 154, 44, 0.85)',
    thumbShadow: 'inset 0 0 0 1px rgba(200, 245, 250, 0.55), 0 1px 3px rgba(43, 38, 53, 0.35)',
    dark: {
      thumbBg: 'rgba(95, 208, 220, 0.45)',
      thumbBgHover: 'rgba(95, 208, 220, 0.7)',
      thumbBgActive: 'rgba(143, 209, 79, 0.85)',
      thumbShadow: 'inset 0 0 0 1px rgba(190, 240, 246, 0.4), 0 1px 4px rgba(0, 0, 0, 0.6)',
    },
  },
});

export function mountGlassScroll() {
  document.head.append(Object.assign(document.createElement('style'), { textContent: css }));
  return createGlassScroll(window, { axis: 'y' });
}
