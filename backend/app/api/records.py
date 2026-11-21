from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.config import Settings, get_settings
from app.dependencies.auth import Controller, Identity
from app.dependencies.database import Pool, tenant, track_identity
from app.repositories import records
from app.schemas import (
    InvoiceDraft,
    InvoiceView,
    PaymentInput,
    PaymentProposal,
    PaymentView,
    SupplierInput,
    SupplierView,
    VerificationInput,
)
from app.services.payment import exposed_payment, save_candidate

router = APIRouter(prefix="/api")
Config = Annotated[Settings, Depends(get_settings)]


@router.get("/me")
async def me(identity: Identity, pool: Pool):
    async with tenant(pool, identity.org) as conn:
        await track_identity(conn, identity)
    return {
        "name": identity.user,
        "userId": identity.user,
        "role": identity.role,
        "organisation": identity.organisation_name,
        "organisationId": identity.org,
    }


@router.get("/suppliers", response_model=list[SupplierView])
async def suppliers(identity: Identity, pool: Pool):
    async with tenant(pool, identity.org) as conn:
        rows = await records.many(
            conn, "select * from suppliers where organization_id=%s order by company_name", (identity.org,)
        )
        return [await records.supplier_view(conn, row) for row in rows]


@router.post("/suppliers", status_code=201, response_model=SupplierView)
async def create_supplier(data: SupplierInput, identity: Identity, pool: Pool):
    async with tenant(pool, identity.org) as conn:
        await track_identity(conn, identity)
        return await records.save_supplier(conn, identity.org, data)


@router.patch("/suppliers/{supplier_id}", response_model=SupplierView)
async def update_supplier(supplier_id: UUID, data: SupplierInput, identity: Identity, pool: Pool):
    async with tenant(pool, identity.org) as conn:
        return await records.save_supplier(conn, identity.org, data, supplier_id)


@router.get("/suppliers/{supplier_id}/payment-options", response_model=list[PaymentView])
async def payment_options(supplier_id: UUID, identity: Identity, pool: Pool):
    async with tenant(pool, identity.org) as conn:
        await records.supplier_record(conn, identity.org, supplier_id)
        rows = await records.many(
            conn,
            """select * from payment_candidates
            where organization_id=%s and created_by=%s and expires_at>now()
            order by expires_at desc limit 50""",
            (identity.org, identity.user),
        )
        return [
            exposed_payment(row["id"], row["payment_fingerprint"], row["masked_payment_label"]) for row in rows
        ]


@router.post("/payment-candidates", status_code=201, response_model=PaymentView)
async def payment_candidate(data: PaymentInput, identity: Identity, pool: Pool, settings: Config):
    async with tenant(pool, identity.org) as conn:
        await track_identity(conn, identity)
        return await save_candidate(conn, identity, settings, data)


@router.post("/suppliers/{supplier_id}/payment-proposals", status_code=201, response_model=SupplierView)
async def propose_payment(supplier_id: UUID, data: PaymentProposal, identity: Identity, pool: Pool):
    async with tenant(pool, identity.org) as conn:
        return await records.propose_payment(conn, identity, supplier_id, data.paymentId)


@router.post("/suppliers/{supplier_id}/payment-proposals/{proposal_id}/approve", response_model=SupplierView)
async def approve_payment(
    supplier_id: UUID,
    proposal_id: UUID,
    data: VerificationInput,
    principal: Controller,
    pool: Pool,
):
    async with tenant(pool, principal.org) as conn:
        return await records.approve_payment(conn, principal, supplier_id, proposal_id, data)


@router.post("/invoices", status_code=201, response_model=InvoiceView)
async def create_invoice(data: InvoiceDraft, identity: Identity, pool: Pool):
    async with tenant(pool, identity.org) as conn:
        await track_identity(conn, identity)
        return records.invoice_view(await records.save_invoice(conn, identity, data))


@router.get("/invoices", response_model=list[InvoiceView])
async def invoices(identity: Identity, pool: Pool):
    from app.repositories.cases import list_invoices

    async with tenant(pool, identity.org) as conn:
        return await list_invoices(conn, identity.org)


@router.get("/invoices/{invoice_id}", response_model=InvoiceView)
async def invoice(invoice_id: UUID, identity: Identity, pool: Pool):
    from app.repositories.cases import full_invoice

    async with tenant(pool, identity.org) as conn:
        return await full_invoice(conn, identity.org, invoice_id)


@router.get("/invoices/{invoice_id}/document")
async def document(invoice_id: UUID, identity: Identity, pool: Pool, request: Request):
    async with tenant(pool, identity.org) as conn:
        row = await records.invoice_record(conn, identity.org, invoice_id)
        path = row["document_storage_path"]
    if not path:
        raise HTTPException(404, "Invoice document not found.")
    contents = await request.app.state.storage.download(identity.org, path)
    return Response(
        contents,
        media_type="application/pdf",
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": "attachment; filename=invoice.pdf",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/evals")
async def evaluations(_identity: Identity):
    # Synthetic fixture performance is kept exclusively in the mock adapter.
    return []
