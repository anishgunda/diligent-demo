import type { Payment, PaymentId } from './types';

const identifiers: PaymentId[] = ['DEMO-1042', 'DEMO-2086', 'DEMO-3619', 'DEMO-4725', 'DEMO-9081'];

export function syntheticPayment(id: PaymentId): Payment {
  if (!identifiers.includes(id)) throw new Error('Choose a synthetic payment destination.');
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return { id, sortCode: '••-••-••', account: '•••• ' + id.slice(-4), fingerprint: 'demo-' + (hash >>> 0).toString(16).padStart(8, '0') };
}

export const paymentOptions = identifiers.map(syntheticPayment);

export function paymentLabel(payment?: Payment) {
  return payment ? payment.sortCode + ' / ' + payment.account : 'No trusted destination';
}

// Demo intake has no field for raw bank data. Redact common account and card
// formats in incidental text before saving or exporting it.
export function redact(text: string) {
  return text
    .replace(/\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/gi, '[IBAN redacted]')
    .replace(/\b[A-Z]{4}\d{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g, '[bank code redacted]')
    .replace(/\b(?:\d[ .-]?){12,19}\b/g, '[payment number redacted]')
    .replace(/\b(?:\d{2}[- .]){2}\d{2}\b/g, '[sort code redacted]')
    .replace(/\b(?:sort\s*code\s*[:=]?\s*)\d{6}\b/gi, 'sort code [redacted]')
    .replace(/\b\d{4}[ -.]+\d{4}\b|\b\d{8}\b/g, '[account redacted]');
}
