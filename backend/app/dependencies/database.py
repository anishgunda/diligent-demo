from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from app.dependencies.auth import Principal


def pool_dependency(request: Request) -> AsyncConnectionPool:
    pool = request.app.state.pool
    if pool is None:
        raise HTTPException(503, "Database access is not configured.")
    return pool


Pool = Annotated[AsyncConnectionPool, Depends(pool_dependency)]


@asynccontextmanager
async def tenant(pool: AsyncConnectionPool, org: str) -> AsyncIterator[AsyncConnection]:
    async with pool.connection() as conn, conn.transaction():
        await conn.execute("select set_config('app.organization_id', %s, true)", (org,))
        await conn.execute("set local statement_timeout = '8s'")
        await conn.execute("set local search_path to identitytwin, public")
        yield conn


async def track_identity(conn: AsyncConnection, principal: Principal) -> None:
    await conn.execute(
        """insert into organisations (id, clerk_organization_id, name) values (%s,%s,%s)
           on conflict (id) do update set name = excluded.name
           where organisations.name is distinct from excluded.name""",
        (principal.org, principal.org, principal.organisation_name),
    )
    await conn.execute(
        """insert into memberships (organization_id,clerk_user_id,role) values (%s,%s,%s)
           on conflict (organization_id,clerk_user_id) do update
           set role = excluded.role, seen_at = now()""",
        (principal.org, principal.user, principal.role),
    )
