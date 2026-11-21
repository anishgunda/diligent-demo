import httpx
import pytest
from fastapi import HTTPException

from app.config import Settings
from app.services.storage import Storage


@pytest.mark.parametrize(
    ("key", "bearer"),
    [("sb_secret_test_fixture", None), ("legacy-test-fixture", "Bearer legacy-test-fixture")],
)
async def test_storage_sends_server_keys_using_their_supported_headers(key, bearer):
    blob = b"%PDF-1.4\nfixture\n"
    methods = []

    def handle(request):
        assert request.headers["apikey"] == key
        assert request.headers.get("authorization") == bearer
        methods.append(request.method)
        return httpx.Response(200, content=blob if request.method == "GET" else b"")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        storage = Storage(Settings(supabase_url="https://project.example", supabase_service_role_key=key), client)
        await storage.upload("org_fixture", "org_fixture/invoice.pdf", blob)
        assert await storage.download("org_fixture", "org_fixture/invoice.pdf") == blob
        await storage.delete("org_fixture", "org_fixture/invoice.pdf")
    assert methods == ["POST", "GET", "DELETE"]


def test_private_storage_rejects_publishable_keys():
    settings = Settings(
        supabase_url="https://project.example", supabase_service_role_key="sb_publishable_test_fixture"
    )
    with pytest.raises(HTTPException, match="server-side Supabase key"):
        Storage(settings, None).headers()
