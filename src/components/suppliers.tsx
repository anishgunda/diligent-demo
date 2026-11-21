'use client';

import { ChevronLeft, Landmark, Pencil, Plus, Search, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { mode } from '@/lib/api';
import { useApi } from '@/lib/api-context';
import { day, errorText, gbp } from '@/lib/format';
import { paymentLabel } from '@/lib/payment';
import { invoiceStatus, matchSupplier } from '@/lib/policy';
import type { Invoice, Payment, PaymentId, Supplier, VerificationInput } from '@/lib/types';
import { useData, useIdentity } from '@/lib/use-data';
import { Badge, Empty, ErrorBox, LoadingIcon, PageHeading, SelectWrap, Skeleton, Status } from './common';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { PaymentIntake } from './payment-intake';

export function Suppliers({ id }: { id?: string }) {
  const api = useApi();
  const { data, loading, error } = useData(api.listSuppliers);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [adding, setAdding] = useState(false);
  const [liveSupplier, setLiveSupplier] = useState<Supplier>();
  const router = useRouter();
  const supplier = liveSupplier?.id === id && liveSupplier ? liveSupplier : data?.find(item => item.id === id);
  const rows = data?.filter(item => (filter === 'all' || Boolean(item.verifiedAt) === (filter === 'verified')) && [item.name, item.domain, item.companyNumber].some(field => field.toLowerCase().includes(search.trim().toLowerCase()))) ?? [];
  if (id) return <>
    <Link className="breadcrumb" href="/suppliers"><ChevronLeft size={16} />Supplier directory</Link>
    {loading ? <Skeleton label="Loading supplier" /> : error ? <ErrorBox message={error} /> : supplier ? <SupplierDetail key={supplier.id} supplier={supplier} onSaved={item => { if (mode === 'live') setLiveSupplier(item); }} /> : <Card><Empty title="Supplier unavailable" /></Card>}
  </>;
  return <>
    <PageHeading eyebrow="Accounts payable" title="Suppliers" description="Maintain supplier records and review verified payment destinations." actions={<Button disabled={loading} onClick={() => setAdding(true)}><Plus size={17} />Add Supplier</Button>} />
    <Card className="directory-table">
      <div className="section-toolbar"><div><h2>Supplier directory</h2><p className="muted">{data?.length ?? '—'} supplier records</p></div><div className="filters">
        <label className="search"><Search size={17} /><input aria-label="Search suppliers" placeholder="Search suppliers…" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <SelectWrap><select aria-label="Filter supplier verification" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All suppliers</option><option value="verified">Verified</option><option value="unverified">Unverified</option></select></SelectWrap>
      </div></div>
      {loading ? <Skeleton label="Loading suppliers" /> : error ? <ErrorBox message={error} /> : !rows.length ? <Empty title="No suppliers found">Adjust your search or add a supplier.</Empty> : <div className="table-scroll"><table><thead><tr><th>Supplier</th><th>Company number</th><th>Trusted domain</th><th>Payment destination</th><th>Baseline</th><th>Actions</th></tr></thead><tbody>{rows.map(item => <tr key={item.id}><td><span className="inline-icon"><Landmark size={16} />{item.name}</span></td><td className="number">{item.companyNumber}</td><td>{item.domain || '—'}</td><td className="number">{paymentLabel(item.payment)}</td><td><Badge tone={item.verifiedAt ? 'good' : 'neutral'} dot>{item.verifiedAt ? 'Verified' : 'Unverified'}</Badge></td><td><Link href={'/suppliers/' + item.id} className="text-link">View supplier</Link></td></tr>)}</tbody></table></div>}
    </Card>
    {adding && <SupplierEditor close={() => setAdding(false)} saved={item => { setAdding(false); router.push('/suppliers/' + item.id); }} />}
  </>;
}

function SupplierEditor({ supplier, close, saved }: { supplier?: Supplier; close: () => void; saved: (supplier: Supplier) => void }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const show = useRef<HTMLDialogElement>(null);
  return <dialog className="dialog supplier-dialog" ref={dialog => { show.current = dialog; if (dialog && !dialog.open) dialog.showModal(); }} onClose={close} aria-labelledby="supplier-dialog-title">
    <h2 id="supplier-dialog-title">{supplier ? 'Edit supplier' : 'Add supplier'}</h2>
    {supplier?.verifiedAt && <p className="muted">Verified identity fields are locked to the onboarding record. You can edit the directory name.</p>}
    <form className="form-stack" onSubmit={async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setBusy(true);
      setError('');
      try {
        const item = await api.saveSupplier({ name: String(form.get('name')), companyNumber: String(form.get('companyNumber')), domain: String(form.get('domain')), signer: String(form.get('signer')) }, supplier?.id);
        toast.success(supplier ? 'Supplier updated.' : 'Supplier added.');
        saved(item);
      } catch (reason) { setError(errorText(reason)); }
      finally { setBusy(false); }
    }}>
      <label>Supplier name<input name="name" defaultValue={supplier?.name} required maxLength={100} /></label>
      <label>Companies House number<input name="companyNumber" defaultValue={supplier?.companyNumber} readOnly={!!supplier?.verifiedAt} required pattern="[A-Za-z0-9]{8}" title="Eight letters or digits" /></label>
      <label>Sender domain<input name="domain" defaultValue={supplier?.domain} readOnly={!!supplier?.verifiedAt} placeholder="supplier.example" maxLength={160} /></label>
      <label>Expected signer<input name="signer" defaultValue={supplier?.signer} readOnly={!!supplier?.verifiedAt} maxLength={80} /></label>
      {error && <ErrorBox message={error} />}
      <div className="actions"><Button variant="outline" onClick={() => show.current?.close()}>Cancel</Button><Button type="submit" disabled={busy}>{busy && <LoadingIcon />}Save Supplier</Button></div>
    </form>
  </dialog>;
}

function SupplierDetail({ supplier, onSaved }: { supplier: Supplier; onSaved: (item: Supplier) => void }) {
  const api = useApi();
  const identity = useIdentity();
  const { data: invoices, loading, error } = useData(api.listInvoices);
  const loadPaymentOptions = useCallback(() => api.listPaymentOptions(supplier.id), [api, supplier.id]);
  const options = useData(loadPaymentOptions);
  const [editing, setEditing] = useState(false);
  const [paymentId, setPaymentId] = useState<PaymentId | ''>('');
  const [busy, setBusy] = useState(false);
  const [proposalError, setProposalError] = useState('');
  const [captured, setCaptured] = useState<Payment>();
  const associated = invoices?.filter(invoice => invoice.supplierId === supplier.id || (!invoice.supplierId && !!matchSupplier(invoice, [supplier]))) ?? [];
  const choices = [...new Map([...(options.data ?? []), ...(captured ? [captured] : [])].map(payment => [payment.id, payment])).values()]
    .filter(payment => supplier.payment?.fingerprint !== payment.fingerprint && !supplier.changes.some(change =>
      change.status === 'Pending independent verification' && change.proposed.fingerprint === payment.fingerprint));
  return <>
    <PageHeading eyebrow="Supplier profile" title={supplier.name} description={'Company number ' + supplier.companyNumber} actions={<>
      <Badge tone={supplier.verifiedAt ? 'good' : 'warn'} dot>{supplier.verifiedAt ? 'Verified baseline' : 'Verification pending'}</Badge>
      <Button variant="outline" onClick={() => setEditing(true)}><Pencil size={16} />Edit Supplier</Button>
    </>} />
    <div className="split">
      <div className="stack">
        <Card className="panel"><h2 className="inline-icon"><ShieldCheck size={18} />Supplier baseline</h2><dl className="metadata">
          <div><dt>Sender domain</dt><dd>{supplier.domain || '—'}</dd></div><div><dt>Expected signer</dt><dd>{supplier.signer || '—'}</dd></div><div><dt>Payment destination</dt><dd>{paymentLabel(supplier.payment)}</dd></div>
          <div><dt>Trusted source</dt><dd>{supplier.trustedSource ?? 'Awaiting onboarding evidence'}</dd></div><div><dt>Verified on</dt><dd>{supplier.verifiedAt ? day(supplier.verifiedAt) : 'Pending'}</dd></div>
        </dl></Card>
        <Card className="panel"><h2>Associated invoices</h2>{loading ? <Skeleton label="Loading associated invoices" /> : error ? <ErrorBox message={error} /> : associated.length ? <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Amount</th><th>Status</th></tr></thead><tbody>{associated.map((item: Invoice) => <tr key={item.id}><td><Link className="text-link" href={'/invoices/' + item.id}>{item.invoiceNumber}</Link></td><td className="number">{gbp.format(item.amount)}</td><td><Status value={invoiceStatus(item)} /></td></tr>)}</tbody></table></div> : <Empty title="No associated invoices" />}</Card>
      </div>
      <Card className="panel"><h2>Bank-account change history</h2>
        {supplier.changes.length ? <ul className="report-checks">{supplier.changes.map(change => <li key={change.id}><div className="section-line"><strong>{paymentLabel(change.proposed)}</strong><Badge tone={change.status === 'Verified' ? 'good' : change.status === 'Superseded' ? 'neutral' : 'warn'}>{change.status === 'Pending independent verification' ? 'Pending' : change.status}</Badge></div><p className="muted">Previous · {paymentLabel(change.previous)}</p><small className="muted">{change.reviewer} · {day(change.proposedAt)} · {change.status}{change.approvedBy && ' · Approved by ' + change.approvedBy}</small>
          {mode === 'live' && change.status === 'Pending independent verification' && identity?.role === 'FINANCE_CONTROLLER' && identity.userId !== change.reviewer &&
            <ApproveBaseline supplierId={supplier.id} proposalId={change.id} onSaved={onSaved} />}
        </li>)}</ul> : <p className="muted">No bank-account change proposals.</p>}
        <h3 className="subheading">Propose payment change</h3>
        <p className="muted">Changes require independent verification before they can become the trusted destination.</p>
        {mode === 'live' && <PaymentIntake onSaved={payment => { setCaptured(payment); setPaymentId(payment.id); }} />}
        <form className="form-stack" onSubmit={async event => {
          event.preventDefault();
          if (!paymentId) return;
          setBusy(true);
          setProposalError('');
          try {
            onSaved(await api.proposePayment(supplier.id, paymentId));
            setPaymentId('');
            toast.success('Payment change recorded for independent verification.');
          } catch (reason) { setProposalError(errorText(reason)); }
          finally { setBusy(false); }
        }}>
          <label>{mode === 'mock' ? 'Synthetic payment destination' : 'Payment destination'}<SelectWrap><select value={paymentId} required onChange={event => setPaymentId(event.target.value)}><option value="" disabled>{options.loading ? 'Loading destinations…' : choices.length ? 'Choose a destination' : 'No remaining destinations'}</option>{choices.map(payment => <option key={payment.id} value={payment.id}>{mode === 'mock' ? payment.id + ' · ' : ''}{payment.account}</option>)}</select></SelectWrap></label>
          {options.error && <ErrorBox message={options.error} />}
          {proposalError && <ErrorBox message={proposalError} />}
          <div className="actions"><Button type="submit" disabled={!paymentId || busy}>{busy && <LoadingIcon />}Propose Change</Button></div>
        </form>
      </Card>
    </div>
    {editing && <SupplierEditor supplier={supplier} close={() => setEditing(false)} saved={item => { onSaved(item); setEditing(false); }} />}
  </>;
}

function ApproveBaseline({ supplierId, proposalId, onSaved }: { supplierId: string; proposalId: string; onSaved: (item: Supplier) => void }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <details className="review-block"><summary className="text-link">Verify payment proposal</summary>
    <form className="form-stack" onSubmit={async event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      setBusy(true);
      setError('');
      try {
        onSaved(await api.approvePayment(supplierId, proposalId, {
          method: data.get('method') as VerificationInput['method'], outcome: 'CONFIRMED_LEGITIMATE',
          trustedContactSource: String(data.get('source')), notes: String(data.get('notes')),
        }));
        toast.success('Supplier baseline independently verified.');
      } catch (reason) { setError(errorText(reason)); }
      finally { setBusy(false); }
    }}>
      <label>Verification method<SelectWrap><select name="method"><option>Known supplier phone</option><option>Existing supplier portal</option><option>Signed supplier confirmation</option></select></SelectWrap></label>
      <label>Trusted contact source<input name="source" required minLength={3} maxLength={160} /></label>
      <label>Verification notes<textarea name="notes" required minLength={5} maxLength={1000} /></label>
      {error && <ErrorBox message={error} />}
      <Button type="submit" disabled={busy}>Approve verified baseline</Button>
    </form>
  </details>;
}
