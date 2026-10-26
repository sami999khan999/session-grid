import { useEffect, useState } from 'preact/hooks';
import { call } from '../core/messages';
import { onStateChanged } from '../core/store';
import type { AppState } from '../core/types';

export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null);
  useEffect(() => {
    void call('getState', {}).then(setState);
    return onStateChanged(setState);
  }, []);
  return state;
}

export const isFirefox = import.meta.env.FIREFOX;
