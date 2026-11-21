import hashlib
import hmac
import re
from uuid import uuid4

from fastapi import HTTPException
from psycopg import AsyncConnection

from app.config import Settings
from app.dependencies.auth import Principal
from app.schemas import PaymentInput


def redact(value: str) -> str:
    value = re.sub(r"\b[A-Z]{2}[0-9]{2}(?:[ -]?[A-Z0-9]){11,30}\b", "[redacted]", value, flags=re.I)
    value = re.sub(r"\b(?:[0-9][ .-]?){12,19}\b", "[redacted]", value)
    value = re.sub(r"\b(?:[0-9]{2}[- .]){2}[0-9]{2}\b", "[redacted]", value)
    value = re.sub(r"\bsort\s*code\s*[:=]?\s*[0-9]{6}\b", "sort code [redacted]", value, flags=re.I)
    return re.sub(r"\b(?:[0-9]{8}|[0-9]{4}[ -.]+[0-9]{4})\b", "[redacted]", value)


def exposed_payment(identifier="", fingerprint=None, label=None) -> dict:
    return {
        "id": str(identifier),
        "fingerprint": fingerprint or "",
        "sortCode": "••-••-••" if fingerprint else "—",
        "account": label or "—",
    }


async def save_candidate(
    conn: AsyncConnection,
    principal: Principal,
    settings: Settings,
    data: PaymentInput,
) -> dict:
    if not settings.payment_fingerprint_key:
        raise HTTPException(503, "Protected payment intake is not configured.")
    sort_code = re.sub(r"[^0-9]", "", data.sortCode)
    account = re.sub(r"[^0-9]", "", data.account)
    message = f"uk-bacs-v1:{principal.org}:{sort_code}:{account}".encode()
    key = settings.payment_fingerprint_key.get_secret_value().encode()
    fingerprint = hmac.new(key, message, hashlib.sha256).hexdigest()
    identifier = uuid4()
    label = "•••• " + account[-4:]
    await conn.execute(
        """insert into payment_candidates (id,organization_id,created_by,payment_fingerprint,masked_payment_label)
           values (%s,%s,%s,%s,%s)""",
        (identifier, principal.org, principal.user, fingerprint, label),
    )
    return exposed_payment(identifier, fingerprint, label)


async def candidate(conn: AsyncConnection, principal: Principal, identifier):
    result = await conn.execute(
        """select * from payment_candidates where organization_id=%s and id=%s
           and created_by=%s and expires_at>now()""",
        (principal.org, identifier, principal.user),
    )
    row = await result.fetchone()
    if row is None:
        raise HTTPException(404, "Payment destination is unavailable.")
    return row
