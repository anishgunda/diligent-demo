import type { AuthAdapter, Identity, Role } from './types';

export const personas: Record<Role, Identity> = {
  AP_ANALYST: { name: 'Alex Morgan', role: 'AP_ANALYST', organisation: 'Northstar Finance' },
  FINANCE_CONTROLLER: { name: 'Samira Patel', role: 'FINANCE_CONTROLLER', organisation: 'Northstar Finance' },
};

export function demoAuth(getRole: () => Role, subscribe: AuthAdapter['subscribe']): AuthAdapter {
  return { identity: () => personas[getRole()], token: async () => undefined, subscribe };
}

export function canVerify(role: Role) {
  return role === 'FINANCE_CONTROLLER';
}
