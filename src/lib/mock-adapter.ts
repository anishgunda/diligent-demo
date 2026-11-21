import { useAppStore } from '@/store/use-app-store';
import { blankDraft, evalFixtures, sampleDraft, seedData } from './mock-data';
import { paymentOptions, redact, syntheticPayment } from './payment';
import { canVerify } from './permissions';
import { compare, evaluate, matchSupplier, pretext } from './policy';
import type { AuthAdapter, IdentityTwinApi, Investigation, InvestigationEvent, Invoice, InvoiceDraft, Report } from './types';

const read = useAppStore.getState;
const now = () => new Date().toISOString();
const publish = (patch: Partial<ReturnType<typeof read>>) => useAppStore.setState(state => ({ ...patch, revision: state.revision + 1 }));
const get = (id: string) => read().invoices.find(invoice => invoice.id === id);
const required = (id: string) => {
  const invoice = get(id);
  if (!invoice) throw new Error('Invoice could not be found.');
  return invoice;
};
const update = (invoice: Invoice) => publish({ invoices: read().invoices.map(item => item.id === invoice.id ? invoice : item) });
const findCase = (id: string) => read().invoices.find(invoice => invoice.investigation?.id === id);
const issuedId = (prefix: string) => prefix + '-' + String(read().serial).padStart(3, '0');

function save(draft: InvoiceDraft, source: Invoice['source']) {
  const { paymentId, message, companyNumber, ...fields } = draft;
  const safe = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === 'string' ? redact(value.trim()) : value])) as typeof fields;
  const invoice: Invoice = {
    ...safe, companyNumber: /^[A-Z0-9]{8}$/i.test(companyNumber) ? companyNumber.toUpperCase() : '',
    message: pretext(message) ? 'Urgent payment or bypass language detected in the message.' : '',
    payment: syntheticPayment(paymentId), id: issuedId('inv'), source, createdAt: now(),
  };
  invoice.supplierId = matchSupplier(invoice, read().suppliers)?.id;
  publish({ invoices: [invoice, ...read().invoices], serial: read().serial + 1 });
  return invoice;
}

type EventBody = Omit<InvestigationEvent, 'id' | 'investigationId' | 'sequence' | 'timestamp' | 'mode'>;

function eventPlan(invoice: Invoice, investigation: Investigation): EventBody[] {
  const baseline = investigation.baseline;
  const comparisons = compare(invoice, baseline);
  const pressure = pretext(invoice.message);
  const tool = (name: string, source: string, latencyMs: number, finding: string, payload: Record<string, unknown>): EventBody[] => [
    { type: 'tool_started', tool: name, source, status: 'running', finding: 'Checking evidence…', payload: {} },
    { type: 'tool_completed', tool: name, source, status: 'success', latencyMs, finding, payload },
  ];
  const events = tool('get_supplier_baseline', 'Demo supplier registry', 460,
    baseline?.verifiedAt ? 'Archived onboarding evidence retrieved.' : 'No verified onboarding record available.', { supplierId: baseline?.id, verifiedAt: baseline?.verifiedAt });
  const payment = comparisons[3];
  if (baseline?.payment) events.push(...tool('compare_payment_details', 'Synthetic payment registry', 520, 'Payment destination: ' + payment.status.toLowerCase() + '.', { result: payment.status, claimedFingerprint: invoice.payment.fingerprint, trustedFingerprint: baseline.payment.fingerprint }));
  if (comparisons[1].status !== 'Match') events.push(...tool('inspect_sender_domain', 'Demo domain fixtures', 570, 'Sender domain could not be verified against an exact trusted domain.', { ...comparisons[1] }));
  if (!baseline?.verifiedAt || comparisons[0].status !== 'Match') events.push(...tool('lookup_companies_house', 'Demo Companies House fixtures', 480, 'Company identity requires independent corroboration.', { ...comparisons[0] }));
  if (pressure || payment.status === 'Mismatch') events.push(...tool('analyze_message_pretext', 'Demo message heuristic', 500, pressure ? 'Detected payment pressure or verification bypass language.' : 'No urgency or bypass terms detected in the message.', { paymentPressure: pressure }));
  const policy = evaluate(invoice, baseline, [], pressure);
  events.push(
    { type: 'policy_evaluated', source: 'Demo policy engine', status: 'success', finding: policy.summary, payload: { verdict: policy.verdict, checks: policy.checks } },
    { type: 'completed', source: 'Demo case record', status: 'success', finding: 'Investigation saved and audit report available.', payload: {} },
  );
  return events;
}

function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function createMockAdapter(auth: AuthAdapter): IdentityTwinApi {
  return {
    async createPaymentCandidate() { throw new Error('Use the synthetic payment destinations in mock mode.'); },
    async approvePayment() { throw new Error('Payment approval is available in live mode.'); },
    async getDocument() { throw new Error('Uploaded files are not persisted in mock mode.'); },
    async requestVerification() { throw new Error('Verification requests are available in live mode.'); },
    async extract(input) {
      if (!input.sample && !input.file) throw new Error('Choose a PDF first.');
      if (input.file && (input.file.size > 15 * 1024 * 1024 || await input.file.slice(0, 5).text() !== '%PDF-')) throw new Error('Choose a valid PDF up to 15 MB.');
      const base = input.sample ? sampleDraft : { ...blankDraft, invoiceDate: new Date().toISOString().slice(0, 10), dueDate: '' };
      return { mode: 'mock', status: input.sample ? 'sample' : 'manual', paymentOptions, draft: { ...base, senderEmail: input.senderEmail || base.senderEmail, message: input.message || base.message } };
    },
    async listInvoices() { return read().invoices; },
    async getInvoice(id) { return get(id); },
    async saveInvoice(input) { return save(input, 'Upload'); },
    async submitDemoInvoice(kind) {
      const input = kind === 'fraud'
        ? { ...sampleDraft, message: 'Urgent: do not call. Use the new details before end of day.' }
        : { ...sampleDraft, supplierName: 'Albion Office Systems', companyNumber: '14280631', senderEmail: 'billing@albionoffice.example', signer: 'Nina Brooks', paymentId: 'DEMO-1042' as const, amount: 1695, message: '' };
      const invoiceNumber = (kind === 'fraud' ? 'WL-F' : 'AOS-ERP') + read().serial;
      return save({ ...input, invoiceNumber, paymentReference: invoiceNumber }, 'ERP sync');
    },
    async startInvestigation({ invoiceId }) {
      const invoice = required(invoiceId);
      if (invoice.investigation && invoice.investigation.phase !== 'error') {
        return { investigationId: invoice.investigation.id, phase: invoice.investigation.phase };
      }
      const id = issuedId('case');
      const baseline = read().suppliers.find(item => item.id === invoice.supplierId) ?? matchSupplier(invoice, read().suppliers);
      const investigation: Investigation = { id, phase: 'running', baseline, startedAt: now(), events: [], verification: [] };
      publish({ invoices: read().invoices.map(item => item.id === invoiceId ? { ...item, investigation } : item), serial: read().serial + 1 });
      return { investigationId: id, phase: 'running' };
    },
    async *events(id, { after = 0, signal } = {}) {
      signal = signal ? AbortSignal.any([signal, resetSignal.signal]) : resetSignal.signal;
      const initial = findCase(id);
      if (!initial?.investigation) throw new Error('Investigation could not be found.');
      const plan = eventPlan(initial, initial.investigation);
      let sequence = after + 1;
      while (!signal?.aborted) {
        const invoice = findCase(id);
        const investigation = invoice?.investigation;
        if (!invoice || !investigation) return;
        const saved = investigation.events[sequence - 1];
        if (saved) {
          yield saved;
          sequence++;
          continue;
        }
        if (investigation.phase !== 'running') return;
        const next = plan[sequence - 1];
        if (!next) throw new Error('Investigation ended before completion.');
        await pause(440 + (sequence % 4) * 65, signal);
        const latest = findCase(id);
        if (signal?.aborted || !latest?.investigation) return;
        if (latest.investigation.events.length >= sequence) continue;
        const event: InvestigationEvent = { ...next, id: id + '-' + sequence, investigationId: id, sequence, timestamp: now(), mode: 'mock' };
        const current = latest.investigation;
        const completed = event.type === 'completed';
        update({ ...latest, investigation: {
          ...current, phase: completed ? 'completed' : 'running', events: [...current.events, event],
          result: completed ? evaluate(latest, current.baseline, [], pretext(latest.message)) : undefined,
        } });
      }
    },
    async verify(id, input) {
      const identity = auth.identity();
      if (!canVerify(identity.role)) throw new Error('Only a Finance Controller can record independent verification.');
      const invoice = required(id);
      const caseRecord = invoice.investigation;
      if (caseRecord?.phase !== 'completed' || caseRecord.result?.verdict !== 'HOLD_FOR_VERIFICATION') throw new Error('Only a completed, held case can be reviewed.');
      const notes = redact(input.notes.trim());
      if (!notes || notes.length < 5) throw new Error('Add verification notes before submitting.');
      const verification = [...caseRecord.verification, { ...input, notes, reviewer: identity.name, timestamp: now() }];
      const revised = { ...invoice, investigation: { ...caseRecord, verification, result: evaluate(invoice, caseRecord.baseline, verification, pretext(invoice.message)) } };
      update(revised);
      return revised;
    },
    async listSuppliers() { return read().suppliers; },
    async saveSupplier(input, id) {
      const existing = id ? read().suppliers.find(item => item.id === id) : undefined;
      if (id && !existing) throw new Error('Supplier could not be found.');
      const safe = { name: redact(input.name.trim()), companyNumber: input.companyNumber.trim().toUpperCase(), domain: redact(input.domain.trim().toLowerCase()), signer: redact(input.signer.trim()) };
      if (!safe.name || !/^[A-Z0-9]{8}$/.test(safe.companyNumber)) throw new Error('Enter a supplier name and an eight-character company number.');
      if (read().suppliers.some(item => item.id !== id && item.companyNumber === safe.companyNumber)) throw new Error('A supplier already uses this company number.');
      const supplier = { ...existing, ...safe, id: existing?.id ?? issuedId('supplier'), changes: existing?.changes ?? [] };
      const suppliers = existing ? read().suppliers.map(item => item.id === id ? supplier : item) : [...read().suppliers, supplier];
      // Identity edits require reverification. The archived payment remains intact.
      if (existing?.verifiedAt && (safe.companyNumber !== existing.companyNumber || safe.domain !== existing.domain || safe.signer !== existing.signer)) {
        throw new Error('Verified identity fields are locked. You can update the directory name.');
      }
      publish({ suppliers, serial: read().serial + (existing ? 0 : 1) });
      return supplier;
    },
    async listPaymentOptions() { return paymentOptions; },
    async proposePayment(id, paymentId) {
      const supplier = read().suppliers.find(item => item.id === id);
      if (!supplier) throw new Error('Supplier could not be found.');
      const proposed = syntheticPayment(paymentId);
      if (supplier.payment?.id === paymentId || supplier.changes.some(change => change.proposed.id === paymentId)) throw new Error('This destination is already verified or pending.');
      const revised = { ...supplier, changes: [...supplier.changes, { id: issuedId('change'), proposedAt: now(), previous: supplier.payment, proposed, reviewer: auth.identity().name, status: 'Pending independent verification' as const }] };
      publish({ suppliers: read().suppliers.map(item => item.id === id ? revised : item), serial: read().serial + 1 });
      return revised;
    },
    async listReports() {
      return read().invoices.flatMap(({ investigation, ...invoice }): Report[] => {
        if (!investigation?.result) return [];
        const { message: _message, ...metadata } = invoice;
        void _message;
        return [{
          id: investigation.id, invoiceId: invoice.id, createdAt: investigation.verification.at(-1)?.timestamp ?? investigation.events.at(-1)?.timestamp ?? investigation.startedAt,
          invoice: metadata, baseline: investigation.baseline, policy: investigation.result, evidence: investigation.events, verification: investigation.verification,
          paymentAuthorisation: 'OUTSIDE_WORKFLOW',
        }];
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async listEvals() { return evalFixtures; },
    async reset() {
      // Close active generators before a future case can reuse a demo ID.
      resetSignal.abort();
      resetSignal = new AbortController();
      publish({ ...seedData(), revision: read().revision, role: 'AP_ANALYST' });
    },
    subscribe(listener) { return useAppStore.subscribe(listener); },
  };
}

let resetSignal = new AbortController();
