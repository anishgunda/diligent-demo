import asyncio
import os
import sys
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo


def pytest_asyncio_loop_factories(config, item):
    if sys.platform == "win32":
        return {"selector": asyncio.SelectorEventLoop}
    return {"default": asyncio.new_event_loop}


@pytest.fixture(scope="session")
def database():
    admin = os.getenv("TEST_DATABASE_ADMIN_URL")
    if not admin:
        pytest.skip("Set TEST_DATABASE_ADMIN_URL to an isolated local PostgreSQL test server.")
    name = "identitytwin_test_" + uuid4().hex
    reader = "identitytwin_app_" + uuid4().hex[:16]
    secret = uuid4().hex
    directory = Path(__file__).resolve().parents[1] / "migrations"
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(
            sql.SQL("create role {} login password {}").format(sql.Identifier(reader), sql.Literal(secret))
        )
        conn.execute(
            sql.SQL("create database {} template template0 encoding 'UTF8' locale 'C'").format(
                sql.Identifier(name)
            )
        )
    try:
        owner_dsn = make_conninfo(admin, dbname=name)
        with psycopg.connect(owner_dsn) as conn:
            conn.execute((directory / "001_identitytwin.sql").read_text(encoding="utf8"))
            conn.execute((directory / "003_runtime_role.sql").read_text(encoding="utf8"))
            conn.execute(sql.SQL("grant identitytwin_runtime to {}").format(sql.Identifier(reader)))
        yield make_conninfo(admin, dbname=name, user=reader, password=secret), owner_dsn
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("drop database {} with (force)").format(sql.Identifier(name)))
            conn.execute(sql.SQL("drop role {}").format(sql.Identifier(reader)))
