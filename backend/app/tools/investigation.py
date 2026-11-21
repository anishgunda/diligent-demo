import re
from difflib import SequenceMatcher
from time import monotonic
from uuid import UUID

import dns.asyncresolver
import dns.exception
import httpx

from app.config import Settings
from app.dependencies.database import tenant
from app.llm.base import Provider
from app.repositories.records import many
from app.schemas import ToolEvidence
from app.services.payment import redact

DESCRIPTIONS = {
    "inspect_sender_domain": "Compare the sender domain with the trusted domain and obtain live DNS/MX observations.",
    "lookup_companies_house": "Look up the invoice's claimed company number in the UK public registry.",
    "analyze_message_pretext": "Analyse the accompanying redacted sender message for pressure or bypass language.",
    "get_supplier_history": "Retrieve organisation-scoped historical observations for the matched supplier.",
}

TOOL_SCHEMAS = {
    name: {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        },
    }
    for name, description in DESCRIPTIONS.items()
}


def evidence(name, summary, provenance, result=None, *, status="success", availability="live", error=None):
    return ToolEvidence(
        tool=name,
        status=status,
        summary=summary,
        provenance=provenance,
        result=result or {},
        availability=availability,
        error=error,
    )


def unavailable(name, reason, provenance, result=None):
    return evidence(
        name, reason, provenance, result, status="unavailable", availability="unavailable", error=reason
    )


async def inspect_domain(invoice, baseline):
    name, source = "inspect_sender_domain", "Public DNS resolver and trusted supplier snapshot"
    domain = invoice["senderEmail"].rpartition("@")[2].lower()
    trusted = (baseline or {}).get("domain", "").lower()
    result = {"domain": domain, "trustedDomain": trusted, "matchesTrusted": bool(trusted and domain == trusted)}
    normalize = str.maketrans({"0": "o", "1": "l", "5": "s", "8": "b"})
    result["lookalikeHeuristic"] = bool(
        trusted
        and domain != trusted
        and SequenceMatcher(None, domain.translate(normalize), trusted).ratio() >= 0.83
    )
    labels = domain.split(".")
    if (
        len(domain) > 253
        or len(labels) < 2
        or not labels[-1].isalpha()
        or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels)
    ):
        return unavailable(name, "A valid public sender domain is missing.", source, result)
    if labels[-1] in {"example", "test", "invalid", "localhost", "local", "internal", "onion"} or domain in {
        "example.com",
        "example.org",
        "example.net",
    }:
        return evidence(
            name,
            "Fictional or reserved sender domain. Public DNS was skipped.",
            source,
            result,
            status="unavailable",
            availability="fixture",
        )
    try:
        answer = await dns.asyncresolver.resolve(domain + ".", "MX", lifetime=3, search=False)
        result["mx"] = [str(item.exchange).rstrip(".") for item in answer][:8]
        return evidence(
            name, "Public MX records observed. DNS does not authenticate the email.", source, result
        )
    except dns.asyncresolver.NXDOMAIN:
        result["dnsStatus"] = "NXDOMAIN"
        return evidence(name, "Public DNS returned NXDOMAIN for the sender domain.", source, result)
    except dns.asyncresolver.NoAnswer:
        result["dnsStatus"] = "NO_MX"
        return evidence(
            name, "Public DNS returned no MX record. Email authenticity remains unverified.", source, result
        )
    except dns.exception.DNSException:
        return unavailable(name, "Public DNS could not be queried.", source, result)


async def companies_house(settings: Settings, invoice: dict, client: httpx.AsyncClient):
    name, source = "lookup_companies_house", "UK Companies House API"
    number = invoice["companyNumber"].upper()
    if not settings.companies_house_api_key or not re.fullmatch(r"[A-Z0-9]{8}", number):
        return unavailable(name, "Companies House credentials or a valid company number are missing.", source)
    response = await client.get(
        f"https://api.company-information.service.gov.uk/company/{number}",
        auth=(settings.companies_house_api_key.get_secret_value(), ""),
        timeout=5,
    )
    if response.status_code == 404:
        return evidence(
            name,
            "No company profile was returned for the supplied number.",
            source,
            {"companyNumber": number, "found": False},
        )
    if response.status_code != 200:
        return unavailable(name, "The public registry request was unsuccessful.", source)
    raw = response.json()
    result = {
        "companyNumber": number,
        "found": True,
        "registeredName": redact(str(raw.get("company_name", "")))[:160],
        "companyStatus": str(raw.get("company_status", ""))[:40],
    }
    return evidence(
        name, "Public company profile retrieved. This does not verify bank-account ownership.", source, result
    )


async def history(pool, org, baseline):
    name, source = "get_supplier_history", "Organisation invoice history"
    if not baseline:
        return unavailable(name, "A supplier match is required to retrieve history.", source)
    async with tenant(pool, org) as conn:
        rows = await many(
            conn,
            """select id, invoice_number, invoice_date, claimed_payment_fingerprint,
            masked_payment_label from invoices where organization_id=%s and supplier_id=%s
            order by created_at desc,id desc limit 8""",
            (org, UUID(baseline["id"])),
        )
    reference = (baseline.get("payment") or {}).get("fingerprint")
    result = [
        {
            "invoiceId": str(row["id"]),
            "invoiceNumber": row["invoice_number"],
            "date": row["invoice_date"].isoformat(),
            "destination": row["masked_payment_label"],
            "matchesCurrentBaseline": bool(reference and row["claimed_payment_fingerprint"] == reference),
        }
        for row in rows
    ]
    return evidence(
        name,
        f"Retrieved {len(rows)} earlier or current organisation invoice observations.",
        source,
        {"invoices": result},
    )


async def execute_tool(name, args, *, invoice, baseline, pool, org, settings, client, provider: Provider):
    started = monotonic()
    source = "Bound investigation tool"
    try:
        if args != {} or name not in DESCRIPTIONS:
            result = unavailable(
                name if name in DESCRIPTIONS else "unknown_tool",
                "Unrecognised tool or arguments. Tool execution was skipped.",
                source,
            )
        elif name == "inspect_sender_domain":
            result = await inspect_domain(invoice, baseline)
        elif name == "lookup_companies_house":
            result = await companies_house(settings, invoice, client)
        elif name == "get_supplier_history":
            result = await history(pool, org, baseline)
        elif not invoice["message"]:
            result = unavailable(name, "No accompanying sender message was supplied.", source)
        else:
            observations = await provider.pretext(invoice["message"][:2400])
            result = evidence(
                name,
                redact(observations.summary),
                "Configured Grok model and redacted sender message",
                {"observations": [redact(item[:320]) for item in observations.observations]},
            )
    except Exception:
        result = evidence(
            name,
            "The tool could not complete.",
            source,
            status="error",
            availability="unavailable",
            error="Tool execution failed or timed out.",
        )
    return result.model_copy(update={"latencyMs": int((monotonic() - started) * 1000)})
