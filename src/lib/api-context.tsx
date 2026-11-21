'use client';

import { createContext, useContext } from 'react';
import { mockApi, mode } from './api';
import type { Identity, IdentityTwinApi } from './types';

export const LiveContext = createContext<{ api: IdentityTwinApi; identity: Identity } | null>(null);

export function useApi() {
  const live = useContext(LiveContext);
  if (mode === 'mock') return mockApi;
  if (!live) throw new Error('A live organisation session is required.');
  return live.api;
}

export function useLiveIdentity() {
  return useContext(LiveContext)?.identity ?? null;
}
