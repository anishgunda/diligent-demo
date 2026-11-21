import asyncio
import json
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.dependencies.auth import Controller, Identity
from app.dependencies.database import Pool, tenant
from app.repositories import cases
from app.schemas import BeginInvestigation, InvestigationView, InvoiceView, ReportView, VerificationInput

router = APIRouter(prefix="/api")


@router.post("/investigate", status_code=202)
async def investigate(data: BeginInvestigation, identity: Identity, _pool: Pool, request: Request):
    row = await request.app.state.investigations.start(identity.org, data.invoiceId)
    return {"investigationId": row["id"], "phase": row["status"]}


@router.get("/investigations/{identifier}", response_model=InvestigationView)
async def investigation(identifier: UUID, identity: Identity, pool: Pool):
    async with tenant(pool, identity.org) as conn:
        row = await cases.expire_case(conn, await cases.case_record(conn, identity.org, identifier))
        return await cases.case_view(conn, row)


@router.get("/investigations/{identifier}/events")
async def stream(
    identifier: UUID,
    request: Request,
    identity: Identity,
    pool: Pool,
    after: Annotated[int, Query(ge=0, le=1000000)] = 0,
    last_event_id: Annotated[str | None, Header()] = None,
):
    if last_event_id:
        prefix, _, suffix = last_event_id.rpartition("-")
        if prefix != str(identifier) or not suffix.isascii() or not suffix.isdigit() or len(suffix) > 7:
            raise HTTPException(400, "Invalid investigation cursor.")
        after = max(after, int(suffix))
    org = identity.org
    async with tenant(pool, org) as conn:
        row = await cases.case_record(conn, org, identifier)
        if after > row["sequence_number"]:
            raise HTTPException(400, "Investigation cursor is ahead of the saved stream.")

    async def rows():
        cursor = after
        polls = 0
        while not await request.is_disconnected() and polls < 200:
            async with tenant(pool, org) as conn:
                current = await cases.expire_case(conn, await cases.case_record(conn, org, identifier))
                batch = await cases.events(conn, org, identifier, cursor)
            for item in batch:
                cursor = item["sequence"]
                yield f"id: {item['id']}\ndata: {json.dumps(item, separators=(',', ':'))}\n\n"
            if current["status"] != "running" and cursor >= current["sequence_number"]:
                return
            if polls % 10 == 0:
                yield ": heartbeat\n\n"
            polls += 1
            await asyncio.sleep(1)

    return StreamingResponse(
        rows(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@router.post("/cases/{invoice_id}/verification-request", response_model=InvoiceView)
async def request_verification(invoice_id: UUID, principal: Identity, pool: Pool):
    async with tenant(pool, principal.org) as conn:
        return await cases.request_verification(conn, principal, invoice_id)


@router.post("/cases/{invoice_id}/verify", response_model=InvoiceView)
async def verify(invoice_id: UUID, data: VerificationInput, principal: Controller, pool: Pool):
    async with tenant(pool, principal.org) as conn:
        return await cases.verify_case(conn, principal, invoice_id, data)


@router.get("/reports", response_model=list[ReportView])
async def reports(identity: Identity, pool: Pool):
    async with tenant(pool, identity.org) as conn:
        return await cases.reports(conn, identity.org)


@router.get("/investigations/{identifier}/report", response_model=ReportView)
async def report(identifier: UUID, identity: Identity, pool: Pool):
    async with tenant(pool, identity.org) as conn:
        return await cases.reports(conn, identity.org, identifier)
