from urllib.parse import quote

from fastapi import HTTPException

from app.config import Settings

BUCKET = "identitytwin-invoices"
MAX_PDF = 15 * 1024 * 1024


class Storage:
    def __init__(self, settings: Settings, http):
        self.url = settings.supabase_url.rstrip("/")
        self.key = settings.supabase_service_role_key
        self.http = http

    def headers(self):
        if not self.url or not self.key:
            raise HTTPException(503, "Private document storage is not configured.")
        key = self.key.get_secret_value()
        if key.startswith("sb_publishable_"):
            raise HTTPException(503, "Private document storage requires a server-side Supabase key.")
        if key.startswith("sb_secret_"):
            return {"apikey": key}
        return {"apikey": key, "Authorization": "Bearer " + key}

    def location(self, org, path, *, authenticated=False):
        if not path.startswith(org + "/") or path.count("/") != 1 or not path.endswith(".pdf"):
            raise HTTPException(404, "Document not found.")
        suffix = "authenticated/" if authenticated else ""
        return f"{self.url}/storage/v1/object/{suffix}{BUCKET}/{quote(path, safe='/')}"

    async def upload(self, org, path, blob):
        response = await self.http.post(
            self.location(org, path),
            content=blob,
            headers={
                **self.headers(),
                "Content-Type": "application/pdf",
                "x-upsert": "false",
            },
        )
        if response.status_code not in (200, 201):
            raise HTTPException(502, "Private document upload failed.")

    async def download(self, org, path):
        async with self.http.stream(
            "GET", self.location(org, path, authenticated=True), headers=self.headers()
        ) as response:
            if response.status_code in (400, 404):
                raise HTTPException(404, "Document not found.")
            if response.status_code != 200:
                raise HTTPException(502, "Private document download failed.")
            data = bytearray()
            async for block in response.aiter_bytes():
                data.extend(block)
                if len(data) > MAX_PDF:
                    raise HTTPException(502, "Stored document exceeds the supported size.")
        return bytes(data)

    async def delete(self, org, path):
        await self.http.delete(self.location(org, path), headers=self.headers())
