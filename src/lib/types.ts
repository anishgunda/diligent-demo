export type Role = 'AP_ANALYST' | 'FINANCE_CONTROLLER';
export type Mode = 'mock' | 'live';
export type Verdict = 'NO_NEW_FLAGS' | 'HOLD_FOR_VERIFICATION' | 'REJECT_PAYMENT_REQUEST';
export type InvoiceStatus = 'Queued' | 'Investigating' | 'Held' | 'Cleared' | 'Rejected';
export type PaymentId = string;
export type Payment = { id: PaymentId; sortCode: string; account: string; fingerprint: string };
export type Identity = { name: string; role: Role; organisation: string; organisationId?: string; userId?: string };
export interface AuthAdapter {
  identity(): Identity;
  token(): Promise<string | undefined>;
  subscribe(listener: () => void): () => void;
}
export type InvoiceDraft = {
  supplierName: string; companyNumber: string; invoiceNumber: string; amount: number;
  invoiceDate: string; dueDate: string; senderEmail: string; signer: string;
  paymentId: PaymentId; paymentReference: string; message: string;
  extractionId?: string;
};
export type Invoice = Omit<InvoiceDraft, 'paymentId'> & {
  id: string; payment: Payment; supplierId?: string; source: 'Upload' | 'ERP sync';
  createdAt: string; investigation?: Investigation;
  hasDocument?: boolean;
};
export type SupplierInput = { name: string; companyNumber: string; domain: string; signer: string };
export type Supplier = SupplierInput & {
  id: string; payment?: Payment; verifiedAt?: string; trustedSource?: string;
  changes: { id: string; proposedAt: string; previous?: Payment; proposed: Payment; reviewer: string; status: 'Pending independent verification' | 'Verified' | 'Superseded'; approvedBy?: string }[];
};
export type Comparison = { field: string; incoming: string; trusted: string; status: 'Match' | 'Mismatch' | 'Unknown' };
export type EventType = 'tool_started' | 'tool_completed' | 'policy_evaluated' | 'completed' | 'error' |
  'investigation_started' | 'tool_failed' | 'agent_observation' | 'investigation_completed' | 'investigation_failed';
export type Execution = 'AGENTIC' | 'RULES_ONLY';
export type AIStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'FAILED';
export type InvestigationEvent = {
  id: string; investigationId: string; type: EventType; sequence: number; timestamp: string;
  tool?: string; status: 'running' | 'success' | 'error'; latencyMs?: number; finding: string;
  source: string; mode: Mode; payload: Record<string, unknown>;
  executionMode?: Execution; provider?: string; model?: string;
};
export type PolicyCheck = { label: string; state: 'pass' | 'flag' | 'unknown'; detail: string; evidenceRefs?: string[] };
export type PolicyResult = { verdict: Verdict; checks: PolicyCheck[]; summary: string; missing: string[]; nextAction: string };
export type VerificationInput = {
  method: 'Known supplier phone' | 'Existing supplier portal' | 'Signed supplier confirmation';
  outcome: 'CONFIRMED_LEGITIMATE' | 'CONFIRMED_FRAUD' | 'INCONCLUSIVE'; notes: string; trustedContactSource?: string;
};
export type Verification = VerificationInput & { reviewer: string; timestamp: string };
export type Investigation = {
  id: string; phase: 'running' | 'completed' | 'error'; baseline?: Supplier;
  events: InvestigationEvent[]; verification: Verification[]; result?: PolicyResult; startedAt: string;
  executionMode?: Execution; aiStatus?: AIStatus; provider?: string; model?: string;
  verificationRequestedAt?: string; verificationRequestedBy?: string;
};
export type Report = {
  id: string; invoiceId: string; createdAt: string; invoice: Omit<Invoice, 'investigation' | 'message'>;
  baseline?: Supplier; policy: PolicyResult; evidence: InvestigationEvent[]; verification: Verification[];
  paymentAuthorisation: 'OUTSIDE_WORKFLOW';
  executionMode?: Execution; aiStatus?: AIStatus; version?: number; provider?: string; model?: string;
  verificationRequestedAt?: string; verificationRequestedBy?: string;
};
export type EvalRow = { id: string; scenario: string; expected: Verdict; agent: Verdict; baseline: Verdict; tools: number; latencyMs: number; fraud: boolean };
export type ExtractionRequest = { file?: File; sample: boolean; senderEmail: string; message: string };
export type ExtractionResponse = { draft: Omit<InvoiceDraft, 'amount'> & { amount: number | null }; paymentOptions: Payment[]; mode: Mode; status: 'sample' | 'manual' | 'extracted'; missingFields?: string[] };
export type InvestigationRequest = { invoiceId: string };
export type InvestigationResponse = { investigationId: string; phase: Investigation['phase'] };
export type EventCursor = { after?: number; signal?: AbortSignal };
export interface IdentityTwinApi {
  extract(input: ExtractionRequest): Promise<ExtractionResponse>;
  listInvoices(): Promise<Invoice[]>;
  getInvoice(id: string): Promise<Invoice | undefined>;
  saveInvoice(draft: InvoiceDraft): Promise<Invoice>;
  submitDemoInvoice(kind: 'erp' | 'fraud'): Promise<Invoice>;
  startInvestigation(input: InvestigationRequest): Promise<InvestigationResponse>;
  events(id: string, cursor?: EventCursor): AsyncIterable<InvestigationEvent>;
  verify(id: string, input: VerificationInput): Promise<Invoice>;
  requestVerification(id: string): Promise<Invoice>;
  listSuppliers(): Promise<Supplier[]>;
  saveSupplier(input: SupplierInput, id?: string): Promise<Supplier>;
  listPaymentOptions(supplierId: string): Promise<Payment[]>;
  proposePayment(id: string, paymentId: PaymentId): Promise<Supplier>;
  createPaymentCandidate(input: { sortCode: string; account: string }): Promise<Payment>;
  approvePayment(id: string, proposalId: string, review: VerificationInput): Promise<Supplier>;
  getDocument(id: string): Promise<Blob>;
  listReports(): Promise<Report[]>;
  listEvals(): Promise<EvalRow[]>;
  reset(): Promise<void>;
  subscribe(listener: () => void): () => void;
}
