import { SESSION_COLORS, newId, type Session, type SessionColor } from '../core/types';

const COLORS = Object.keys(SESSION_COLORS) as SessionColor[];

export function draftSession(existing: Session[], name = ''): Session {
  const n = existing.length + 1;
  const label = name.trim() || `Session ${n}`;
  return {
    id: newId(),
    name: label,
    tag: label.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 4).toUpperCase() || `S${n}`,
    color: COLORS[existing.length % COLORS.length]!,
    createdAt: Date.now(),
  };
}
