'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { auth, mode } from './api';
import { useApi, useLiveIdentity } from './api-context';

const subscribeHydration = (listener: () => void) => useAppStore.persist?.onFinishHydration(listener) ?? (() => undefined);
const hydrated = () => useAppStore.persist?.hasHydrated() ?? false;
const subscribeMounted = () => () => undefined;
const yes = () => true;
const no = () => false;
const noIdentity = () => null;

export function useHydrated() {
  const mounted = useSyncExternalStore(subscribeMounted, yes, no);
  const ready = useSyncExternalStore(subscribeHydration, hydrated, no);
  return mounted && (mode === 'live' || ready || !useAppStore.persist);
}

export function useIdentity() {
  const live = useLiveIdentity();
  const ready = useHydrated();
  const identity = useSyncExternalStore(auth.subscribe, auth.identity, noIdentity);
  return mode === 'live' ? live : ready ? identity : null;
}

export function useData<T>(load: () => Promise<T>) {
  const api = useApi();
  const ready = useHydrated();
  const [state, setState] = useState<{ loader: typeof load; data?: T; error?: string }>();
  useEffect(() => {
    if (!ready) return;
    let active = true;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      void load().then(
        data => { if (active && request === current) setState({ loader: load, data }); },
        (error: unknown) => { if (active && request === current) setState({ loader: load, error: error instanceof Error ? error.message : 'Request failed.' }); },
      );
    };
    const unsubscribe = api.subscribe(refresh);
    refresh();
    return () => { active = false; unsubscribe(); };
  }, [api, load, ready]);
  return ready && state?.loader === load ? { ...state, loading: false } : { loading: true, data: undefined, error: undefined };
}
