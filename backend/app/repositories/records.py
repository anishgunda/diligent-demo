from uuid import uuid4

from fastapi import HTTPException
from psycopg import AsyncConnection, errors
from psycopg.types.json import Jsonb

from app.dependencies.auth import Principal
from app.schemas import InvoiceDraft, SupplierInput
from app.services.payment import candidate, exposed_payment, redact


async def one(conn: AsyncConnection, query: str, args=(), *, missing=False):
    row = await (await conn.execute(query, args)).fetchone()
    if row is None and missing:
        raise HTTPException(404, "Record not found.")
    return row


async def many(conn: AsyncConnection, query: str, args=()):
    return await (await conn.execute(query, args)).fetchall()


def payment(row) -> dict:
    return exposed_payment(row["id"], row["payment_fingerprint"], row["masked_payment_label"])


async def supplier_record(conn, org, identifier, *, lock=False):
    return await one(
        conn,
        "select * from suppliers where organization_id=%s and id=%s" + (" for update" if lock else ""),
        (org, identifier),
        missing=True,
    )


async def supplier_view(conn, row, *, history=True):
    rows = await many(
        conn,
        """select * from trusted_supplier_payment_records where organization_id=%s and supplier_id=%s
        order by proposed_at desc,id desc""",
        (row["organization_id"], row["id"]),
    )
    active = next((item for item in rows if item["status"] == "VERIFIED"), None)
    status = {"PENDING": "Pending independent verification", "VERIFIED": "Verified", "SUPERSEDED": "Superseded"}
    return {
        "id": str(row["id"]),
        "name": row["company_name"] if history else row["verified_company_name"] or row["company_name"],
        "companyNumber": row["company_number"],
        "domain": row["trusted_email_domain"],
        "signer": row["trusted_contact_reference"],
        "payment": payment(active) if active else None,
        "verifiedAt": row["verified_at"].isoformat() if row["verified_at"] else None,
        "trustedSource": row["verification_source"],
        "changes": [
            {
                "id": str(item["id"]),
                "proposedAt": item["proposed_at"].isoformat(),
                "previous": item["previous_payment"],
                "proposed": payment(item),
                "reviewer": item["proposed_by"],
                "status": status[item["status"]],
                "approvedBy": item["approved_by"],
            }
            for item in rows
        ]
        if history
        else [],
    }


async def save_supplier(conn, org, data: SupplierInput, identifier=None):
    values = (redact(data.name), data.companyNumber.upper(), data.domain.lower(), redact(data.signer))
    try:
        if identifier:
            current = await supplier_record(conn, org, identifier, lock=True)
            if current["verified_at"] and values[1:] != (
                current["company_number"],
                current["trusted_email_domain"],
                current["trusted_contact_reference"],
            ):
                raise HTTPException(409, "Verified identity fields are locked.")
            row = await one(
                conn,
                """update suppliers set company_name=%s, company_number=%s,
                trusted_email_domain=%s, trusted_contact_reference=%s where organization_id=%s and id=%s
                returning *""",
                (*values, org, identifier),
            )
        else:
            row = await one(
                conn,
                """insert into suppliers
                (id,organization_id,company_name,company_number,trusted_email_domain,trusted_contact_reference)
                values (%s,%s,%s,%s,%s,%s) returning *""",
                (uuid4(), org, *values),
            )
    except errors.UniqueViolation:
        raise HTTPException(409, "A supplier already uses this company number.") from None
    return await supplier_view(conn, row)


async def propose_payment(conn, principal, supplier_id, candidate_id):
    org = principal.org
    supplier = await supplier_record(conn, org, supplier_id, lock=True)
    new = await candidate(conn, principal, candidate_id)
    current = await supplier_view(conn, supplier, history=False)
    fingerprint = new["payment_fingerprint"]
    if current["payment"] and current["payment"]["fingerprint"] == fingerprint:
        raise HTTPException(409, "This payment destination is already verified.")
    try:
        await conn.execute(
            """insert into trusted_supplier_payment_records
               (id,organization_id,supplier_id,payment_fingerprint,masked_payment_label,status,
                proposed_by,previous_payment) values (%s,%s,%s,%s,%s,'PENDING',%s,%s)""",
            (
                uuid4(),
                org,
                supplier_id,
                fingerprint,
                new["masked_payment_label"],
                principal.user,
                Jsonb(current["payment"]),
            ),
        )
    except errors.UniqueViolation:
        raise HTTPException(409, "This payment destination is already pending.") from None
    return await supplier_view(conn, supplier)


async def approve_payment(conn, principal, supplier_id, proposal_id, review):
    org = principal.org
    supplier = await supplier_record(conn, org, supplier_id, lock=True)
    proposal = await one(
        conn,
        """select * from trusted_supplier_payment_records
        where organization_id=%s and supplier_id=%s and id=%s for update""",
        (org, supplier_id, proposal_id),
        missing=True,
    )
    if proposal["proposed_by"] == principal.user:
        raise HTTPException(403, "The proposer cannot approve their own payment change.")
    if proposal["status"] != "PENDING" or review.outcome != "CONFIRMED_LEGITIMATE":
        raise HTTPException(409, "Only an independently confirmed pending proposal can be approved.")
    if not supplier["trusted_email_domain"] or not supplier["trusted_contact_reference"]:
        raise HTTPException(409, "Record the trusted domain and contact before approving this baseline.")
    current = await supplier_view(conn, supplier, history=False)
    old = proposal["previous_payment"]
    if (old or {}).get("id") != (current["payment"] or {}).get("id"):
        raise HTTPException(409, "The baseline has changed since proposal. Record a new proposal.")
    source = redact(review.trustedContactSource)
    reference = f"{review.method} | {source} | {redact(review.notes)}"
    await conn.execute(
        """update trusted_supplier_payment_records set status='SUPERSEDED'
           where organization_id=%s and supplier_id=%s and status='VERIFIED'""",
        (org, supplier_id),
    )
    await conn.execute(
        """update trusted_supplier_payment_records set status='VERIFIED',approved_by=%s,
           verified_at=now(),verification_reference=%s where organization_id=%s and id=%s""",
        (principal.user, reference, org, proposal_id),
    )
    row = await one(
        conn,
        """update suppliers set verification_status='VERIFIED',verified_at=now(),
        verified_company_name=coalesce(verified_company_name,company_name),
        verification_source=%s where organization_id=%s and id=%s returning *""",
        (f"{review.method} · {source}", org, supplier_id),
    )
    return await supplier_view(conn, row)


def invoice_view(row, investigation=None):
    return {
        "id": str(row["id"]),
        "supplierId": str(row["supplier_id"]) if row["supplier_id"] else None,
        "supplierName": row["claimed_supplier"],
        "companyNumber": row["claimed_company_number"],
        "invoiceNumber": row["invoice_number"],
        "amount": float(row["amount"]),
        "invoiceDate": row["invoice_date"].isoformat(),
        "dueDate": row["due_date"].isoformat(),
        "senderEmail": row["claimed_sender"],
        "signer": row["claimed_signer"],
        "payment": exposed_payment("", row["claimed_payment_fingerprint"], row["masked_payment_label"]),
        "paymentReference": row["payment_reference"],
        "message": row["message_redacted"],
        "source": row["intake_source"],
        "createdAt": row["created_at"].isoformat(),
        "investigation": investigation,
        "hasDocument": bool(row["document_storage_path"]),
    }


async def invoice_record(conn, org, identifier, *, lock=False):
    return await one(
        conn,
        "select * from invoices where organization_id=%s and id=%s" + (" for update" if lock else ""),
        (org, identifier),
        missing=True,
    )


async def save_invoice(conn, principal: Principal, data: InvoiceDraft):
    org = principal.org
    upload = None
    if data.extractionId:
        upload = await one(
            conn,
            """select * from invoice_uploads where organization_id=%s and id=%s
            and uploaded_by=%s and expires_at>now() for update""",
            (org, data.extractionId, principal.user),
            missing=True,
        )
        existing = await one(
            conn, "select * from invoices where organization_id=%s and upload_id=%s", (org, data.extractionId)
        )
        if existing:
            return existing
    destination = await candidate(conn, principal, data.paymentId) if data.paymentId else None
    baseline = await one(
        conn,
        """select id from suppliers where organization_id=%s and
        (company_number=%s or lower(company_name)=lower(%s))
        order by (company_number=%s) desc,created_at,id limit 1""",
        (org, data.companyNumber.upper(), redact(data.supplierName), data.companyNumber.upper()),
    )
    return await one(
        conn,
        """insert into invoices
        (id,organization_id,supplier_id,invoice_number,claimed_supplier,claimed_company_number,
         amount,invoice_date,due_date,claimed_sender,claimed_signer,claimed_payment_fingerprint,
         masked_payment_label,payment_reference,message_redacted,document_storage_path,upload_id)
        values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning *""",
        (
            uuid4(),
            org,
            baseline["id"] if baseline else None,
            redact(data.invoiceNumber),
            redact(data.supplierName),
            data.companyNumber.upper(),
            data.amount,
            data.invoiceDate,
            data.dueDate,
            redact(data.senderEmail),
            redact(data.signer),
            destination["payment_fingerprint"] if destination else None,
            destination["masked_payment_label"] if destination else None,
            redact(data.paymentReference),
            redact(data.message),
            upload["storage_path"] if upload else None,
            data.extractionId,
        ),
    )
