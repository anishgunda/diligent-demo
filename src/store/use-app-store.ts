import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { seedData } from '@/lib/mock-data';
import type { Role } from '@/lib/types';

type Store = ReturnType<typeof seedData> & { role: Role };

export const useAppStore = create<Store>()(persist<Store, [], [], Omit<Store, 'revision'>>(
  () => ({ ...seedData(), role: 'AP_ANALYST' }),
  {
    name: 'identitytwin-demo-v1',
    storage: createJSONStorage(() => window.localStorage),
    skipHydration: true,
    partialize: ({ invoices, suppliers, serial, role }) => ({ invoices, suppliers, serial, role }),
  },
));
