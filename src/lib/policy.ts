import { paymentLabel, redact } from './payment';
import type { Comparison, Invoice, InvoiceDraft, InvoiceStatus, Payment, PolicyCheck, PolicyResult, Supplier, Verification } from './types';

export const domainOf = (email: string) => email.trim().toLowerCase().split('@')[1] ?? '';

export function matchSupplier(input: Pick<InvoiceDraft, 'companyNumber' | 'supplierName'>, suppliers: Supplier[]) {
  const name = input.supplierName.trim().toLowerCase();
  const company = input.companyNumber.trim().toUpperCase();
  return suppliers.find(supplier => name && supplier.name.toLowerCase() === name)
    ?? suppliers.find(supplier => company && supplier.companyNumber === company);
}

export function compare(input: Invoice | InvoiceDraft, baseline?: Supplier, draftPayment?: Payment): Comparison[] {
  const payment = 'paymentId' in input ? draftPayment : input.payment;
  const field = (name: string, incoming: string, trusted?: string, equal?: boolean): Comparison => ({
    field: name, incoming: incoming || '—', trusted: trusted || '—',
    status: !incoming || !trusted ? 'Unknown' : (equal ?? (incoming.toLowerCase() === trusted.toLowerCase())) ? 'Match' : 'Mismatch',
  });
  return [
    field('Company number', input.companyNumber, baseline?.companyNumber),
    field('Sender domain', domainOf(input.senderEmail), baseline?.domain),
    field('Claimed signer', input.signer, baseline?.signer),
    field('Payment destination', payment?.fingerprint ? paymentLabel(payment) : '', baseline?.payment ? paymentLabel(baseline.payment) : undefined, payment?.fingerprint === baseline?.payment?.fingerprint),
  ];
}

export function pretext(message: string) {
  return /urgent|end of day|ignore|confidential|do not call|bypass/i.test(message);
}

export function evaluate(invoice: Invoice, baseline?: Supplier, history: Verification[] = [], pretextFlag = false): PolicyResult {
  const comparisons = compare(invoice, baseline);
  const checks: PolicyCheck[] = [
    { label: 'Trusted supplier baseline', state: baseline?.verifiedAt ? 'pass' : 'unknown', detail: baseline?.trustedSource ?? 'Independent onboarding evidence is missing.' },
    ...comparisons.map(field => ({
      label: field.field, state: field.status === 'Match' ? 'pass' as const : field.status === 'Mismatch' ? 'flag' as const : 'unknown' as const,
      detail: field.status === 'Match' ? 'Matches the archived supplier record.' : field.status === 'Mismatch' ? 'Differs from the archived supplier record.' : 'A claim or trusted reference is missing.',
    })),
    { label: 'Payment pressure', state: pretextFlag ? 'flag' : 'pass', detail: pretextFlag ? 'Message contains urgency or an attempt to bypass normal checks.' : 'No pressure indicators in the available evidence.' },
  ];
  const unresolved = checks.filter(check => check.state !== 'pass' && (check.state !== 'unknown' || check.label !== 'Claimed signer'));
  const last = history.at(-1);
  if (last) checks.push({ label: 'Independent human verification', state: last.outcome === 'CONFIRMED_LEGITIMATE' ? 'pass' : last.outcome === 'CONFIRMED_FRAUD' ? 'flag' : 'unknown', detail: redact(last.method + ' · ' + last.outcome.toLowerCase().replaceAll('_', ' ')) });
  if (last?.outcome === 'CONFIRMED_FRAUD') return { verdict: 'REJECT_PAYMENT_REQUEST', checks, summary: 'Independent verification confirmed a fraudulent payment request.', missing: [], nextAction: 'Escalate to the finance incident owner and preserve the evidence.' };
  if (last?.outcome === 'CONFIRMED_LEGITIMATE') return { verdict: 'NO_NEW_FLAGS', checks, summary: 'Independent verification resolved the fraud hold.', missing: [], nextAction: 'Route through the normal payment approval workflow.' };
  if (unresolved.length) return { verdict: 'HOLD_FOR_VERIFICATION', checks, summary: 'The available evidence requires independent verification.', missing: unresolved.map(check => check.label), nextAction: 'Verify the request through a known supplier contact channel.' };
  return { verdict: 'NO_NEW_FLAGS', checks, summary: 'Invoice claims align with the verified supplier baseline.', missing: [], nextAction: 'Route through the normal payment approval workflow.' };
}

export function invoiceStatus(invoice: Invoice): InvoiceStatus {
  if (invoice.investigation?.phase === 'running') return 'Investigating';
  switch (invoice.investigation?.result?.verdict) {
    case 'NO_NEW_FLAGS': return 'Cleared';
    case 'HOLD_FOR_VERIFICATION': return 'Held';
    case 'REJECT_PAYMENT_REQUEST': return 'Rejected';
    default: return 'Queued';
  }
}
