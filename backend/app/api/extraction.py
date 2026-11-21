from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from app.api.records import Config
from app.dependencies.auth import Identity
from app.dependencies.database import Pool, tenant, track_identity
from app.schemas import PaymentInput
from app.services.extraction import extract_in_worker
from app.services.payment import redact, save_candidate
from app.services.storage import MAX_PDF

router = APIRouter(prefix="/api")


@router.post("/extract")
async def extract(
    request: Request,
    identity: Identity,
    pool: Pool,
    settings: Config,
    file: Annotated[UploadFile, File()],
    senderEmail: Annotated[str, Form(max_length=160)] = "",
    message: Annotated[str, Form(max_length=4000)] = "",
    sample: Annotated[bool, Form()] = False,
):
    if sample:
        raise HTTPException(422, "Sample extraction is available in mock mode.")
    if file.content_type != "application/pdf":
        raise HTTPException(415, "Upload a PDF document.")
    contents = await file.read(MAX_PDF + 1)
    if len(contents) > MAX_PDF:
        raise HTTPException(413, "The PDF exceeds 15 MB.")
    if not contents.startswith(b"%PDF-"):
        raise HTTPException(415, "The uploaded file does not have a PDF header.")
    gate = request.app.state.extraction_slots
    if gate.locked():
        raise HTTPException(429, "Extraction is busy. Try again shortly.")
    async with gate:
        result = await extract_in_worker(contents)
    if "error" in result:
        raise HTTPException(422, result["error"])
    draft = result["draft"]
    sort_code, account = draft.pop("sortCode"), draft.pop("account")
    identifier = uuid4()
    path = f"{identity.org}/{identifier}.pdf"
    storage = request.app.state.storage
    await storage.upload(identity.org, path, contents)
    options = []
    try:
        async with tenant(pool, identity.org) as conn:
            await track_identity(conn, identity)
            await conn.execute(
                "insert into invoice_uploads (id,organization_id,uploaded_by,storage_path) values (%s,%s,%s,%s)",
                (identifier, identity.org, identity.user, path),
            )
            if sort_code and account:
                options = [
                    await save_candidate(
                        conn,
                        identity,
                        settings,
                        PaymentInput(
                            sortCode=sort_code.replace(" ", "").replace("-", ""),
                            account=account,
                        ),
                    )
                ]
    except Exception:
        try:
            await storage.delete(identity.org, path)
        except Exception:
            pass
        raise
    for field in ("supplierName", "invoiceNumber", "signer", "paymentReference"):
        draft[field] = redact(draft[field])
    draft.update(
        senderEmail=redact(senderEmail or draft["senderEmail"]),
        message=redact(message),
        extractionId=str(identifier),
        paymentId=options[0]["id"] if options else "",
    )
    missing = [name for name, value in draft.items() if not value and name not in {"message", "signer"}]
    return {
        "draft": draft,
        "paymentOptions": options,
        "missingFields": missing,
        "mode": "live",
        "status": "extracted",
    }
