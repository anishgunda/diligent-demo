from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from app.repositories.records import invoice_record, invoice_view, many, one, supplier_record, supplier_view
from app.schemas import Event, PolicyCheck, PolicyResult
from app.services.payment import redact
from app.services.policy_engine import HOLD, evaluate


async def case_record(conn, org, identifier, *, lock=False):
    return await one(
        conn,
        "select * from investigations where organization_id=%s and id=%s" + (" for update" if lock else ""),
        (org, identifier),
        missing=True,
    )


async def latest_case(conn, org, invoice_id):
    return await one(
        conn,
        """select * from investigations where organization_id=%s and invoice_id=%s
        order by started_at desc,id desc limit 1""",
        (org, invoice_id),
    )


async def events(conn, org, identifier, after=0):
    rows = await many(
        conn,
        """select structured_payload from investigation_events
        where organization_id=%s and investigation_id=%s and sequence_number>%s order by sequence_number""",
        (org, identifier, after),
    )
    return [row["structured_payload"] for row in rows]


async def verification_history(conn, org, identifier):
    rows = await many(
        conn,
        """select * from verification_events where organization_id=%s and investigation_id=%s
        order by timestamp,id""",
        (org, identifier),
    )
    return [
        {
            "method": row["verification_method"],
            "outcome": row["verification_outcome"],
            "trustedContactSource": row["trusted_contact_source"],
            "reviewer": row["reviewer_id"],
            "notes": row["notes"],
            "timestamp": row["timestamp"].isoformat(),
        }
        for row in rows
    ]


async def expire_case(conn, row):
    if row["status"] != "running" or row["expires_at"] > datetime.now(UTC):
        return row
    return await fail_case(
        conn,
        row["organization_id"],
        row["id"],
        "The investigation was interrupted or exceeded its time limit. Run it again.",
    )


async def case_view(conn, row, *, detail=True):
    org, identifier = row["organization_id"], row["id"]
    return {
        "id": str(identifier),
        "phase": row["status"],
        "baseline": row["baseline"],
        "events": await events(conn, org, identifier) if detail else [],
        "verification": await verification_history(conn, org, identifier) if detail else [],
        "result": row["policy_result"],
        "startedAt": row["started_at"].isoformat(),
        "executionMode": row["execution_mode"],
        "aiStatus": row["ai_status"],
        "provider": row["provider"],
        "model": row["model"],
        "verificationRequestedAt": row["verification_requested_at"],
        "verificationRequestedBy": row["verification_requested_by"],
    }


async def list_invoices(conn, org):
    rows = await many(
        conn,
        """select i.*, c.id as case_id from invoices i left join lateral (
         select id from investigations where organization_id=i.organization_id and invoice_id=i.id
         order by started_at desc,id desc limit 1
        ) c on true where i.organization_id=%s order by i.created_at desc,i.id desc""",
        (org,),
    )
    output = []
    for row in rows:
        identifier = row["case_id"]
        record = await expire_case(conn, await case_record(conn, org, identifier)) if identifier else None
        output.append(invoice_view(row, await case_view(conn, record, detail=False) if record else None))
    return output


async def full_invoice(conn, org, invoice_id):
    invoice = await invoice_record(conn, org, invoice_id)
    row = await latest_case(conn, org, invoice_id)
    return invoice_view(invoice, await case_view(conn, await expire_case(conn, row)) if row else None)


async def begin_case(conn, org, invoice_id, timeout):
    invoice = await invoice_record(conn, org, invoice_id, lock=True)
    current = await latest_case(conn, org, invoice_id)
    if current:
        current = await expire_case(conn, current)
        if current["status"] != "error":
            return current, False
    supplier_id = invoice["supplier_id"]
    if not supplier_id:
        match = await one(
            conn,
            """select id from suppliers where organization_id=%s and
            (company_number=%s or lower(company_name)=lower(%s))
            order by (company_number=%s) desc,created_at,id limit 1""",
            (
                org,
                invoice["claimed_company_number"],
                invoice["claimed_supplier"],
                invoice["claimed_company_number"],
            ),
        )
        supplier_id = match["id"] if match else None
        if supplier_id:
            await conn.execute(
                "update invoices set supplier_id=%s where organization_id=%s and id=%s",
                (supplier_id, org, invoice_id),
            )
    baseline = (
        await supplier_view(conn, await supplier_record(conn, org, supplier_id), history=False)
        if supplier_id
        else None
    )
    row = await one(
        conn,
        """insert into investigations (id,organization_id,invoice_id,status,baseline,expires_at)
        values (%s,%s,%s,'running',%s,%s) returning *""",
        (uuid4(), org, invoice_id, Jsonb(baseline), datetime.now(UTC) + timedelta(seconds=timeout + 15)),
    )
    await conn.execute(
        "update invoices set status='INVESTIGATING' where organization_id=%s and id=%s", (org, invoice_id)
    )
    await append_event(
        conn,
        org,
        row["id"],
        "investigation_started",
        "running",
        "Investigation queued for evidence collection.",
        "Case service",
    )
    return row, True


async def append_event(conn, org, identifier, kind, status, finding, source, *, evidence=None, **metadata):
    row = await one(
        conn,
        """update investigations set sequence_number=sequence_number+1
        where organization_id=%s and id=%s and status='running' returning sequence_number""",
        (org, identifier),
        missing=True,
    )
    sequence = row["sequence_number"]
    event = Event(
        id=f"{identifier}-{sequence}",
        investigationId=identifier,
        sequence=sequence,
        timestamp=datetime.now(UTC),
        type=kind,
        status=status,
        finding=finding,
        source=source,
        **metadata,
    )
    await conn.execute(
        """insert into investigation_events (id,organization_id,investigation_id,sequence_number,event_type,status,
            tool_name,summary,structured_payload,provenance,timestamp) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (
            event.id,
            org,
            identifier,
            sequence,
            event.type,
            event.status,
            event.tool,
            event.finding,
            Jsonb(event.model_dump(mode="json")),
            event.source,
            event.timestamp,
        ),
    )
    if evidence:
        await conn.execute(
            """insert into evidence_records (organization_id,investigation_id,sequence_number,tool_name,
            evidence_type,source,structured_result,observed_at,status) values (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (
                org,
                identifier,
                sequence,
                evidence.tool,
                evidence.availability,
                evidence.provenance,
                Jsonb(evidence.model_dump(mode="json")),
                event.timestamp,
                evidence.status,
            ),
        )
    return event.id


async def fail_case(conn, org, identifier, reason):
    current = await case_record(conn, org, identifier)
    await invoice_record(conn, org, current["invoice_id"], lock=True)
    row = await case_record(conn, org, identifier, lock=True)
    if row["status"] != "running":
        return row
    await append_event(
        conn,
        org,
        identifier,
        "investigation_failed",
        "error",
        reason,
        "Case service",
        payload={"code": "INVESTIGATION_FAILED"},
    )
    await conn.execute(
        "update invoices set status='QUEUED' where organization_id=%s and id=%s", (org, row["invoice_id"])
    )
    return await one(
        conn,
        """update investigations set status='error',ai_status='FAILED',finished_at=now()
        where organization_id=%s and id=%s returning *""",
        (org, identifier),
    )


async def persist_report(conn, org, row):
    identifier = row["id"]
    invoice = invoice_view(await invoice_record(conn, org, row["invoice_id"]))
    invoice.pop("message")
    invoice.pop("investigation")
    prior = await one(
        conn,
        """select coalesce(max(report_version),0) as version from audit_reports
        where organization_id=%s and investigation_id=%s""",
        (org, identifier),
    )
    report = {
        "id": str(identifier),
        "invoiceId": str(row["invoice_id"]),
        "createdAt": datetime.now(UTC).isoformat(),
        "invoice": invoice,
        "baseline": row["baseline"],
        "policy": row["policy_result"],
        "evidence": await events(conn, org, identifier),
        "verification": await verification_history(conn, org, identifier),
        "paymentAuthorisation": "OUTSIDE_WORKFLOW",
        "version": prior["version"] + 1,
        "executionMode": row["execution_mode"],
        "aiStatus": row["ai_status"],
        "provider": row["provider"],
        "model": row["model"],
        "verificationRequestedAt": row["verification_requested_at"].isoformat()
        if row["verification_requested_at"]
        else None,
        "verificationRequestedBy": row["verification_requested_by"],
    }
    await conn.execute(
        """insert into audit_reports (id,organization_id,investigation_id,report_version,report_payload)
        values (%s,%s,%s,%s,%s)""",
        (uuid4(), org, identifier, report["version"], Jsonb(report)),
    )
    return report


async def change_verdict(conn, org, row, policy: PolicyResult):
    await conn.execute(
        "update invoices set status=%s where organization_id=%s and id=%s",
        (policy.verdict, org, row["invoice_id"]),
    )
    return await one(
        conn,
        """update investigations set policy_verdict=%s,policy_result=%s
        where organization_id=%s and id=%s returning *""",
        (policy.verdict, Jsonb(policy.model_dump()), org, row["id"]),
    )


async def finish_case(conn, org, identifier, checks, policy, execution, ai_status, provider, model):
    current = await case_record(conn, org, identifier)
    await invoice_record(conn, org, current["invoice_id"], lock=True)
    row = await case_record(conn, org, identifier, lock=True)
    if row["status"] != "running":
        return
    meta = {"executionMode": execution, "provider": provider, "model": model}
    await append_event(
        conn,
        org,
        identifier,
        "policy_evaluated",
        "success",
        policy.summary,
        "Deterministic policy engine",
        payload=policy.model_dump(),
        **meta,
    )
    summary = "Investigation evidence and audit report saved."
    if execution == "RULES_ONLY":
        summary = (
            "AI investigation is currently unavailable. Mandatory supplier and payment checks "
            "were performed using deterministic rules."
        )
    await append_event(
        conn,
        org,
        identifier,
        "investigation_completed",
        "success",
        summary,
        "Case service",
        payload={"aiStatus": ai_status},
        **meta,
    )
    row = await one(
        conn,
        """update investigations set status='completed',execution_mode=%s,ai_status=%s,
         provider=%s,model=%s,mandatory_checks=%s,finished_at=now()
         where organization_id=%s and id=%s returning *""",
        (
            execution,
            ai_status,
            provider,
            model,
            Jsonb([check.model_dump() for check in checks]),
            org,
            identifier,
        ),
    )
    row = await change_verdict(conn, org, row, policy)
    await persist_report(conn, org, row)


async def held_case(conn, org, invoice_id):
    await invoice_record(conn, org, invoice_id, lock=True)
    current = await latest_case(conn, org, invoice_id)
    if current is None:
        raise HTTPException(409, "Run the investigation before recording verification.")
    row = await case_record(conn, org, current["id"], lock=True)
    if row["status"] != "completed" or row["policy_verdict"] != HOLD:
        raise HTTPException(409, "Only a completed held case can be independently verified.")
    return row


async def request_verification(conn, principal, invoice_id):
    org = principal.org
    row = await held_case(conn, org, invoice_id)
    if not row["verification_requested_at"]:
        row = await one(
            conn,
            """update investigations set verification_requested_at=now(),
            verification_requested_by=%s where organization_id=%s and id=%s returning *""",
            (principal.user, org, row["id"]),
        )
        await persist_report(conn, org, row)
    return await full_invoice(conn, org, invoice_id)


async def verify_case(conn, principal, invoice_id, input_data):
    org = principal.org
    row = await held_case(conn, org, invoice_id)
    await conn.execute(
        """insert into verification_events (id,organization_id,investigation_id,reviewer_id,
        verification_method,verification_outcome,trusted_contact_source,notes) values (%s,%s,%s,%s,%s,%s,%s,%s)""",
        (
            uuid4(),
            org,
            row["id"],
            principal.user,
            input_data.method,
            input_data.outcome,
            redact(input_data.trustedContactSource),
            redact(input_data.notes),
        ),
    )
    policy = evaluate(
        [PolicyCheck.model_validate(check) for check in row["mandatory_checks"]],
        execution=row["execution_mode"],
        verification=input_data.model_dump(),
    )
    row = await change_verdict(conn, org, row, policy)
    await persist_report(conn, org, row)
    return await full_invoice(conn, org, invoice_id)


async def reports(conn, org, identifier=None):
    if identifier:
        row = await one(
            conn,
            """select report_payload from audit_reports where organization_id=%s
            and investigation_id=%s order by report_version desc limit 1""",
            (org, identifier),
            missing=True,
        )
        return row["report_payload"]
    rows = await many(
        conn,
        """select report_payload from (select distinct on (investigation_id)
        investigation_id, report_payload, created_at from audit_reports where organization_id=%s
        order by investigation_id,report_version desc) latest order by created_at desc""",
        (org,),
    )
    return [row["report_payload"] for row in rows]
