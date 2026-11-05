import { createGlassScroll, type GlassScrollInstance } from 'glass-scroll/core';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Session colour, drawn as a voxel next to the label. */
  color?: string;
  /** Muted text on the right, e.g. a time difference. */
  hint?: string;
}

/** Lists longer than this get a search box. */
const SEARCH_FROM = 10;

/**
 * A themed replacement for `<select>`: a select-only combobox per the ARIA practices. Arrows,
 * Home/End and type-ahead move the highlight, Enter/Space/Tab pick it. Long lists open with a
 * search box that filters the options as you type.
 */
export function Select<T extends string>({ value, options, onChange, label }: { value: T; options: SelectOption<T>[]; onChange: (v: T) => void; label: string }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const bar = useRef<GlassScrollInstance | null>(null);
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const searchable = options.length > SEARCH_FROM;
  const selected = options.find((o) => o.value === value);

  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : options;

  const show = (at = Math.max(0, options.findIndex((o) => o.value === value)), initial = '') => {
    // Open upwards when the list wouldn't fit below the trigger.
    const r = root.current!.getBoundingClientRect();
    const need = Math.min(options.length * 34 + 14, 260) + (searchable ? 44 : 0);
    setUp(innerHeight - r.bottom < need && r.top > innerHeight - r.bottom);
    setQuery(initial);
    setActive(initial ? 0 : at);
    setOpen(true);
  };
  const close = (refocus = false) => {
    setOpen(false);
    setQuery('');
    if (refocus) trigger.current?.focus();
  };
  const pick = (i: number) => {
    const o = shown[i];
    if (o && o.value !== value) onChange(o.value);
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && close();
    addEventListener('pointerdown', away);
    return () => removeEventListener('pointerdown', away);
  }, [open]);
  // Long lists (e.g. time zones) get the same glass thumb as the page.
  useEffect(() => {
    if (!open || !list.current || !pop.current) return;
    bar.current = createGlassScroll(list.current, { axis: 'y', container: pop.current });
    return () => {
      bar.current?.destroy();
      bar.current = null;
    };
  }, [open]);
  useEffect(() => {
    if (open) (list.current?.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);
  useEffect(() => {
    if (!open) return;
    if (list.current && q) list.current.scrollTop = 0;
    bar.current?.update();
  }, [open, q]);

  /** Arrow/Enter/Escape handling shared by the trigger and the search box. */
  const nav = (e: KeyboardEvent, typing: boolean): boolean => {
    const last = shown.length - 1;
    const move = (i: number) => (e.preventDefault(), open ? setActive(Math.max(0, Math.min(last, i))) : show());
    switch (e.key) {
      case 'ArrowDown': move(active + 1); return true;
      case 'ArrowUp': move(active - 1); return true;
      case 'Home': if (open && !typing) move(0); return !typing;
      case 'End': if (open && !typing) move(last); return !typing;
      case 'Enter':
        e.preventDefault();
        open ? pick(active) : show();
        return true;
      case ' ':
        if (typing) return false;
        e.preventDefault();
        open ? pick(active) : show();
        return true;
      case 'Escape':
        if (open) {
          e.preventDefault();
          close(true);
        }
        return true;
      case 'Tab':
        if (open) pick(active);
        return true;
    }
    return false;
  };

  const onTriggerKey = (e: KeyboardEvent) => {
    if (nav(e, false)) return;
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    if (searchable) {
      // Start a search with the typed key; the search box takes focus when it mounts.
      e.preventDefault();
      show(0, e.key);
      return;
    }
    const k = e.key.toLowerCase();
    const from = open ? active + 1 : 0;
    const hit = [...options.slice(from), ...options.slice(0, from)].find((o) => o.label.toLowerCase().startsWith(k));
    if (hit) {
      const i = options.indexOf(hit);
      open ? setActive(i) : show(i);
    }
  };

  return (
    <div ref={root} class={`select ${open ? 'open' : ''} ${up ? 'up' : ''}`}>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        class="select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && !searchable ? `${id}-${active}` : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={onTriggerKey}
      >
        {selected?.color && <span class="dot" style={{ background: selected.color }} />}
        <span class="grow truncate">{selected?.label ?? 'Choose…'}</span>
        <span class="chevron" aria-hidden="true" />
      </button>
      {open && (
        <div class="select-pop plate">
          {searchable && (
            <div class="select-search">
            <input
              type="search"
              placeholder="Search…"
              aria-label={`Search ${label.toLowerCase()}`}
              aria-controls={`${id}-list`}
              aria-activedescendant={shown.length ? `${id}-${active}` : undefined}
              value={query}
              ref={(el) => {
                if (el && document.activeElement !== el) el.focus();
              }}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setActive(0);
              }}
              onKeyDown={(e) => void nav(e, true)}
            />
            </div>
          )}
          <div ref={pop} class="select-scroll">
          <ul ref={list} id={`${id}-list`} role="listbox" aria-label={label} class="select-list">
            {shown.map((o, i) => (
              <li
                key={o.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={o.value === value}
                class={i === active ? 'active' : ''}
                onPointerMove={() => setActive(i)}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
              >
                {o.color && <span class="dot" style={{ background: o.color }} />}
                <span class="grow truncate">{o.label}</span>
                {o.hint && <span class="select-hint">{o.hint}</span>}
              </li>
            ))}
            {!shown.length && <li class="select-empty muted" aria-disabled="true">No matches</li>}
          </ul>
          </div>
        </div>
      )}
    </div>
  );
}
