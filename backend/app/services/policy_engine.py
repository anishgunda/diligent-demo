import re

from app.schemas import PolicyCheck, PolicyResult

HOLD = "HOLD_FOR_VERIFICATION"
CLEAR = "NO_NEW_FLAGS"
REJECT = "REJECT_PAYMENT_REQUEST"


def compare_identity(invoice: dict, baseline: dict | None) -> list[PolicyCheck]:
    baseline = baseline or {}
    sender = invoice["senderEmail"].rpartition("@")[2].lower()
    claimed_payment = invoice["payment"]["fingerprint"]
    known_payment = (baseline.get("payment") or {}).get("fingerprint")
    pressure = re.search(
        r"\b(?:do not call|ignore verification|bypass approval|skip verification)\b",
        invoice.get("message", ""),
        re.I,
    )
    return [
        PolicyCheck(
            label="Trusted supplier baseline",
            state="pass" if baseline.get("verifiedAt") else "unknown",
            detail="Verified organisation record found."
            if baseline.get("verifiedAt")
            else "Independent supplier onboarding is missing.",
        ),
        compare("Supplier identity", invoice["supplierName"], baseline.get("name")),
        compare("Company number", invoice["companyNumber"], baseline.get("companyNumber")),
        compare("Sender domain", sender, baseline.get("domain")),
        compare("Claimed signer", invoice["signer"], baseline.get("signer")),
        compare("Payment destination", claimed_payment, known_payment),
        PolicyCheck(
            label="Verification bypass",
            state="flag" if pressure else "pass",
            detail="Message solicits bypass of verification."
            if pressure
            else "No explicit request to bypass verification was detected.",
        ),
    ]


def compare(label: str, incoming: str | None, trusted: str | None) -> PolicyCheck:
    if not incoming or not trusted:
        return PolicyCheck(label=label, state="unknown", detail="A claim or trusted reference is missing.")
    state = "pass" if incoming.casefold() == trusted.casefold() else "flag"
    return PolicyCheck(
        label=label,
        state=state,
        detail=(
            "Matches the trusted supplier record."
            if state == "pass"
            else "Differs from the trusted supplier record."
        ),
    )


def evaluate(
    mandatory: list[PolicyCheck],
    *,
    execution: str,
    verification: dict | None = None,
    additional: list[PolicyCheck] | None = None,
) -> PolicyResult:
    checks = [*mandatory, *(additional or [])]
    unresolved = [
        check.label
        for check in checks
        if check.state != "pass" and (check.label != "Claimed signer" or check.state != "unknown")
    ]
    outcome = verification.get("outcome") if verification else None
    if verification:
        checks.append(
            PolicyCheck(
                label="Independent human verification",
                state={"CONFIRMED_LEGITIMATE": "pass", "CONFIRMED_FRAUD": "flag"}.get(outcome, "unknown"),
                detail=verification["method"] + " · " + outcome.lower().replace("_", " "),
            )
        )
    if outcome == "CONFIRMED_FRAUD":
        return PolicyResult(
            verdict=REJECT,
            checks=checks,
            missing=[],
            summary="Independent verification confirmed fraud.",
            nextAction="Escalate to the finance incident owner and preserve the evidence.",
        )
    if outcome == "CONFIRMED_LEGITIMATE":
        # A callback may corroborate a specified changed destination. An absent
        # baseline, missing destination or identity flag still requires evidence.
        payment = next((check for check in mandatory if check.label == "Payment destination"), None)
        if payment and payment.state == "flag":
            unresolved.remove(payment.label)
    if outcome == "INCONCLUSIVE":
        unresolved.append("Conclusive independent verification")
    if execution == "RULES_ONLY" and unresolved:
        unresolved.append("Optional AI checks unavailable")
    if unresolved:
        return PolicyResult(
            verdict=HOLD,
            checks=checks,
            missing=unresolved,
            summary="The available evidence requires independent verification.",
            nextAction="Verify through a trusted contact and resolve the outstanding evidence.",
        )
    return PolicyResult(
        verdict=CLEAR,
        checks=checks,
        missing=[],
        summary="The mandatory supplier and payment checks have no unresolved discrepancies.",
        nextAction="Route through the separate payment approval workflow.",
    )
