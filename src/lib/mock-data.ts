import { syntheticPayment } from './payment';
import { evaluate } from './policy';
import type { EvalRow, Invoice, InvoiceDraft, Supplier, Verdict } from './types';

const date = '2026-11-18';
const supplierRows = [
  ['albion', 'Albion Office Systems', '14280631', 'albionoffice.example', 'Nina Brooks', 'DEMO-1042'],
  ['westmere', 'Westmere Logistics', '11350724', 'westmerelogistics.example', 'Owen Ellis', 'DEMO-2086'],
  ['fenwick', 'Fenwick Cloud Services', '15609182', 'fenwickcloud.example', 'Maya Foster', 'DEMO-3619'],
  ['harbour', 'Harbour Facilities Group', '12841065', 'harbourfacilities.example', 'Elliot Shah', 'DEMO-4725'],
] as const;

export const seededSuppliers = (): Supplier[] => supplierRows.map(([id, name, companyNumber, domain, signer, payment]) => ({
  id, name, companyNumber, domain, signer, payment: syntheticPayment(payment), verifiedAt: '2026-09-14',
  trustedSource: 'Independent onboarding call', changes: [],
}));

export const sampleDraft: InvoiceDraft = {
  supplierName: 'Westmere Logistics', companyNumber: '11350724', invoiceNumber: 'WL-2026-1184',
  amount: 18420, invoiceDate: date, dueDate: '2026-12-18', senderEmail: 'billing@westmerelogistics.example',
  signer: 'Owen Ellis', paymentId: 'DEMO-9081', paymentReference: 'WL-1184', message: 'Please use our updated remittance details for this invoice.',
};

export const blankDraft = { ...sampleDraft, supplierName: '', companyNumber: '', invoiceNumber: '', amount: 0, senderEmail: '', signer: '', paymentId: '', paymentReference: '', message: '' };

export function seedData() {
  const suppliers = seededSuppliers();
  const fromSupplier = (supplier: Supplier, id: string, invoiceNumber: string, amount: number): Invoice => ({
    id, supplierId: supplier.id, supplierName: supplier.name, companyNumber: supplier.companyNumber,
    invoiceNumber, amount, invoiceDate: date, dueDate: '2026-12-18',
    senderEmail: 'billing@' + supplier.domain, signer: supplier.signer,
    payment: supplier.payment!, paymentReference: invoiceNumber, message: '', source: 'ERP sync', createdAt: date + 'T09:00:00.000Z',
  });
  const clean = fromSupplier(suppliers[0], 'inv-1042', 'AOS-1042', 2460);
  const changed = { ...fromSupplier(suppliers[1], 'inv-1184', 'WL-1184', 18420), payment: syntheticPayment('DEMO-9081') };
  const lookalike = { ...fromSupplier(suppliers[2], 'inv-1139', 'FCS-1139', 9750), senderEmail: 'billing@fenwickcl0ud.example' };
  const compromised = { ...fromSupplier(suppliers[3], 'inv-1107', 'HFG-1107', 12780), payment: syntheticPayment('DEMO-9081'), message: 'Urgent: do not call. Please pay before end of day.' };
  const newSupplier = { ...fromSupplier(suppliers[0], 'inv-1092', 'MHE-1092', 3640), supplierId: undefined, supplierName: 'Moorhill Electrical', companyNumber: '16287031', senderEmail: 'finance@moorhillelectrical.example', signer: 'Leah Reid', payment: syntheticPayment('DEMO-9081') };
  const pending = fromSupplier(suppliers[0], 'inv-1050', 'AOS-1050', 1290);
  const invoices = [changed, lookalike, compromised, newSupplier, pending, clean];
  const baseline = suppliers[0];
  const id = 'case-seed-1042';
  clean.investigation = {
    id, phase: 'completed', baseline, startedAt: clean.createdAt, verification: [],
    result: evaluate(clean, baseline),
    events: [
      { id: id + '-1', investigationId: id, sequence: 1, timestamp: clean.createdAt, type: 'tool_completed', tool: 'get_supplier_baseline', status: 'success', latencyMs: 480, finding: 'Verified Albion supplier baseline located.', source: 'Demo supplier registry', mode: 'mock', payload: { supplierId: baseline.id } },
      { id: id + '-2', investigationId: id, sequence: 2, timestamp: clean.createdAt, type: 'completed', status: 'success', finding: 'Investigation complete.', source: 'Demo policy engine', mode: 'mock', payload: {} },
    ],
  };
  return { suppliers, invoices, serial: 1, revision: 0 };
}

const C: Verdict = 'NO_NEW_FLAGS';
const H: Verdict = 'HOLD_FOR_VERIFICATION';
const R: Verdict = 'REJECT_PAYMENT_REQUEST';
const scenarios: [string, Verdict, Verdict, Verdict, number, number, boolean][] = [
  ['Verified supplier and unchanged remittance', C, C, C, 2, 920, false],
  ['Recurring invoice with known sender', C, C, H, 2, 1080, false],
  ['Trusted supplier with optional signer absent', C, C, C, 2, 1010, false],
  ['Genuine account change independently verified', C, C, H, 4, 2180, false],
  ['Genuine account change awaiting a callback', H, H, H, 4, 2020, false],
  ['Lookalike domain with substituted account', H, H, C, 5, 2750, true],
  ['Lookalike domain with unchanged remittance', H, H, H, 3, 1670, true],
  ['Compromised genuine mailbox and diversion', H, H, C, 4, 2320, true],
  ['Compromised mailbox confirmed by supplier', R, R, H, 4, 2410, true],
  ['Fabricated Companies House identity', H, H, C, 4, 2200, true],
  ['Unverified supplier with missing evidence', H, H, H, 3, 1810, false],
  ['Inconclusive independent verification', H, H, C, 4, 2090, false],
];
export const evalFixtures: EvalRow[] = scenarios.map(([scenario, expected, agent, baseline, tools, latencyMs, fraud], index) => ({
  id: 'E' + String(index + 1).padStart(2, '0'), scenario, expected, agent, baseline, tools, latencyMs, fraud,
}));
