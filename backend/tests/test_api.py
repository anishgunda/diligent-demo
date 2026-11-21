import asyncio
import json
from datetime import UTC, datetime, timedelta
from io import BytesIO
from uuid import uuid4

import httpx
import jwt
import psycopg
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from pypdf import PdfWriter
from reportlab.pdfgen import canvas
from test_policy_agent import FakeProvider

from app.config import Settings
from app.main import create_app

ORIGIN = "https://frontend.example"
ISSUER = "https://clerk.example"


@pytest.fixture(scope="module")
def issuer():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = (
        key.public_key()
        .public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )

    def issue(role="ap_analyst", org="org_alpha", user="user_analyst", **claims):
        now = datetime.now(UTC)
        data = {
            "sub": user,
            "sid": "sess_synthetic",
            "iss": ISSUER,
            "azp": ORIGIN,
            "v": 2,
            "iat": now,
            "nbf": now,
            "exp": now + timedelta(minutes=3),
            "jti": str(uuid4()),
        }
        if org:
            data["o"] = {"id": org, "rol": role, "slg": org}
        data.update(claims)
        return {"Authorization": "Bearer " + jwt.encode(data, key, algorithm="RS256", headers={"kid": "test"})}

    config = {
        "clerk_jwt_key": public,
        "clerk_secret_key": "sk_test_synthetic",
        "clerk_issuer": ISSUER,
        "frontend_origins": ORIGIN,
    }
    return issue, config


def pdf(account="99881111"):
    buffer = BytesIO()
    doc = canvas.Canvas(buffer)
    text = doc.beginText(40, 780)
    for line in (
        "Supplier: Synthetic Ledger Ltd",
        "Company number: SC123456",
        "Invoice number: DEMO-421",
        "Invoice date: 2026-11-03",
        "Due date: 2026-12-03",
        "Email: ops@ledger.example",
        "Signer: Demo signer",
        "Total due: GBP 1,340.50",
        "Sort code: 01-02-03",
        f"Account number: {account}",
    ):
        text.textLine(line)
    doc.drawText(text)
    doc.save()
    return buffer.getvalue()


def blank_pdf():
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


async def test_authentication_boundary(issuer):
    sign, config = issuer
    app = create_app(settings=Settings(**config))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://api.example"
        ) as client:
            assert (await client.get("/health")).status_code == 200
            assert (await client.get("/api/evals")).status_code == 401
            assert (await client.get("/api/evals", headers=sign(org=None))).status_code == 403
            assert (
                await client.get("/api/evals", headers=sign(azp="https://untrusted.example"))
            ).status_code == 401
            assert (
                await client.get("/api/evals", headers=sign(iss="https://other.example"))
            ).status_code == 401
            assert (await client.get("/api/evals", headers=sign(sts="pending"))).status_code == 403
            expired = datetime.now(UTC) - timedelta(minutes=2)
            assert (await client.get("/api/evals", headers=sign(exp=expired))).status_code == 401
            assert (await client.get("/api/evals", headers=sign())).json() == []
            assert (await client.get("/api/evals", headers=sign(role="unknown"))).status_code == 403


@pytest.mark.integration
async def test_pdf_investigation_audit_and_tenant_isolation(database, issuer):
    dsn, owner = database
    sign, config = issuer
    objects = {}

    def storage(request):
        assert request.headers["apikey"] == "test-storage"
        key = request.url.path.split("/identitytwin-invoices/", 1)[1]
        if request.method == "POST":
            objects[key] = request.content
            return httpx.Response(200)
        if request.method == "DELETE":
            objects.pop(key, None)
            return httpx.Response(200)
        return httpx.Response(200, content=objects[key]) if key in objects else httpx.Response(404)

    external = httpx.AsyncClient(transport=httpx.MockTransport(storage))
    provider = FakeProvider("inspect_sender_domain")
    app = create_app(
        settings=Settings(
            **config,
            database_url=dsn,
            supabase_url="https://storage.example",
            supabase_service_role_key="test-storage",
            payment_fingerprint_key="local-test-fingerprinting-key-1234",
        ),
        external_http=external,
        provider=provider,
    )
    analyst = sign()
    controller = sign(role="finance_controller", user="user_controller")
    outsider = sign(org="org_beta", role="finance_controller", user="user_external")
    review = {
        "method": "Known supplier phone",
        "outcome": "CONFIRMED_LEGITIMATE",
        "trustedContactSource": "Controlled supplier directory fixture",
        "notes": "Independent callback recorded.",
    }
    supplier_data = {
        "name": "Synthetic Ledger Ltd",
        "companyNumber": "SC123456",
        "domain": "ledger.example",
        "signer": "Demo signer",
    }

    async with external, app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://api.example"
        ) as client:
            me = await client.get("/api/me", headers=controller)
            assert me.json()["role"] == "FINANCE_CONTROLLER"
            assert me.json()["organisationId"] == "org_alpha"
            supplier = (await client.post("/api/suppliers", json=supplier_data, headers=analyst)).json()
            supplier_url = "/api/suppliers/" + supplier["id"]
            baseline = (
                await client.post(
                    "/api/payment-candidates",
                    headers=analyst,
                    json={"sortCode": "010203", "account": "99882222"},
                )
            ).json()
            alien = (
                await client.post(
                    "/api/payment-candidates",
                    headers=outsider,
                    json={"sortCode": "010203", "account": "99882222"},
                )
            ).json()
            assert baseline["fingerprint"] != alien["fingerprint"]
            assert (
                await client.post(
                    supplier_url + "/payment-proposals", headers=outsider, json={"paymentId": alien["id"]}
                )
            ).status_code == 404
            response = await client.post(
                supplier_url + "/payment-proposals", headers=analyst, json={"paymentId": baseline["id"]}
            )
            assert response.status_code == 201
            proposed = response.json()
            assert proposed["payment"] is None
            approve = supplier_url + "/payment-proposals/" + proposed["changes"][0]["id"] + "/approve"
            assert (await client.post(approve, headers=analyst, json=review)).status_code == 403
            assert (
                await client.post(approve, headers=sign(role="finance_controller"), json=review)
            ).status_code == 403
            assert (await client.post(approve, headers=controller, json=review)).json()["payment"][
                "account"
            ] == "•••• 2222"
            assert (await client.get("/api/suppliers", headers=outsider)).json() == []

            empty = await client.post(
                "/api/extract", headers=analyst, files={"file": ("scan.pdf", blank_pdf(), "application/pdf")}
            )
            assert empty.status_code == 422 and "OCR" in empty.json()["detail"]
            raw = pdf()
            extracted = await client.post(
                "/api/extract", headers=analyst, files={"file": ("../invoice.pdf", raw, "application/pdf")}
            )
            assert extracted.status_code == 200, extracted.text
            result = extracted.json()
            assert result["draft"]["amount"] == 1340.50
            assert "99881111" not in extracted.text
            assert result["paymentOptions"][0]["account"] == "•••• 1111"
            draft = result["draft"]
            assert (await client.post("/api/invoices", headers=outsider, json=draft)).status_code == 404
            created = await client.post("/api/invoices", headers=analyst, json=draft)
            assert created.status_code == 201, created.text
            invoice = created.json()
            assert (await client.post("/api/invoices", headers=analyst, json=draft)).json()["id"] == invoice[
                "id"
            ]
            mapped = "/api/invoices/" + invoice["id"]
            assert (await client.get(mapped, headers=outsider)).status_code == 404
            assert (await client.get(mapped + "/document", headers=outsider)).status_code == 404
            assert (await client.get(mapped + "/document", headers=analyst)).content == raw
            assert all(key.startswith("org_alpha/") and ".." not in key for key in objects)
            started = await client.post("/api/investigate", headers=analyst, json={"invoiceId": invoice["id"]})
            assert started.status_code == 202, started.text
            case_id = started.json()["investigationId"]
            case_url = "/api/investigations/" + case_id
            assert (await client.get(case_url + "/events", headers=outsider)).status_code == 404
            streamed = await asyncio.wait_for(client.get(case_url + "/events", headers=analyst), timeout=12)
            events = [json.loads(line[6:]) for line in streamed.text.splitlines() if line.startswith("data: ")]
            assert [event["sequence"] for event in events] == list(range(1, len(events) + 1))
            assert events[-1]["type"] == "investigation_completed"
            assert any(event["type"] == "agent_observation" for event in events)
            last = str(events[-2]["sequence"])
            replay = await client.get(
                case_url + "/events?after=" + last, headers={**analyst, "Last-Event-ID": case_id + "-" + last}
            )
            replay_events = [
                json.loads(line[6:]) for line in replay.text.splitlines() if line.startswith("data: ")
            ]
            assert replay_events == events[-1:]
            verify = "/api/cases/" + invoice["id"] + "/verify"
            assert (await client.post(verify, headers=analyst, json=review)).status_code == 403
            assert (await client.post(verify, headers=outsider, json=review)).status_code == 404
            before = (await client.get(case_url + "/report", headers=analyst)).json()
            assert before["policy"]["verdict"] == "HOLD_FOR_VERIFICATION"
            request_review = "/api/cases/" + invoice["id"] + "/verification-request"
            requested = await client.post(request_review, headers=analyst)
            assert requested.json()["investigation"]["verificationRequestedBy"] == "user_analyst"
            assert (await client.post(request_review, headers=analyst)).status_code == 200
            assert (await client.post(request_review, headers=outsider)).status_code == 404
            verified = (await client.post(verify, headers=controller, json=review)).json()
            assert verified["investigation"]["result"]["verdict"] == "NO_NEW_FLAGS"
            after = (await client.get(case_url + "/report", headers=analyst)).json()
            assert before["evidence"] == after["evidence"]
            assert after["version"] == 3 and after["verification"][0]["reviewer"] == "user_controller"
            assert after["paymentAuthorisation"] == "OUTSIDE_WORKFLOW"
            assert (await client.get("/api/reports", headers=outsider)).json() == []

    with psycopg.connect(owner) as conn:
        assert conn.execute("select count(*) from identitytwin.audit_reports").fetchone()[0] >= 2
        assert conn.execute("select count(*) from identitytwin.evidence_records").fetchone()[0] >= 4
    with psycopg.connect(dsn) as conn:
        assert conn.execute("select count(*) from identitytwin.invoices").fetchone()[0] == 0
        conn.execute("select set_config('app.organization_id','org_alpha',true)")
        assert conn.execute("select count(*) from identitytwin.invoices").fetchone()[0] == 1


@pytest.mark.integration
@pytest.mark.parametrize(
    "fallback,expected", [(False, "investigation_failed"), (True, "investigation_completed")]
)
async def test_failed_agent_stream_and_rules_only_replay(database, issuer, fallback, expected):
    dsn, _ = database
    sign, config = issuer
    app = create_app(
        settings=Settings(**config, database_url=dsn, enable_deterministic_fallback=fallback),
        provider=FakeProvider(fail=True),
    )
    headers = sign(org="org_fallback" if fallback else "org_failure")
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://api.example"
        ) as client:
            created = await client.post(
                "/api/invoices",
                headers=headers,
                json={
                    "supplierName": "Synthetic Ledger Ltd",
                    "invoiceNumber": "TEST-FALLBACK",
                    "amount": 20,
                    "invoiceDate": "2026-11-03",
                    "dueDate": "2026-12-03",
                },
            )
            assert created.status_code == 201
            started = await client.post(
                "/api/investigate", headers=headers, json={"invoiceId": created.json()["id"]}
            )
            assert started.status_code == 202
            url = "/api/investigations/" + started.json()["investigationId"]
            response = await asyncio.wait_for(client.get(url + "/events", headers=headers), timeout=10)
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
            assert events[-1]["type"] == expected
            assert not any(event["type"] == "agent_observation" for event in events)
            terminal = (await client.get(url, headers=headers)).json()
            replay = await client.get(url + "/events?after=" + str(events[-1]["sequence"]), headers=headers)
            assert "data:" not in replay.text
            if fallback:
                assert terminal["executionMode"] == "RULES_ONLY"
                assert terminal["result"]["verdict"] == "HOLD_FOR_VERIFICATION"
            else:
                assert terminal["phase"] == "error"
                assert (await client.get(url + "/report", headers=headers)).status_code == 404
