'use client';

import { Activity, Bell, ChartNoAxesCombined, ChevronDown, CircleHelp, FileBarChart2, Files, FlaskConical, Landmark, Radio, RotateCcw, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Toaster, toast } from 'sonner';
import { OrganizationSwitcher, UserButton } from '@clerk/nextjs';
import { mode, switchDemoRole } from '@/lib/api';
import { useApi } from '@/lib/api-context';
import { invoiceStatus } from '@/lib/policy';
import type { Role } from '@/lib/types';
import { useData, useHydrated, useIdentity } from '@/lib/use-data';
import { useAppStore } from '@/store/use-app-store';
import { Button } from './ui/button';
import { Badge } from './common';

const nav = [
  { title: 'Invoices', href: '/invoices', icon: Files },
  { title: 'Reports', href: '/reports', icon: FileBarChart2 },
  { title: 'Suppliers', href: '/suppliers', icon: Landmark },
  { title: 'Evals', href: '/evals', icon: ChartNoAxesCombined },
];

export function Shell({ children }: { children: ReactNode }) {
  const api = useApi();
  const pathname = usePathname();
  const router = useRouter();
  const ready = useHydrated();
  const identity = useIdentity();
  const { data } = useData(api.listInvoices);
  const held = data?.filter(invoice => invoiceStatus(invoice) === 'Held') ?? [];
  const dialog = useRef<HTMLDialogElement>(null);
  const [resetting, setResetting] = useState(false);
  useEffect(() => { if (mode === 'mock') void useAppStore.persist?.rehydrate(); }, []);

  async function reset() {
    setResetting(true);
    try {
      await api.reset();
      dialog.current?.close();
      router.push('/invoices');
      toast.success('Demo data reset.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Reset failed.');
    } finally {
      setResetting(false);
    }
  }

  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="topbar"><div className="topbar-inner">
      <Link href="/invoices" className="brand"><span className="logo"><ShieldCheck size={21} strokeWidth={2.2} /></span><span>IdentityTwin <b>AI</b><small>PAYMENT INTEGRITY</small></span></Link>
      <nav aria-label="Main navigation">{nav.map(({ title, href, icon: Icon }) => <Link key={href} href={href} aria-current={pathname.startsWith(href) ? 'page' : undefined}><Icon size={17} />{title}</Link>)}</nav>
      <div className="header-tools">
        <span className="sync"><Activity size={15} /><span>{mode === 'mock' ? 'ERP Sync Active' : 'Live API configured'}<small>{mode === 'mock' ? 'Simulated' : 'ERP status unavailable'}</small></span></span>
        <details className="popup"><summary className="icon-control" aria-label="Notifications"><Bell size={18} />{held.length > 0 && <i />}</summary><div className="popup-panel"><strong>Notifications</strong>{held.length ? held.map(invoice => <Link onClick={event => event.currentTarget.closest('details')?.removeAttribute('open')} key={invoice.id} href={'/invoices/' + invoice.id}>{invoice.invoiceNumber} needs verification</Link>) : <p className="muted">No cases awaiting independent verification.</p>}</div></details>
        {mode === 'live' ? <><OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/invoices" afterCreateOrganizationUrl="/invoices" /><UserButton /></> :
          identity ? <label className="persona"><span className="avatar">{identity.name.split(' ').map(name => name[0]).join('')}</span><span className="persona-text"><b>{identity.name}</b><span>{identity.role === 'AP_ANALYST' ? 'AP Analyst' : 'Finance Controller'}</span></span><ChevronDown size={14} /><select aria-label="Demo role" value={identity.role} onChange={event => { switchDemoRole(event.target.value as Role); toast.info('Demo persona switched.'); }}><option value="AP_ANALYST">AP Analyst</option><option value="FINANCE_CONTROLLER">Finance Controller</option></select></label> : <span className="avatar avatar-placeholder" aria-label="Loading persona" />}
      </div>
    </div></header>
    <div className="utility"><div className="utility-inner">
      <div className="utility-context"><Landmark size={15} /><span>{mode === 'mock' ? 'Northstar Finance' : identity?.organisation}</span><span className="utility-slash">/</span><span className="muted">Accounts payable</span></div>
      <div className="utility-tools">
        <details className="popup"><summary className="mode-control"><Radio size={14} />{mode === 'mock' ? 'Mock Demo' : 'Live API'}<ChevronDown size={13} /></summary><div className="popup-panel"><strong>Environment</strong><p><Badge tone="good">{mode === 'mock' ? 'Mock Demo' : 'Live API'}</Badge></p><p className="muted"><CircleHelp size={15} /> {mode === 'mock' ? 'This workspace uses synthetic data and simulated tools.' : identity?.role === 'FINANCE_CONTROLLER' ? 'Finance Controller' : 'AP Analyst'}</p></div></details>
        {mode === 'mock' && <Button size="sm" variant="ghost" disabled={!ready} onClick={() => dialog.current?.showModal()}><RotateCcw size={14} />Reset Demo Data</Button>}
      </div>
    </div></div>
    <main id="main" className="main">{children}</main>
    <footer className="footer"><span><ShieldCheck size={15} />IdentityTwin AI</span><span><FlaskConical size={14} />{mode === 'mock' ? 'Demo workspace' : 'Live workspace'} · v0.1.0</span></footer>
    <dialog ref={dialog} className="dialog"><h2>Reset demo data?</h2><p className="muted">This removes invoices, verifications and supplier changes created in this browser and restores the original sample records.</p><div className="actions"><Button variant="outline" onClick={() => dialog.current?.close()}>Cancel</Button><Button onClick={reset} disabled={resetting}>Reset Demo Data</Button></div></dialog>
    <Toaster position="bottom-right" richColors closeButton />
  </>;
}
