import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';
import { ClerkProvider } from '@clerk/nextjs';
import { LiveLayout } from '@/components/live-session';
import { mode } from '@/lib/api';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'IdentityTwin AI', template: '%s · IdentityTwin AI' },
  description: 'Supplier invoice investigation and payment integrity workspace.',
};

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en-GB"><body>{mode === 'mock' ? <Shell>{children}</Shell> :
    !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY ?
      <main className="main" role="alert">Live mode requires Clerk configuration.</main> :
      <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up" afterSignOutUrl="/sign-in">
        <LiveLayout>{children}</LiveLayout>
      </ClerkProvider>}</body></html>;
}
