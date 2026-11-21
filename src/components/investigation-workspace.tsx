'use client';

import { Activity, AlertTriangle, Building2, ChevronLeft, CircleCheck, Clock3, FileBarChart2, FileText, Fingerprint, LockKeyhole, Play, Radio, ShieldAlert, ShieldCheck, Terminal } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { mode } from '@/lib/api';
import { useApi } from '@/lib/api-context';
import { clock, day, errorText, gbp, verdictLabel } from '@/lib/format';
import { canVerify } from '@/lib/permissions';
import { compare, invoiceStatus, matchSupplier } from '@/lib/policy';
import type { Investigation, Invoice, Supplier, VerificationInput } from '@/lib/types';
import { useData, useIdentity } from '@/lib/use-data';
import { Badge, Empty, ErrorBox, LinkButton, LoadingIcon, PageHeading, SelectWrap, Skeleton, Status, verdictTone } from './common';
import { Button } from './ui/button';
import { Card } from './ui/card';

export function InvestigationWorkspace({ id }: { id: string }) {
  const api = useApi();
  const load = useCallback(() => api.getInvoice(id), [api, id]);
  const { data, error, loading } = useData(load);
  const { data: suppliers } = useData(api.listSuppliers);
  const [liveInvoice, setLiveInvoice] = useState<Invoice>();
  const invoice = liveInvoice ?? data;
  const identity = useIdentity();
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState('');
  const investigation = invoice?.investigation;
  const refreshLive = useCallback(async () => {
    if (mode === 'live') setLiveInvoice(await load());
  }, [load]);

  async function start() {
    setStarting(true);
    setActionError('');
    try { await api.startInvestigation({ invoiceId: id }); await refreshLive(); }
    catch (reason) { setActionError(errorText(reason)); }
    finally { setStarting(false); }
  }

  async function saveDocument() {
    try {
      const url = URL.createObjectURL(await api.getDocument(id));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'invoice.pdf';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setActionError(errorText(reason)); }
  }

  return <>
    <Link href="/invoices" className="breadcrumb"><ChevronLeft size={16} />Invoice queue</Link>
    {loading ? <Skeleton label="Loading investigation" /> : error ? <ErrorBox message={error} /> : !invoice ? <Card><Empty title="Invoice unavailable"><Link href="/invoices" className="text-link">Return to invoices</Link></Empty></Card> : <>
      <PageHeading eyebrow="Investigation workspace" title={invoice.invoiceNumber} description={invoice.supplierName + ' · Received ' + day(invoice.createdAt)} actions={<>
        <Status value={invoiceStatus(invoice)} />
        {invoice.hasDocument && <Button variant="outline" onClick={() => void saveDocument()}><FileText size={16} />Download PDF</Button>}
        {investigation?.result ? <LinkButton href={'/reports/' + investigation.id}><FileBarChart2 size={17} />View Audit Report</LinkButton> :
          <Button disabled={starting || investigation?.phase === 'running'} onClick={() => void start()}>{starting || investigation?.phase === 'running' ? <LoadingIcon /> : <Play size={16} />}{investigation?.phase === 'running' ? 'Investigation running' : 'Run Investigation'}</Button>}
      </>} />
      {actionError && <ErrorBox message={actionError} />}
      <div className="case-bar">
        <div><FileText size={17} /><span><small>Invoice amount</small><strong>{gbp.format(invoice.amount)}</strong></span></div>
        <div><Clock3 size={17} /><span><small>Payment due</small><strong>{day(invoice.dueDate)}</strong></span></div>
        <div><Building2 size={17} /><span><small>Intake source</small><strong>{invoice.source}</strong></span></div>
        <div><LockKeyhole size={17} /><span><small>Payment authorisation</small><strong>Outside this workflow</strong></span></div>
      </div>
      <div className="workspace">
        <Baseline invoice={invoice} baseline={investigation ? investigation.baseline : matchSupplier(invoice, suppliers ?? [])} />
        <Trace key={investigation?.id ?? 'idle'} investigation={investigation} onComplete={refreshLive} />
        <VerdictPanel invoice={invoice} allowed={identity !== null && canVerify(identity.role)} onVerify={refreshLive} reviewer={identity?.name ?? ''} />
      </div>
    </>}
  </>;
}

function Baseline({ invoice, baseline }: { invoice: Invoice; baseline?: Supplier }) {
  return <Card className="panel workspace-panel">
    <div className="panel-heading"><span className="panel-icon"><Fingerprint size={19} /></span><div><h2>Supplier baseline</h2><p>Invoice claims vs trusted record</p></div></div>
    <div className="baseline-box"><div className="section-line"><strong>{baseline?.name ?? 'Supplier record unavailable'}</strong><Badge tone={baseline?.verifiedAt ? 'good' : 'warn'}>{baseline?.verifiedAt ? 'Verified' : 'Unverified'}</Badge></div><p>{baseline?.trustedSource ?? 'No independent onboarding evidence'}</p>{baseline?.verifiedAt && <small>Verified {day(baseline.verifiedAt)}</small>}</div>
    <dl className="compare-list">{compare(invoice, baseline).map(field => <div key={field.field}><dt>{field.field}<Status value={field.status} /></dt><dd><span><small>Invoice claim</small>{field.incoming}</span><span><small>Trusted value</small>{field.trusted}</span></dd></div>)}</dl>
    <dl className="metadata"><div><dt>Sender</dt><dd>{invoice.senderEmail || '—'}</dd></div><div><dt>Invoice date</dt><dd>{day(invoice.invoiceDate)}</dd></div><div><dt>Payment reference</dt><dd>{invoice.paymentReference || '—'}</dd></div></dl>
  </Card>;
}

function Trace({ investigation, onComplete }: { investigation?: Investigation; onComplete: () => Promise<void> }) {
  const api = useApi();
  const [events, setEvents] = useState(investigation?.events ?? []);
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);
  const cursor = useRef(investigation?.events.at(-1)?.sequence ?? 0);
  const id = investigation?.id;
  const running = investigation?.phase === 'running';

  useEffect(() => {
    if (!id || !running) return;
    const controller = new AbortController();
    async function stream(caseId: string) {
      try {
        for await (const event of api.events(caseId, { after: cursor.current, signal: controller.signal })) {
          if (controller.signal.aborted) return;
          cursor.current = event.sequence;
          setEvents(previous => [...previous, event]);
          if (event.type === 'error' || event.type === 'investigation_failed') {
            setFailure(event.finding);
            await onComplete();
            return;
          }
          if (event.type === 'completed' || event.type === 'investigation_completed') {
            await onComplete();
            return;
          }
        }
        if (!controller.signal.aborted) {
          await onComplete();
          if (mode === 'live') setFailure('The event stream ended. Reconnect to check for remaining evidence.');
        }
      } catch (reason) {
        if (!controller.signal.aborted) setFailure(errorText(reason));
      }
    }
    void stream(id);
    return () => controller.abort();
  }, [api, id, running, attempt, onComplete]);

  const combined = new Map([...(investigation?.events ?? []), ...events].map(event => [event.sequence, event]));
  const timeline = Array.from(combined.values()).sort((a, b) => a.sequence - b.sequence);

  return <Card className="panel workspace-panel">
    <div className="panel-heading"><span className="panel-icon"><Activity size={19} /></span><div><h2>Agent investigation</h2><p>Evidence and tool activity</p></div><Badge tone={running ? 'info' : 'neutral'} dot>{mode === 'mock' ? 'Simulated' : investigation?.executionMode === 'RULES_ONLY' ? 'Rules only' : 'Live'}</Badge></div>
    {investigation?.executionMode === 'RULES_ONLY' && <div className="callout tone-warn">AI investigation is currently unavailable. Mandatory supplier and payment checks were performed using deterministic rules.</div>}
    {running && !failure && <div role="status" className="trace-state"><Radio size={16} /><span>Streaming evidence</span></div>}
    {failure && running && <div className="stack"><ErrorBox message={failure} /><Button variant="outline" size="sm" onClick={() => { setFailure(''); setAttempt(previous => previous + 1); }}>Reconnect stream</Button></div>}
    {investigation?.phase === 'error' && <ErrorBox message={failure || investigation.events.at(-1)?.finding || 'The investigation stopped with an error. Run it again to retry.'} />}
    {!timeline.length ? <Empty title={running ? 'Connecting to evidence stream' : 'No evidence collected'}>{running ? 'Tool activity will appear here.' : 'Run the investigation to gather evidence.'}</Empty> :
      <ol className="timeline" aria-label="Investigation timeline">{timeline.map(event => <li key={event.id}>
        <span className={'timeline-dot ' + (event.status === 'running' ? 'tone-info' : event.status === 'error' ? 'tone-bad' : 'tone-good')}>{event.status === 'running' ? <Radio size={13} /> : event.status === 'error' ? <AlertTriangle size={13} /> : <CheckIcon />}</span>
        <div className="trace-content"><div className="section-line"><strong>{event.tool ? event.tool.replaceAll('_', ' ') : event.type === 'completed' ? 'Investigation complete' : event.type === 'error' ? 'Stream error' : event.type.replaceAll('_', ' ')}</strong><time dateTime={event.timestamp}>{clock(event.timestamp)}</time></div>
          <p>{event.finding}</p><div className="trace-meta"><span>{event.source}</span><span>{event.status}</span>{event.latencyMs != null && <span>{event.latencyMs} ms</span>}{event.model && <span>{event.model}</span>}{typeof event.payload.availability === 'string' && <span>{event.payload.availability}</span>}</div>
          {Object.keys(event.payload).length > 0 && <details><summary><Terminal size={14} />Evidence JSON</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details>}
        </div>
      </li>)}</ol>}
    {investigation?.phase === 'completed' && <div className="trace-state"><CircleCheck size={16} />Investigation complete · {timeline.length} events saved</div>}
  </Card>;
}

function CheckIcon() { return <CircleCheck size={13} />; }

function VerdictPanel({ invoice, allowed, onVerify, reviewer }: { invoice: Invoice; allowed: boolean; onVerify: () => Promise<void>; reviewer: string }) {
  const api = useApi();
  const investigation = invoice.investigation;
  const result = investigation?.result;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    try {
      await api.verify(invoice.id, { method: fields.get('method') as VerificationInput['method'], outcome: fields.get('outcome') as VerificationInput['outcome'], notes: String(fields.get('notes') ?? ''), ...(mode === 'live' && { trustedContactSource: String(fields.get('trustedContactSource') ?? '') }) });
      await onVerify();
      form.reset();
      toast.success('Verification recorded. Verdict updated.');
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  return <Card className="panel workspace-panel">
    <div className="panel-heading"><span className="panel-icon"><ShieldCheck size={19} /></span><div><h2>Risk verdict</h2><p>Policy and independent review</p></div></div>
    {result ? <>
      <div className={'verdict-banner tone-' + verdictTone[result.verdict]}>{result.verdict === 'NO_NEW_FLAGS' ? <CircleCheck size={22} /> : <ShieldAlert size={22} />}<div><h3>{verdictLabel[result.verdict]}</h3><p>{result.summary}</p></div></div>
      <h3 className="subheading">Policy checklist</h3>
      <ul className="checklist">{result.checks.map(check => <li key={check.label}><span className={'checkmark tone-' + (check.state === 'pass' ? 'good' : check.state === 'flag' ? 'warn' : 'neutral')}>{check.state === 'pass' ? <CircleCheck size={14} /> : <AlertTriangle size={14} />}</span><span><strong>{check.label}</strong><small>{check.detail}</small></span></li>)}</ul>
      {!!result.missing.length && <div className="review-block"><h3>Evidence requiring verification</h3><p>{result.missing.join(' · ')}</p></div>}
      <div className="review-block"><h3>Next action</h3><p>{result.nextAction}</p></div>
    </> : <div className="callout tone-neutral"><Clock3 size={17} />Verdict pending investigation.</div>}
    {result?.verdict === 'HOLD_FOR_VERIFICATION' && <>
      <h3 className="subheading">Independent verification</h3>
      {mode === 'live' && investigation?.verificationRequestedAt &&
        <p className="muted">Verification requested on {day(investigation.verificationRequestedAt)}.</p>}
      {!allowed ? <div className="callout tone-warn tooltip-anchor" tabIndex={0} aria-describedby="verification-role-tooltip"><LockKeyhole size={17} /><span>{mode === 'mock' ? 'Switch to Finance Controller to record verification.' : 'Ask a Finance Controller to record independent verification.'}</span><span id="verification-role-tooltip" role="tooltip">Only Finance Controllers can finalise held cases.</span></div> :
        <form className="form-stack verification-form" onSubmit={verify}>
          <label>Verification method<SelectWrap><select name="method" required><option>Known supplier phone</option><option>Existing supplier portal</option><option>Signed supplier confirmation</option></select></SelectWrap></label>
          <label>Outcome<SelectWrap><select name="outcome" defaultValue="" required><option value="" disabled>Choose an outcome</option><option value="CONFIRMED_LEGITIMATE">Confirmed legitimate</option><option value="CONFIRMED_FRAUD">Confirmed fraud</option><option value="INCONCLUSIVE">Inconclusive</option></select></SelectWrap></label>
          {mode === 'live' && <label>Trusted contact source<input name="trustedContactSource" required minLength={3} maxLength={160} placeholder="Verified onboarding record or supplier portal" /></label>}
          <label>Verification notes<textarea name="notes" required minLength={5} maxLength={1000} rows={3} placeholder={mode === 'mock' ? 'Summarise the independent evidence. Use fictional details.' : 'Summarise the independently confirmed evidence.'} /></label>
          <p className="muted">Reviewer {reviewer} · Timestamp recorded on submission</p>
          {error && <ErrorBox message={error} />}
          <Button type="submit" disabled={busy}>{busy ? <LoadingIcon /> : <ShieldCheck size={16} />}Record Verification</Button>
        </form>}
      {mode === 'live' && !allowed && !investigation?.verificationRequestedAt && <div className="actions">
        <Button variant="outline" disabled={busy} onClick={async () => {
          setBusy(true);
          setError('');
          try { await api.requestVerification(invoice.id); await onVerify(); toast.success('Independent verification requested.'); }
          catch (reason) { setError(errorText(reason)); }
          finally { setBusy(false); }
        }}>Request verification</Button>
        {error && <ErrorBox message={error} />}
      </div>}
    </>}
    {!!investigation?.verification.length && <><h3 className="subheading">Verification history</h3><ul className="verification-log">{investigation.verification.map((item, index) => <li key={index}><strong>{item.reviewer}</strong><small>{day(item.timestamp)} · {clock(item.timestamp)} · {item.method}{item.trustedContactSource && ' · ' + item.trustedContactSource}</small><p>{item.outcome.toLowerCase().replaceAll('_', ' ')} · {item.notes}</p></li>)}</ul></>}
  </Card>;
}
