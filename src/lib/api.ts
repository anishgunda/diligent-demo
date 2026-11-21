import { useAppStore } from '@/store/use-app-store';
import { createMockAdapter } from './mock-adapter';
import { demoAuth } from './permissions';
import type { Role } from './types';

export const mode = process.env.NEXT_PUBLIC_API_MODE === 'live' ? 'live' : 'mock';
export const auth = demoAuth(() => useAppStore.getState().role, useAppStore.subscribe);
export function switchDemoRole(role: Role) {
  useAppStore.setState({ role });
}
export const mockApi = createMockAdapter(auth);
