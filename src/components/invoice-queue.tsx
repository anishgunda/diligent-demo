'use client';

import { Activity, Building2, CircleCheck, Clock3, FileText, FlaskConical, Layers3, Play, Plus, Search, ShieldAlert, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { mode } from '@/lib/api';
import { useApi } from '@/lib/api-context';
import { day, errorText, gbp } from '@/lib/format';
import { invoiceStatus } from '@/lib/policy';
import type { InvoiceStatus } from '@/lib/types';
import { useData } from '@/lib/use-data';
import { Badge, Empty, ErrorBox, LinkButton, PageHeading, SelectWrap, Skeleton, Status } from './common';
import { Button } from './ui/button';
import { Card } from './ui/card';

const metrics = [
  { label: 'Total invoices', icon: Layers3, caption: 'Across all sources', tone: 'neutral' },
  { label: 'Awaiting investigation', icon: Clock3, caption: 'Ready for analyst review', tone: 'info' },
  { label: 'Held', icon: ShieldAlert, caption: 'Require independent verification', tone: 'warn' },
  { label: 'Cleared', icon: CircleCheck, caption: 'Fraud review complete', tone: 'good' },
] as const;
const filters: ('All statuses' | InvoiceStatus)[] = ['All statuses', 'Queued', 'Investigating', 'Held', 'Cleared', 'Rejected'];

export function InvoiceQueue() {
  const api = useApi();
  const { data: invoices, error, loading } = useData(api.listInvoices);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<(typeof filters)[number]>('All statuses');
  const [busy, setBusy] = useState('');
  const router = useRouter();
  const rows = invoices?.filter(invoice => (status === 'All statuses' || invoiceStatus(invoice) === status) && [invoice.invoiceNumber, invoice.supplierName, invoice.senderEmail].some(value => value.toLowerCase().includes(search.trim().toLowerCase()))) ?? [];
  const counts = [invoices?.length, ...(['Queued', 'Held', 'Cleared'] as const).map(item => invoices?.filter(invoice => invoiceStatus(invoice) === item).length)];

  async function demo(kind: 'erp' | 'fraud') {
    setBusy(kind);
    try {
      const invoice = await api.submitDemoInvoice(kind);
      setSearch('');
      setStatus('All statuses');
      toast.success(kind === 'fraud' ? 'Sample fraud case loaded.' : 'Invoice received from simulated ERP.');
      if (kind === 'fraud') router.push('/invoices/' + invoice.id);
    } catch (error) { toast.error(errorText(error)); }
    finally { setBusy(''); }
  }

  async function investigate(id: string) {
    setBusy(id);
    try {
      await api.startInvestigation({ invoiceId: id });
      router.push('/invoices/' + id);
    } catch (error) { toast.error(errorText(error)); }
    finally { setBusy(''); }
  }

  return <>
    <PageHeading eyebrow="Accounts payable" title="Invoices" description="Review incoming invoices and investigate supplier payment changes." actions={<>
      {mode === 'mock' && <Button variant="outline" disabled={loading || !!busy} onClick={() => void demo('erp')}><Plus size={17} />Simulate Incoming Invoice</Button>}
      <LinkButton href="/invoices/upload" primary><Upload size={17} />Upload Invoice</LinkButton>
    </>} />
    <div className="metric-grid">{metrics.map(({ label, icon: Icon, caption, tone }, index) => <Card className="metric" key={label}>
      <div className="metric-top"><span>{label}</span><span className={'metric-icon tone-' + tone}><Icon size={19} /></span></div>
      <strong aria-label={loading ? 'Loading count' : undefined}>{counts[index] ?? '—'}</strong><small>{caption}</small>
    </Card>)}</div>
    {mode === 'mock' && <div className="demo-strip"><div className="demo-icon"><FlaskConical size={21} /></div><div><strong>Explore a sample fraud case</strong><p>Investigate a changed payment destination from a known supplier.</p></div><Button variant="outline" disabled={loading || !!busy} onClick={() => void demo('fraud')}>Load Sample Fraud Case</Button></div>}
    <Card className="queue-card">
      <div className="section-toolbar"><div><h2>Invoice queue</h2><p className="muted">Track invoices from intake through fraud review.</p></div><div className="filters">
        <label className="search"><Search size={17} /><input aria-label="Search invoices" placeholder="Search invoices…" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <SelectWrap><select aria-label="Filter invoice status" value={status} onChange={event => setStatus(event.target.value as typeof status)}>{filters.map(filter => <option key={filter}>{filter}</option>)}</select></SelectWrap>
      </div></div>
      {loading ? <Skeleton label="Loading invoices" /> : error ? <ErrorBox message={error} /> : !rows.length ? <Empty title="No invoices found">Try another search or status.</Empty> :
        <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Supplier</th><th>Amount</th><th>Received</th><th>Source</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{rows.map(invoice => {
            const current = invoiceStatus(invoice);
            const href = '/invoices/' + invoice.id;
            return <tr key={invoice.id}><td><div className="cell-title"><span className="file-icon"><FileText size={16} /></span><div><Link href={href} className="text-link">{invoice.invoiceNumber}</Link><small>Due {day(invoice.dueDate)}</small></div></div></td><td>{invoice.supplierName}</td><td className="number">{gbp.format(invoice.amount)}</td><td className="number muted">{day(invoice.createdAt)}</td><td><span className="inline-icon">{invoice.source === 'ERP sync' ? <Building2 size={14} /> : <Upload size={14} />}{invoice.source}</span></td><td><Status value={current} /></td>
              <td><div className="row-actions"><Link href={href} className="text-link">View Invoice</Link>{current === 'Queued' && <Button variant="ghost" size="sm" aria-label={'Run Investigation for ' + invoice.invoiceNumber} disabled={!!busy} onClick={() => void investigate(invoice.id)}><Play size={14} />Run</Button>}
                {current === 'Investigating' && <Link href={href} className="text-link"><Activity size={14} />Resume</Link>}
                {invoice.investigation?.result && <Link href={'/reports/' + invoice.investigation.id} className="text-link">View Report</Link>}</div></td></tr>;
          })}</tbody></table></div>}
      {!loading && !error && <div className="table-footer"><span>{rows.length} of {invoices?.length ?? 0} invoices</span><Badge>GBP</Badge></div>}
    </Card>
  </>;
}
