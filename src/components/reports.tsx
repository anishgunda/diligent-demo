'use client';

import { ChevronLeft, Download, FileBarChart2, FileText, Fingerprint, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useApi } from '@/lib/api-context';
import { clock, day, gbp, verdictLabel } from '@/lib/format';
import { paymentLabel } from '@/lib/payment';
import type { Report } from '@/lib/types';
import { useData } from '@/lib/use-data';
import { Badge, Empty, ErrorBox, LinkButton, PageHeading, Skeleton, VerdictBadge } from './common';
import { Button } from './ui/button';
import { Card } from './ui/card';

function download(report: Report) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'identitytwin-' + report.id.replace(/[^a-z0-9-]/gi, '') + '.json';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast.success('Audit report exported.');
}

export function Reports({ id }: { id?: string }) {
  const api = useApi();
  const { data, loading, error } = useData(api.listReports);
  const report = data?.find(item => item.id === id);
  if (id) return <>
    <Link href="/reports" className="breadcrumb"><ChevronLeft size={16} />Reports</Link>
    {loading ? <Skeleton label="Loading audit report" /> : error ? <ErrorBox message={error} /> : report ? <ReportDetail report={report} /> : <Card><Empty title="Report unavailable">Complete the invoice investigation to create a report.</Empty></Card>}
  </>;
  return <>
    <PageHeading eyebrow="Accounts payable" title="Reports" description="Review investigation evidence, verification records and fraud dispositions." />
    <Card>
      <div className="section-toolbar"><div><h2>Audit reports</h2><p className="muted">Created when an investigation completes.</p></div><Badge>{data?.length ?? '—'} reports</Badge></div>
      {loading ? <Skeleton label="Loading reports" /> : error ? <ErrorBox message={error} /> : !data?.length ? <Empty title="No audit reports yet"><Link href="/invoices" className="text-link">Open invoice queue</Link></Empty> :
        <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Supplier</th><th>Amount</th><th>Disposition</th><th>Updated</th><th>Actions</th></tr></thead>
          <tbody>{data.map(item => <tr key={item.id}><td><div className="inline-icon"><FileText size={17} /><Link className="text-link" href={'/reports/' + item.id}>{item.invoice.invoiceNumber}</Link></div></td><td>{item.invoice.supplierName}</td><td className="number">{gbp.format(item.invoice.amount)}</td><td><VerdictBadge verdict={item.policy.verdict} /></td><td className="number">{day(item.createdAt)}</td><td><div className="row-actions"><Link className="text-link" href={'/reports/' + item.id}>View report</Link><Button variant="ghost" size="sm" onClick={() => download(item)}><Download size={15} />Export JSON</Button></div></td></tr>)}</tbody>
        </table></div>}
    </Card>
  </>;
}

function ReportDetail({ report }: { report: Report }) {
  const { invoice, baseline, policy, evidence, verification } = report;
  return <>
    <PageHeading eyebrow="Audit report" title={invoice.invoiceNumber} description={invoice.supplierName + ' · Updated ' + day(report.createdAt)} actions={<>
      <LinkButton href={'/invoices/' + report.invoiceId}><FileBarChart2 size={16} />View Investigation</LinkButton>
      <Button onClick={() => download(report)}><Download size={16} />Export JSON</Button>
    </>} />
    <div className="report-grid">
      <Card className="panel full"><div className="section-line"><h2 className="inline-icon"><ShieldCheck size={18} />Executive summary</h2><VerdictBadge verdict={policy.verdict} /></div><p>{policy.summary}</p><dl className="metadata"><div><dt>Final disposition</dt><dd>{verdictLabel[policy.verdict]}</dd></div>{report.executionMode && <div><dt>Execution</dt><dd>{report.executionMode === 'RULES_ONLY' ? 'Rules only' : report.model ?? 'Agent investigation'}</dd></div>}<div><dt>Next action</dt><dd>{policy.nextAction}</dd></div><div><dt>Payment authorisation</dt><dd>Outside this workflow</dd></div></dl></Card>
      <Card className="panel"><h2 className="inline-icon"><FileText size={18} />Invoice metadata</h2><dl className="metadata"><div><dt>Company number</dt><dd>{invoice.companyNumber || '—'}</dd></div><div><dt>Invoice amount</dt><dd>{gbp.format(invoice.amount)}</dd></div><div><dt>Invoice date</dt><dd>{day(invoice.invoiceDate)}</dd></div><div><dt>Due date</dt><dd>{day(invoice.dueDate)}</dd></div><div><dt>Sender email</dt><dd>{invoice.senderEmail || '—'}</dd></div><div><dt>Claimed signer</dt><dd>{invoice.signer || '—'}</dd></div><div><dt>Payment destination</dt><dd>{paymentLabel(invoice.payment)}</dd></div><div><dt>Payment reference</dt><dd>{invoice.paymentReference || '—'}</dd></div><div><dt>Intake source</dt><dd>{invoice.source}</dd></div></dl></Card>
      <Card className="panel"><h2 className="inline-icon"><Fingerprint size={18} />Supplier baseline snapshot</h2>{baseline ? <dl className="metadata"><div><dt>Supplier</dt><dd>{baseline.name}</dd></div><div><dt>Company number</dt><dd>{baseline.companyNumber}</dd></div><div><dt>Trusted domain</dt><dd>{baseline.domain || '—'}</dd></div><div><dt>Signer</dt><dd>{baseline.signer || '—'}</dd></div><div><dt>Payment destination</dt><dd>{paymentLabel(baseline.payment)}</dd></div><div><dt>Provenance</dt><dd>{baseline.trustedSource ?? 'Unverified directory entry'}</dd></div><div><dt>Verified</dt><dd>{baseline.verifiedAt ? day(baseline.verifiedAt) : 'Pending'}</dd></div></dl> : <Empty title="No supplier baseline recorded" />}</Card>
      <Card className="panel"><h2>Policy evaluation</h2><ul className="report-checks">{policy.checks.map(item => <li key={item.label}><div className="section-line"><strong>{item.label}</strong><Badge tone={item.state === 'pass' ? 'good' : item.state === 'flag' ? 'warn' : 'neutral'}>{item.state === 'pass' ? 'Pass' : item.state === 'flag' ? 'Flag' : 'Unknown'}</Badge></div><p className="muted">{item.detail}</p></li>)}</ul>{!!policy.missing.length && <div className="callout tone-warn">Requires verification · {policy.missing.join(', ')}</div>}</Card>
      <Card className="panel"><h2>Verification log</h2>{verification.length ? <ul className="verification-log report-checks">{verification.map((entry, index) => <li key={index}><strong>{entry.reviewer}</strong><small>{day(entry.timestamp)} · {clock(entry.timestamp)} · {entry.method}</small><p>{entry.outcome.toLowerCase().replaceAll('_', ' ')} · {entry.notes}</p></li>)}</ul> : <Empty title="No independent verification logged" />}</Card>
      <Card className="panel full"><h2>Agent evidence</h2><ul className="report-checks evidence-list">{evidence.map(event => <li key={event.id}><div className="section-line"><strong>{event.tool ?? event.type}</strong><span className="muted">{clock(event.timestamp)}</span></div><p>{event.finding}</p><small className="muted">{event.source} · {event.mode === 'mock' ? 'Simulated' : 'Live'} · {event.status}{event.latencyMs === undefined ? '' : ' · ' + event.latencyMs + ' ms'}</small>{Object.keys(event.payload).length > 0 && <details><summary className="text-link">Evidence JSON</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details>}</li>)}</ul></Card>
    </div>
  </>;
}
