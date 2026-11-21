'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Check, ChevronLeft, ClipboardCheck, FileText, FlaskConical, Landmark, Play, Save, UploadCloud, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { mode } from '@/lib/api';
import { useApi } from '@/lib/api-context';
import { errorText } from '@/lib/format';
import { compare, matchSupplier } from '@/lib/policy';
import { samplePdf } from '@/lib/sample-pdf';
import type { ExtractionResponse, InvoiceDraft, Payment } from '@/lib/types';
import { useData } from '@/lib/use-data';
import { Badge, ErrorBox, LoadingIcon, PageHeading, SelectWrap, Skeleton, Status } from './common';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { PaymentIntake } from './payment-intake';

const schema = z.object({
  supplierName: z.string().trim().min(2, 'Enter the supplier name.').max(100),
  companyNumber: z.string().trim().regex(/^(?:[a-z\d]{8})?$/i, 'Use an eight-character company number.'),
  invoiceNumber: z.string().trim().min(1, 'Enter an invoice number.').max(48),
  amount: z.number({ error: 'Enter a GBP amount.' }).positive().max(999999999).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.0001, 'Use up to two decimal places.'),
  invoiceDate: z.iso.date({ error: 'Enter a valid invoice date.' }),
  dueDate: z.iso.date({ error: 'Enter a valid due date.' }),
  senderEmail: z.union([z.email(), z.literal('')]),
  signer: z.string().trim().max(80),
  paymentId: mode === 'mock' ? z.string().min(1, 'Choose a payment destination.') : z.string(),
  paymentReference: z.string().trim().max(48),
  message: z.string().max(4000),
  extractionId: z.string().optional(),
}).refine(fields => fields.dueDate >= fields.invoiceDate, { path: ['dueDate'], message: 'Due date must be on or after the invoice date.' });

function PdfPreview({ file }: { file: File }) {
  const [preview, setPreview] = useState<{ file: File; url: string; embedded: boolean }>();
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const embedded = navigator.pdfViewerEnabled !== false;
    const timer = window.setTimeout(() => setPreview({ file, url, embedded }), 0);
    return () => { window.clearTimeout(timer); URL.revokeObjectURL(url); };
  }, [file]);
  if (preview?.file !== file) return <Skeleton label="Preparing PDF preview" />;
  return <div className="pdf">
    <div className="pdf-toolbar"><span className="inline-icon"><FileText size={16} />{file.name}</span><a className="text-link" href={preview.url} target="_blank" rel="noreferrer">Open PDF</a></div>
    {preview.embedded ? <iframe src={preview.url} title={'Preview of ' + file.name} /> : <p className="muted">Embedded preview is unavailable in this browser. Open the PDF using the link above.</p>}
  </div>;
}

export function InvoiceUpload() {
  const api = useApi();
  const router = useRouter();
  const picker = useRef<HTMLInputElement>(null);
  const fileRequest = useRef(0);
  const [selected, setSelected] = useState<{ file: File; sample: boolean }>();
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<ExtractionResponse>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  async function choose(file?: File) {
    if (!file) return;
    const request = ++fileRequest.current;
    const valid = file.size <= 15 * 1024 * 1024 && file.name.toLowerCase().endsWith('.pdf') && await file.slice(0, 5).text() === '%PDF-';
    if (request !== fileRequest.current) return;
    if (!valid) {
      setSelected(undefined);
      setError('Choose a valid PDF file up to 15 MB.');
      return;
    }
    setSelected({ file: file.type === 'application/pdf' ? file : new File([file], file.name, { type: 'application/pdf' }), sample: false });
    setError('');
  }

  async function extract() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try { setResult(await api.extract({ ...selected, senderEmail: email, message })); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  async function save(draft: InvoiceDraft, run: boolean) {
    const invoice = await api.saveInvoice(draft);
    if (run) {
      try { await api.startInvestigation({ invoiceId: invoice.id }); }
      catch (reason) { toast.error('Invoice saved. ' + errorText(reason)); router.push('/invoices/' + invoice.id); return; }
    }
    toast.success(run ? 'Invoice saved. Investigation started.' : 'Invoice saved to the queue.');
    router.push(run ? '/invoices/' + invoice.id : '/invoices');
  }

  return <>
    <Link href="/invoices" className="breadcrumb"><ChevronLeft size={16} />Invoices</Link>
    <PageHeading title="Upload invoice" description="Prepare an invoice for supplier and payment verification." />
    <div className="steps" aria-label="Upload progress"><span className={!result ? 'current' : 'complete'}><span>{result ? <Check size={15} /> : '1'}</span>Upload PDF</span><i /><span className={result ? 'current' : ''}><span>2</span>Review extraction</span></div>
    {result ? <Review result={result} file={selected?.file} back={() => setResult(undefined)} save={save} /> :
      <div className="intake-grid">
        <Card className="panel"><h2>Invoice document</h2><p className="muted">Upload a PDF up to 15 MB. Use fictional invoice and payment data in this demo.</p>
          <div className={'drop-zone' + (drag ? ' dragging' : '')}
            onDragOver={event => { event.preventDefault(); if (!busy) setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={event => { event.preventDefault(); setDrag(false); if (!busy) void choose(event.dataTransfer.files[0]); }}>
            <span className="upload-icon"><UploadCloud size={25} /></span><strong>Drag and drop your invoice PDF</strong><span className="muted">or choose a file from your device</span>
            <input ref={picker} type="file" accept=".pdf,application/pdf" aria-label="Invoice PDF" className="sr-only" tabIndex={-1} onChange={event => { void choose(event.target.files?.[0]); event.target.value = ''; }} />
            <Button disabled={busy} variant="outline" onClick={() => picker.current?.click()}>Choose PDF</Button>
          </div>
          {selected && <div className="selected-file"><FileText size={18} /><span>{selected.file.name}</span><Button variant="ghost" size="icon" disabled={busy} aria-label="Remove PDF" onClick={() => { fileRequest.current++; setSelected(undefined); }}><X size={17} /></Button></div>}
          {mode === 'mock' && <Button variant="ghost" disabled={busy} onClick={() => { fileRequest.current++; setSelected({ file: samplePdf(), sample: true }); setError(''); }}><FlaskConical size={16} />Use Sample Invoice</Button>}
          <div className="form-stack intake-fields"><label>Sender email <small>Optional</small><input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="billing@supplier.example" maxLength={160} /></label><label>Original email message <small>Optional</small><textarea rows={4} value={message} onChange={event => setMessage(event.target.value)} placeholder="Paste a fictional message for payment pressure checks." maxLength={4000} /></label></div>
          {error && <ErrorBox message={error} />}
          <div className="actions"><Button disabled={!selected || busy} onClick={() => void extract()}>{busy ? <LoadingIcon /> : <ClipboardCheck size={16} />}Extract Details</Button></div>
        </Card>
        <Card className="panel"><div className="section-line"><h2>Document preview</h2><Badge>PDF</Badge></div>{selected ? <PdfPreview file={selected.file} /> : <div className="preview-placeholder"><FileText size={32} /><strong>No document selected</strong><span>Choose a PDF to preview it here.</span></div>}</Card>
      </div>}
  </>;
}

const fields = [
  ['supplierName', 'Supplier name', 'text'], ['companyNumber', 'Companies House number', 'text'],
  ['invoiceNumber', 'Invoice number', 'text'], ['amount', 'Amount in GBP', 'number'],
  ['invoiceDate', 'Invoice date', 'date'], ['dueDate', 'Due date', 'date'],
  ['senderEmail', 'Sender email', 'email'], ['signer', 'Claimed signer', 'text'],
  ['paymentReference', 'Payment reference', 'text'],
] as const;

function Review({ result, file, back, save }: { result: ExtractionResponse; file?: File; back: () => void; save: (draft: InvoiceDraft, run: boolean) => Promise<void> }) {
  const api = useApi();
  const { data: suppliers, loading, error: supplierError } = useData(api.listSuppliers);
  const defaults = { ...result.draft, amount: result.draft.amount ?? undefined };
  const { control, register, handleSubmit, setValue, formState: { errors, isSubmitting } } = useForm<InvoiceDraft>({ resolver: zodResolver(schema), defaultValues: defaults });
  const draft = useWatch<InvoiceDraft>({ control }) as InvoiceDraft;
  const match = suppliers ? matchSupplier(draft, suppliers) : undefined;
  const [manualPayment, setManualPayment] = useState<Payment>();
  const options = manualPayment ? [...result.paymentOptions, manualPayment] : result.paymentOptions;
  const payment = options.find(option => option.id === draft.paymentId);
  const [error, setError] = useState('');
  const submit = (run: boolean) => handleSubmit(async values => {
    setError('');
    try { await save(values, run); }
    catch (reason) { setError(errorText(reason)); }
  });

  return <div className="intake-grid">
    <Card className="panel">
      <div className="section-line"><h2>Review invoice details</h2><Badge tone="info">{result.status === 'sample' ? 'Simulated extraction' : result.status === 'manual' ? 'Manual entry' : 'Live extraction'}</Badge></div>
      <p className="muted">{result.status === 'manual' ? 'The demo previews your PDF. Enter its details manually using fictional data.' : 'Check the fields against the source document before saving.'}</p>
      {!!result.missingFields?.length && <div className="callout tone-warn">Some fields could not be extracted. Review the fields marked for confirmation.</div>}
      <form className="form-stack" onSubmit={submit(false)}>
        <div className="form-grid">{fields.map(([name, label, type]) => <label key={name}>{label}
          <input type={type} step={type === 'number' ? '0.01' : undefined} aria-invalid={!!errors[name]} {...register(name, { valueAsNumber: type === 'number' })} />
          {result.missingFields?.includes(name) && <small>Confirm from the source document</small>}
          {errors[name] && <span role="alert" className="field-error">{errors[name].message}</span>}
        </label>)}
        <label>{result.mode === 'mock' ? 'Synthetic payment destination' : 'Payment destination'}<SelectWrap><select aria-invalid={!!errors.paymentId} {...register('paymentId')}><option value="" disabled={mode === 'mock'}>{mode === 'mock' ? 'Choose a destination' : 'Destination unknown'}</option>{options.map(option => <option key={option.id} value={option.id}>{result.mode === 'mock' ? option.id + ' · ' : ''}{option.account}</option>)}</select></SelectWrap>{errors.paymentId && <span role="alert" className="field-error">{errors.paymentId.message}</span>}</label>
        <label>Sort code<input readOnly value={payment?.sortCode ?? '—'} /></label><label>Bank account<input readOnly value={payment?.account ?? '—'} /></label></div>
        {mode === 'live' && <PaymentIntake onSaved={option => { setManualPayment(option); setValue('paymentId', option.id); }} />}
        {error && <ErrorBox message={error} />}
        <div className="actions form-actions"><Button variant="ghost" disabled={isSubmitting} onClick={back}>Back to upload</Button><Button type="submit" variant="outline" disabled={isSubmitting}><Save size={16} />Save to Queue</Button><Button disabled={isSubmitting} onClick={() => void submit(true)()}><Play size={16} />Save &amp; Run Investigation</Button></div>
      </form>
    </Card>
    <div className="stack"><Card className="panel"><div className="section-line"><h2 className="inline-icon"><Landmark size={17} />Supplier match</h2></div>
      {loading ? <Skeleton label="Checking supplier match" /> : supplierError ? <ErrorBox message={supplierError} /> : <>
        <div className={'callout ' + (match?.verifiedAt ? 'tone-good' : 'tone-warn')}>{match ? match.name + (match.verifiedAt ? ' · Verified supplier' : ' · Baseline pending') : 'New supplier · No trusted baseline'}</div>
        <dl className="compare-list">{compare(draft, match, payment).map(field => <div key={field.field}><dt>{field.field}<Status value={field.status} /></dt><dd><span><small>Invoice</small>{field.incoming}</span><span><small>Trusted</small>{field.trusted}</span></dd></div>)}</dl>
      </>}
    </Card>{file && <Card className="panel"><h2>Source document</h2><PdfPreview file={file} /></Card>}</div>
  </div>;
}
