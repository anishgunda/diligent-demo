from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

Verdict = Literal["NO_NEW_FLAGS", "HOLD_FOR_VERIFICATION", "REJECT_PAYMENT_REQUEST"]
Method = Literal["Known supplier phone", "Existing supplier portal", "Signed supplier confirmation"]
Outcome = Literal["CONFIRMED_LEGITIMATE", "CONFIRMED_FRAUD", "INCONCLUSIVE"]
Phase = Literal["running", "completed", "error"]
Execution = Literal["AGENTIC", "RULES_ONLY"]
AIStatus = Literal["AVAILABLE", "UNAVAILABLE", "FAILED"]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class InvoiceDraft(Input):
    supplierName: str = Field(min_length=2, max_length=100)
    companyNumber: str = Field(default="", pattern=r"^(?:[a-zA-Z0-9]{8})?$")
    invoiceNumber: str = Field(min_length=1, max_length=48)
    amount: Decimal = Field(gt=0, le=999999999, decimal_places=2)
    invoiceDate: date
    dueDate: date
    senderEmail: str = Field(default="", max_length=160, pattern=r"^(?:[^\s@]+@[^\s@]+\.[^\s@]+)?$")
    signer: str = Field(default="", max_length=80)
    paymentId: UUID | Literal[""] = ""
    paymentReference: str = Field(default="", max_length=48)
    message: str = Field(default="", max_length=4000)
    extractionId: UUID | None = None

    @model_validator(mode="after")
    def chronological_dates(self):
        if self.dueDate < self.invoiceDate:
            raise ValueError("Due date must be on or after the invoice date.")
        return self


class SupplierInput(Input):
    name: str = Field(min_length=2, max_length=100)
    companyNumber: str = Field(pattern=r"^[A-Za-z0-9]{8}$")
    domain: str = Field(default="", max_length=160, pattern=r"^(?:[A-Za-z0-9.-]+)?$")
    signer: str = Field(default="", max_length=80)


class PaymentInput(Input):
    sortCode: str = Field(pattern=r"^(?:[0-9]{6}|[0-9]{2}(?:[- ][0-9]{2}){2})$")
    account: str = Field(pattern=r"^(?:[0-9]{8}|[0-9]{4} [0-9]{4})$")


class PaymentProposal(Input):
    paymentId: UUID


class VerificationInput(Input):
    method: Method
    outcome: Outcome
    notes: str = Field(min_length=5, max_length=1000)
    trustedContactSource: str = Field(min_length=3, max_length=160)


class BeginInvestigation(Input):
    invoiceId: UUID


class PolicyCheck(BaseModel):
    label: str
    state: Literal["pass", "flag", "unknown"]
    detail: str
    evidenceRefs: list[str] = Field(default_factory=list)


class PolicyResult(BaseModel):
    verdict: Verdict
    checks: list[PolicyCheck]
    summary: str
    missing: list[str]
    nextAction: str


class ToolEvidence(BaseModel):
    tool: str
    status: Literal["success", "unavailable", "error"]
    result: dict
    summary: str
    provenance: str
    availability: Literal["live", "fixture", "unavailable"] = "live"
    latencyMs: int = 0
    error: str | None = None


class Event(BaseModel):
    id: str
    investigationId: UUID
    sequence: int
    timestamp: datetime
    type: Literal[
        "investigation_started",
        "tool_started",
        "tool_completed",
        "tool_failed",
        "agent_observation",
        "policy_evaluated",
        "investigation_completed",
        "investigation_failed",
    ]
    tool: str | None = None
    status: Literal["running", "success", "error"]
    latencyMs: int | None = None
    finding: str
    source: str
    mode: Literal["live"] = "live"
    payload: dict = Field(default_factory=dict)
    executionMode: Execution | None = None
    provider: str | None = None
    model: str | None = None


class PaymentView(BaseModel):
    id: str
    fingerprint: str
    sortCode: str
    account: str


class PaymentChangeView(BaseModel):
    id: UUID
    proposedAt: datetime
    previous: PaymentView | None
    proposed: PaymentView
    reviewer: str
    status: Literal["Pending independent verification", "Verified", "Superseded"]
    approvedBy: str | None = None


class SupplierView(SupplierInput):
    id: UUID
    payment: PaymentView | None
    verifiedAt: datetime | None
    trustedSource: str | None
    changes: list[PaymentChangeView]


class VerificationView(VerificationInput):
    reviewer: str
    timestamp: datetime


class InvestigationView(BaseModel):
    id: UUID
    phase: Phase
    baseline: SupplierView | None
    events: list[Event]
    verification: list[VerificationView]
    result: PolicyResult | None
    startedAt: datetime
    executionMode: Execution | None
    aiStatus: AIStatus | None
    provider: str | None
    model: str | None
    verificationRequestedAt: datetime | None = None
    verificationRequestedBy: str | None = None


class InvoiceMetadata(BaseModel):
    id: UUID
    supplierId: UUID | None
    supplierName: str
    companyNumber: str
    invoiceNumber: str
    amount: float
    invoiceDate: date
    dueDate: date
    senderEmail: str
    signer: str
    payment: PaymentView
    paymentReference: str
    source: Literal["Upload", "ERP sync"]
    createdAt: datetime
    hasDocument: bool


class InvoiceView(InvoiceMetadata):
    message: str
    investigation: InvestigationView | None


class ReportView(BaseModel):
    id: UUID
    invoiceId: UUID
    createdAt: datetime
    invoice: InvoiceMetadata
    baseline: SupplierView | None
    policy: PolicyResult
    evidence: list[Event]
    verification: list[VerificationView]
    paymentAuthorisation: Literal["OUTSIDE_WORKFLOW"]
    version: int
    executionMode: Execution | None
    aiStatus: AIStatus | None
    provider: str | None
    model: str | None
    verificationRequestedAt: datetime | None = None
    verificationRequestedBy: str | None = None
