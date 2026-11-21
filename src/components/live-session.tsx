'use client';

import { CreateOrganization, OrganizationList, useAuth, useOrganization, useUser } from '@clerk/nextjs';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { LiveContext } from '@/lib/api-context';
import { createHttpAdapter } from '@/lib/http-adapter';
import type { Identity } from '@/lib/types';
import { ErrorBox, Skeleton } from './common';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Shell } from './shell';

function sessionClaims(token: string) {
  const segment = token.split('.')[1];
  if (!segment) return null;
  try { return JSON.parse(atob(segment.replace(/-/g, '+').replace(/_/g, '/'))) as { o?: { id?: string }; sub?: string }; }
  catch { return null; }
}

export function LiveLayout({ children }: { children: ReactNode }) {
  const path = usePathname();
  if (/^\/(?:sign-in|sign-up)(?:\/|$)/.test(path)) return children;
  return <LiveSession>{children}</LiveSession>;
}

function LiveSession({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, orgId, userId } = useAuth({ treatPendingAsSignedOut: false });
  const { organization, isLoaded: organisationLoaded } = useOrganization();
  if (!isLoaded || !organisationLoaded) return <main className="main"><Skeleton /></main>;
  if (!isSignedIn || !userId) return <main className="main"><Link className="text-link" href="/sign-in">Sign in</Link></main>;
  if (!orgId || organization?.id !== orgId) return <Onboarding />;
  return <OrganisationSession key={userId + ':' + orgId} orgId={orgId} userId={userId} name={organization.name}>
    {children}
  </OrganisationSession>;
}

function Onboarding() {
  const [creating, setCreating] = useState(false);
  return <main className="main stack"><h1>Choose an organisation</h1>
    {creating ? <CreateOrganization afterCreateOrganizationUrl="/invoices" /> : <>
      <OrganizationList hidePersonal afterSelectOrganizationUrl="/invoices" afterCreateOrganizationUrl="/invoices" />
      <div><Button variant="outline" onClick={() => setCreating(true)}>Create an organisation</Button></div>
    </>}
  </main>;
}

function OrganisationSession({ orgId, userId, name, children }: { orgId: string; userId: string; name: string; children: ReactNode }) {
  const { getToken } = useAuth();
  const { user } = useUser();
  const [identity, setIdentity] = useState<Identity>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const token = useCallback(async () => {
    const value = await getToken();
    const claims = value ? sessionClaims(value) : null;
    if (!value || claims?.o?.id !== orgId || claims.sub !== userId) throw new Error('The active session changed. Retry from its workspace.');
    return value;
  }, [getToken, orgId, userId]);
  const api = useMemo(() => createHttpAdapter(process.env.NEXT_PUBLIC_API_URL ?? '', { token }), [token]);

  useEffect(() => {
    let current = true;
    const abort = new AbortController();
    void api.me(abort.signal).then(value => {
      if (!current) return;
      if (value.organisationId !== orgId) { setError('The API returned a different organisation.'); return; }
      setIdentity(value);
    }, reason => {
      if (current) setError(reason instanceof Error ? reason.message : 'Organisation access failed.');
    });
    return () => { current = false; abort.abort(); };
  }, [api, attempt, orgId]);

  if (error) return <main className="main"><Card className="panel stack"><ErrorBox message={error} />
    <Button variant="outline" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Retry organisation access</Button>
  </Card></main>;
  if (!identity) return <main className="main"><Skeleton /></main>;
  return <LiveContext.Provider value={{ api, identity: { ...identity, name: user?.fullName || identity.name, organisation: name } }}>
    <Shell>{children}</Shell>
  </LiveContext.Provider>;
}
