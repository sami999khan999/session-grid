import { useEffect, useId, useRef, useState } from 'preact/hooks';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Session colour, drawn as a voxel next to the label. */
  color?: string;
}

/**
 * A themed replacement for `<select>`: a select-only combobox per the ARIA practices. Focus stays
 * on the trigger; arrows, Home/End and type-ahead move the highlight, Enter/Space/Tab pick it.
 */
export function Select<T extends string>({ value, options, onChange, label }: { value: T; options: SelectOption<T>[]; onChange: (v: T) => void; label: string }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.find((o) => o.value === value);

  const show = (at = Math.max(0, options.findIndex((o) => o.value === value))) => {
    // Open upwards when the list wouldn't fit below the trigger.
    const r = root.current!.getBoundingClientRect();
    const need = Math.min(options.length * 34 + 14, 260);
    setUp(innerHeight - r.bottom < need && r.top > innerHeight - r.bottom);
    setActive(at);
    setOpen(true);
  };
  const pick = (i: number) => {
    const o = options[i];
    if (o && o.value !== value) onChange(o.value);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    addEventListener('pointerdown', away);
    return () => removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => {
    if (open) (list.current?.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKey = (e: KeyboardEvent) => {
    const last = options.length - 1;
    const move = (i: number) => (e.preventDefault(), open ? setActive(Math.max(0, Math.min(last, i))) : show());
    switch (e.key) {
      case 'ArrowDown': return move(active + 1);
      case 'ArrowUp': return move(active - 1);
      case 'Home': return open && move(0);
      case 'End': return open && move(last);
      case 'Enter':
      case ' ':
        e.preventDefault();
        return open ? pick(active) : show();
      case 'Escape': return open && (e.preventDefault(), setOpen(false));
      case 'Tab': return open && pick(active);
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const k = e.key.toLowerCase();
          const from = open ? active + 1 : 0;
          const hit = [...options.slice(from), ...options.slice(0, from)].find((o) => o.label.toLowerCase().startsWith(k));
          if (hit) {
            const i = options.indexOf(hit);
            open ? setActive(i) : show(i);
          }
        }
    }
  };

  return (
    <div ref={root} class={`select ${open ? 'open' : ''} ${up ? 'up' : ''}`}>
      <button
        type="button"
        role="combobox"
        class="select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        {selected?.color && <span class="dot" style={{ background: selected.color }} />}
        <span class="grow truncate">{selected?.label ?? 'Choose…'}</span>
        <span class="chevron" aria-hidden="true" />
      </button>
      {open && (
        <ul ref={list} id={`${id}-list`} role="listbox" aria-label={label} class="select-list plate">
          {options.map((o, i) => (
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
