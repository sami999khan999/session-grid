import { afterAll, describe, expect, it } from 'vitest';
import { formatOffset, installClock, parseOffset, type TimeConfig } from '../../src/page/time';

const RealDate = Date;
const RealDTF = Intl.DateTimeFormat;
let config: TimeConfig = { offset: 0 };
installClock(() => config);
afterAll(() => {
  globalThis.Date = RealDate;
  Intl.DateTimeFormat = RealDTF;
});

describe('session clock', () => {
  it('reports wall time in the chosen zone', () => {
    config = { timeZone: 'Asia/Tokyo', offset: 0 };
    const d = new Date('2026-01-15T00:30:00Z');
    expect(d.getHours()).toBe(9);
    expect(d.getTimezoneOffset()).toBe(-540);
    expect(d.toString()).toBe('Thu Jan 15 2026 09:30:00 GMT+0900 (Japan Standard Time)');
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Tokyo');
  });

  it('builds local dates in the zone, across DST', () => {
    config = { timeZone: 'America/New_York', offset: 0 };
    expect(new Date(2026, 6, 1, 12).toISOString()).toBe('2026-07-01T16:00:00.000Z');
    expect(new Date(2026, 0, 1, 12).toISOString()).toBe('2026-01-01T17:00:00.000Z');
    expect(new Date('2026-07-01T12:00').toISOString()).toBe('2026-07-01T16:00:00.000Z');
    const d = new Date('2026-03-01T12:00:00Z');
    d.setHours(0, 0, 0, 0);
    expect(d.toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(d instanceof Date && d instanceof RealDate).toBe(true);
  });

  it('shifts the clock', () => {
    config = { offset: 86_400_000 };
    expect(Math.abs(Date.now() - RealDate.now() - 86_400_000)).toBeLessThan(50);
    expect(Math.abs(new Date().getTime() - RealDate.now() - 86_400_000)).toBeLessThan(50);
    config = { offset: 0 };
  });

  it('formats offsets', () => {
    expect(formatOffset(-3_600_000)).toBe('-1h');
    expect(formatOffset(90_000_000)).toBe('+1d 1h');
    expect(formatOffset(0)).toBe('');
  });
});

describe('parseOffset', () => {
  it('accepts typed shifts', () => {
    expect(parseOffset('+2d 3h')).toEqual({ ok: true, ms: 2 * 86_400_000 + 3 * 3_600_000 });
    expect(parseOffset('-90m')).toEqual({ ok: true, ms: -5_400_000 });
    expect(parseOffset('1 week, 2 days')).toEqual({ ok: true, ms: 9 * 86_400_000 });
    expect(parseOffset('-1.5h')).toEqual({ ok: true, ms: -5_400_000 });
    expect(parseOffset('')).toEqual({ ok: true, ms: 0 });
    expect(parseOffset(formatOffset(-90_060_000))).toEqual({ ok: true, ms: -90_060_000 });
  });
  it('rejects bad input', () => {
    for (const bad of ['abc', '5', '2x', '1d -2h', '1d 1d', '20000d', '10s', '2d junk']) {
      expect(parseOffset(bad).ok, bad).toBe(false);
    }
  });
});
