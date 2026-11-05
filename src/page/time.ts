/** Per-session clock: an IANA time zone and a shift from real time. */
export interface TimeConfig {
  /** IANA zone such as `America/New_York`; absent means the browser's own zone. */
  timeZone?: string;
  /** Milliseconds added to the real clock; negative goes back in time. */
  offset: number;
}

/** Bridge → page: new clock config (detail: JSON TimeConfig). */
export const EV_TIME = 'ssx:time';
/** Real-sessionStorage key caching the tab's clock so reloads start correct. */
export const TIME_KEY = '__ssx_time';

const UNITS: [number, string][] = [
  [86_400_000, 'd'],
  [3_600_000, 'h'],
  [60_000, 'm'],
];

/** `+2d 3h`, `-45m`, or '' for no shift. */
export function formatOffset(ms: number): string {
  if (!ms) return '';
  let rest = Math.abs(ms);
  const parts: string[] = [];
  for (const [size, unit] of UNITS) {
    const n = Math.floor(rest / size);
    if (n) parts.push(`${n}${unit}`);
    rest -= n * size;
  }
  return (ms < 0 ? '-' : '+') + (parts.join(' ') || '<1m');
}

/** Short zone label for a card, e.g. `New York · GMT-5`. */
export function zoneLabel(timeZone: string, at = Date.now()): string {
  const city = timeZone.split('/').pop()!.replace(/_/g, ' ');
  try {
    const gmt = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    return gmt ? `${city} · ${gmt}` : city;
  } catch {
    return city;
  }
}

/**
 * Patch Date and Intl.DateTimeFormat in the current realm so the page sees `get()`'s zone and
 * shifted clock. `get` is read on every call, so config changes apply live.
 */
export function installClock(get: () => TimeConfig): void {
  const NativeDate = Date;
  const proto = NativeDate.prototype;
  const nativeNow = NativeDate.now;
  const NDTF = Intl.DateTimeFormat;
  const native = <K extends keyof Date>(k: K) => proto[k] as unknown as (...a: unknown[]) => unknown;
  const n = {
    getTime: native('getTime'),
    setTime: native('setTime'),
    getTimezoneOffset: native('getTimezoneOffset'),
    toLocaleString: native('toLocaleString'),
    toLocaleDateString: native('toLocaleDateString'),
    toLocaleTimeString: native('toLocaleTimeString'),
    parse: NativeDate.parse,
    UTC: NativeDate.UTC,
  };
  const time = (d: Date) => n.getTime.call(d) as number;

  const fmts = new Map<string, Intl.DateTimeFormat>();
  const fmt = (tz: string) => {
    let f = fmts.get(tz);
    if (!f) {
      f = new NDTF('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short' });
      fmts.set(tz, f);
    }
    return f;
  };
  /** Wall-clock time in `tz` at instant `t`, as a UTC epoch value. */
  const wallOf = (t: number, tz: string) => {
    if (!isFinite(t)) return NaN;
    const p: Record<string, string> = {};
    for (const part of fmt(tz).formatToParts(t)) p[part.type] = part.value;
    const y = p.era === 'BC' || p.era === 'B' ? 1 - Number(p.year) : Number(p.year);
    const d = new NativeDate(0);
    d.setUTCFullYear(y, Number(p.month) - 1, Number(p.day));
    d.setUTCHours(Number(p.hour) % 24, Number(p.minute), Number(p.second), ((t % 1000) + 1000) % 1000);
    return time(d);
  };
  const zone = () => {
    const tz = get().timeZone;
    if (!tz) return undefined;
    try {
      fmt(tz);
      return tz;
    } catch {
      return undefined;
    }
  };
  /** Instant whose wall time in `tz` is `wall` (earlier match across DST gaps/overlaps). */
  const fromWall = (wall: number, tz: string) => {
    if (!isFinite(wall)) return NaN;
    let t = wall - (wallOf(wall, tz) - wall);
    t = wall - (wallOf(t, tz) - t);
    return t;
  };
  const now = () => nativeNow() + (get().offset || 0);

  const hasZone = /(?:Z|[+-]\d\d:?\d\d|\b(?:GMT|UTC|UT)\b.*)$|^\d{4}(?:-\d\d){0,2}$/i;
  const parse = (s: string) => {
    const p = n.parse(s) as number;
    const tz = zone();
    if (!tz || !isFinite(p) || hasZone.test(s.trim())) return p;
    const wall = p - (n.getTimezoneOffset.call(new NativeDate(p)) as number) * 60_000;
    return fromWall(wall, tz);
  };

  function FakeDate(this: unknown, ...args: unknown[]) {
    if (!new.target) return (new (FakeDate as unknown as DateConstructor)() as Date).toString();
    let d: Date;
    if (args.length === 0) d = new NativeDate(now());
    else if (args.length === 1) {
      const a = args[0];
      d = typeof a === 'string' ? new NativeDate(parse(a)) : new NativeDate(a instanceof NativeDate ? time(a) : (a as number));
    } else {
      const tz = zone();
      d = tz
        ? new NativeDate(fromWall((n.UTC as (...a: unknown[]) => number)(...args), tz))
        : new (NativeDate as unknown as new (...a: unknown[]) => Date)(...args);
    }
    if (new.target !== FakeDate) Object.setPrototypeOf(d, new.target.prototype);
    return d;
  }
  Object.defineProperties(FakeDate, {
    prototype: { value: proto },
    length: { value: 7 },
    name: { value: 'Date' },
    now: { value: now, writable: true, configurable: true },
    parse: { value: parse, writable: true, configurable: true },
    UTC: { value: n.UTC, writable: true, configurable: true },
  });
  Object.defineProperty(proto, 'constructor', { value: FakeDate, writable: true, configurable: true });
  Object.defineProperty(globalThis, 'Date', { value: FakeDate, writable: true, configurable: true });

  // Local getters/setters read and write the wall clock of the chosen zone.
  const wall = (d: Date, tz: string) => new NativeDate(wallOf(time(d), tz));
  const patch = (name: string, impl: (this: Date, tz: string, orig: (...a: unknown[]) => unknown, args: unknown[]) => unknown) => {
    const orig = (proto as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value: {
        [name](this: Date, ...args: unknown[]) {
          const tz = zone();
          return tz ? impl.call(this, tz, orig, args) : orig.apply(this, args);
        },
      }[name],
    });
  };
  for (const part of ['FullYear', 'Month', 'Date', 'Day', 'Hours', 'Minutes', 'Seconds', 'Milliseconds']) {
    const getUTC = (proto as unknown as Record<string, () => number>)[`getUTC${part}`]!;
    patch(`get${part}`, function (tz) {
      return getUTC.call(wall(this, tz));
    });
    if (part === 'Day') continue;
    const setUTC = (proto as unknown as Record<string, (...a: unknown[]) => number>)[`setUTC${part}`]!;
    patch(`set${part}`, function (tz, _o, args) {
      const w = wall(this, tz);
      setUTC.apply(w, args);
      return n.setTime.call(this, fromWall(time(w), tz));
    });
  }
  patch('getYear', function (tz) {
    return wall(this, tz).getUTCFullYear() - 1900;
  });
  patch('getTimezoneOffset', function (tz) {
    const t = time(this);
    return isFinite(t) ? -Math.round((wallOf(t, tz) - t) / 60_000) : NaN;
  });

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (v: number, l = 2) => String(Math.abs(v)).padStart(l, '0');
  const datePart = (w: Date) => {
    const y = w.getUTCFullYear();
    return `${DAYS[w.getUTCDay()]} ${MONTHS[w.getUTCMonth()]} ${pad(w.getUTCDate())} ${y < 0 ? '-' : ''}${pad(y, 4)}`;
  };
  const timePart = (d: Date, w: Date, tz: string) => {
    const off = -(proto.getTimezoneOffset as () => number).call(d);
    let name = '';
    try {
      name = new NDTF('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(time(d)).find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch {}
    const gmt = `GMT${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
    return `${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}:${pad(w.getUTCSeconds())} ${gmt}${name ? ` (${name})` : ''}`;
  };
  const invalid = (d: Date) => !isFinite(time(d));
  patch('toString', function (tz) {
    if (invalid(this)) return 'Invalid Date';
    const w = wall(this, tz);
    return `${datePart(w)} ${timePart(this, w, tz)}`;
  });
  patch('toDateString', function (tz) {
    return invalid(this) ? 'Invalid Date' : datePart(wall(this, tz));
  });
  patch('toTimeString', function (tz) {
    return invalid(this) ? 'Invalid Date' : timePart(this, wall(this, tz), tz);
  });
  const withZone = (opts: unknown, tz: string | undefined) =>
    tz && !(opts && typeof opts === 'object' && 'timeZone' in opts && (opts as { timeZone?: unknown }).timeZone !== undefined)
      ? { ...(opts as object), timeZone: tz }
      : opts;
  for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'] as const) {
    patch(name, function (tz, orig, [locales, opts]) {
      return orig.call(this, locales, withZone(opts, tz));
    });
  }

  // Intl.DateTimeFormat defaults to the zone, and formats the shifted clock when given no date.
  function DTF(this: unknown, locales?: unknown, opts?: unknown) {
    return new (NDTF as unknown as new (...a: unknown[]) => Intl.DateTimeFormat)(locales, withZone(opts, zone()));
  }
  Object.defineProperties(DTF, {
    prototype: { value: NDTF.prototype },
    length: { value: 0 },
    name: { value: 'DateTimeFormat' },
    supportedLocalesOf: { value: NDTF.supportedLocalesOf, writable: true, configurable: true },
  });
  Object.defineProperty(NDTF.prototype, 'constructor', { value: DTF, writable: true, configurable: true });
  Object.defineProperty(Intl, 'DateTimeFormat', { value: DTF, writable: true, configurable: true });
  const formatGetter = Object.getOwnPropertyDescriptor(NDTF.prototype, 'format')!.get!;
  Object.defineProperty(NDTF.prototype, 'format', {
    configurable: true,
    get(this: Intl.DateTimeFormat) {
      const f = formatGetter.call(this) as (d?: unknown) => string;
      return (d?: unknown) => f(d === undefined ? now() : d);
    },
  });
  const formatToParts = NDTF.prototype.formatToParts;
  NDTF.prototype.formatToParts = function (d?: Date | number) {
    return formatToParts.call(this, d === undefined ? now() : d);
  };
}

/** Largest shift accepted from the user: 10 years either way. */
export const MAX_OFFSET = 10 * 365 * 86_400_000;

const UNIT_MS: Record<string, number> = {
  w: 604_800_000, wk: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
};

/**
 * Parse a typed time shift such as `+2d 3h`, `-90m`, `1 week 2 days` or `-1.5h`. One optional
 * sign at the start applies to the whole value; empty or `0` means real time.
 */
export function parseOffset(input: string): { ok: true; ms: number } | { ok: false; error: string } {
  const text = input.trim().toLowerCase().replace(/,/g, ' ');
  if (!text || /^[+-]?0+$/.test(text)) return { ok: true, ms: 0 };
  const sign = text[0] === '-' || text[0] === '−' ? -1 : 1;
  const body = text.replace(/^[+\-−]\s*/, '');
  if (/[+\-−]/.test(body)) return { ok: false, error: 'Use one + or − at the start, e.g. -1d 2h.' };
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)\s*/gy;
  let total = 0;
  let pos = 0;
  const seen = new Set<number>();
  for (let m; (m = re.exec(body)); pos = re.lastIndex) {
    const unit = UNIT_MS[m[2]!];
    if (!unit) return { ok: false, error: `Unknown unit “${m[2]}”. Use w, d, h or m.` };
    if (seen.has(unit)) return { ok: false, error: `“${m[2]}” is given twice.` };
    seen.add(unit);
    total += Number(m[1]) * unit;
  }
  if (pos !== body.length || !seen.size) {
    return { ok: false, error: /^\d+(\.\d+)?$/.test(body) ? 'Add a unit, e.g. 3h or 2d.' : 'Write it like +2d 3h, -90m or 1w.' };
  }
  const ms = Math.round(total / 60_000) * 60_000 * sign;
  if (Math.abs(ms) > MAX_OFFSET) return { ok: false, error: 'Keep the shift within 10 years.' };
  if (!ms) return { ok: false, error: 'The shift is less than a minute.' };
  return { ok: true, ms };
}
