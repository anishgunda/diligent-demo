import asyncio
import logging
import sys
from collections import OrderedDict
from contextlib import asynccontextmanager
from time import monotonic

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from psycopg import Error
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool, PoolTimeout
from starlette.middleware.cors import CORSMiddleware

from app.api import cases, extraction, records
from app.config import get_settings
from app.dependencies.auth import Identity
from app.services.investigation import Investigations
from app.services.storage import MAX_PDF, Storage

logger = logging.getLogger(__name__)


class BodyLimit:
    def __init__(self, app):
        self.app = app
        self.uploads = asyncio.Semaphore(2)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in ("POST", "PATCH"):
            return await self.app(scope, receive, send)
        if scope["path"].rstrip("/") == "/api/extract":
            if self.uploads.locked():
                response = JSONResponse(
                    {"detail": "Upload capacity reached. Try again shortly."}, status_code=429
                )
                return await response(scope, receive, send)
            async with self.uploads:
                return await self.read_body(scope, receive, send, MAX_PDF + 32768)
        return await self.read_body(scope, receive, send, 16384)

    async def read_body(self, scope, receive, send, limit):
        body = bytearray()
        try:
            async with asyncio.timeout(20):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    data = message.get("body", b"")
                    if len(body) + len(data) > limit:
                        response = JSONResponse(
                            {"detail": "Request exceeds the supported size."}, status_code=413
                        )
                        return await response(scope, receive, send)
                    body.extend(data)
                    if not message.get("more_body"):
                        break
        except TimeoutError:
            response = JSONResponse({"detail": "The upload exceeded its time limit."}, status_code=408)
            return await response(scope, receive, send)
        sent = False

        async def replay():
            nonlocal sent
            if sent:
                return await receive()
            sent = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        return await self.app(scope, replay, send)


async def throttle(request: Request, identity: Identity):
    buckets = request.app.state.rate_buckets
    minute = int(monotonic() // 60)
    path = request.scope["route"].path
    limit = 8 if path == "/api/extract" else 12 if path == "/api/investigate" else 120
    category = path if limit < 120 else "general"
    key = identity.org, identity.user, category
    old_minute, count = buckets.get(key, (minute, 0))
    if old_minute != minute:
        count = 0
    if count >= limit:
        raise HTTPException(429, "Request limit reached. Try again shortly.", headers={"Retry-After": "60"})
    buckets[key] = (minute, count + 1)
    buckets.move_to_end(key)
    if len(buckets) > 4096:
        buckets.popitem(last=False)


def create_app(*, settings=None, external_http=None, provider=None):
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app):
        pool = (
            AsyncConnectionPool(
                settings.database_url.get_secret_value(),
                open=False,
                min_size=1,
                max_size=8,
                timeout=5,
                kwargs={"row_factory": dict_row, "prepare_threshold": None},
            )
            if settings.database_url
            else None
        )
        client = external_http or httpx.AsyncClient(
            timeout=httpx.Timeout(12), follow_redirects=False, trust_env=False
        )
        app.state.pool = pool
        app.state.rate_buckets = OrderedDict()
        app.state.extraction_slots = asyncio.Semaphore(1)
        app.state.storage = Storage(settings, client)
        app.state.investigations = Investigations(pool, settings, client, provider)
        try:
            if pool:
                await pool.open(wait=True, timeout=10)
            yield
        finally:
            await app.state.investigations.close()
            if pool:
                await pool.close()
            if not external_http:
                await client.aclose()

    app = FastAPI(
        title="IdentityTwin",
        version="0.2.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.dependency_overrides[get_settings] = lambda: settings
    app.add_middleware(BodyLimit)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.origins,
        allow_methods=["GET", "POST", "PATCH"],
        allow_headers=["Authorization", "Content-Type", "Last-Event-ID"],
    )

    @app.exception_handler(RequestValidationError)
    async def invalid(_request, error):
        # Validation errors can contain the exact submitted bank details.
        errors = [
            {"field": ".".join(map(str, item["loc"])), "message": item["msg"]}
            for item in error.errors()
            if item["type"] != "value_error"
        ]
        return JSONResponse({"detail": "Request validation failed.", "fields": errors}, status_code=422)

    @app.exception_handler(Error)
    @app.exception_handler(PoolTimeout)
    @app.exception_handler(httpx.HTTPError)
    async def unavailable(_request, error):
        logger.warning("A backend dependency failed (%s)", type(error).__name__)
        return JSONResponse({"detail": "A required service is temporarily unavailable."}, status_code=503)

    @app.get("/health")
    async def health(request: Request):
        pool = request.app.state.pool
        if pool:
            async with pool.connection() as conn:
                await conn.execute("select 1 from identitytwin.organisations limit 0")
        return {"status": "ok", "database": "ready" if pool else "unconfigured"}

    for router in (records.router, cases.router, extraction.router):
        app.include_router(router, dependencies=[Depends(throttle)])
    return app


app = create_app()


if __name__ == "__main__":
    import os

    import uvicorn

    if sys.platform == "win32":
        # psycopg requires SelectorEventLoop on Windows.
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), workers=1, limit_concurrency=48)
