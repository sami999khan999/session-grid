import { useEffect, useState } from 'preact/hooks';
import type { Session } from '../core/types';
import { formatOffset, zoneLabel } from '../page/time';

/** Chip showing a session's time zone and shift with its current clock, if either is set. */
export function SessionClock({ session }: { session: Session }) {
  const [, tick] = useState(0);
  const set = !!(session.timeZone || session.timeOffset);
  useEffect(() => {
    if (!set) return;
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [set]);
  if (!set) return null;

  const at = Date.now() + (session.timeOffset ?? 0);
  const clock = new Date(at).toLocaleString(undefined, {
    timeZone: session.timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    ...(session.timeOffset ? { month: 'short', day: 'numeric' } : {}),
  });
  const zone = session.timeZone ? zoneLabel(session.timeZone, at) : 'Local time';
  const shift = formatOffset(session.timeOffset ?? 0);
  return (
    <span class="clock" title={`${session.timeZone ?? 'Browser time zone'}${shift ? `, shifted ${shift}` : ''}`}>
      <span class="clock-zone truncate">{zone}</span>
      <span class="clock-time">{clock}</span>
      {shift && <span class="clock-shift">{shift}</span>}
    </span>
  );
}
