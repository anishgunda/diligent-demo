import asyncio
import logging

from fastapi import HTTPException

from app.agent.graph import build_graph
from app.dependencies.database import tenant
from app.llm.base import ProviderError
from app.llm.factory import provider_for
from app.repositories import cases
from app.repositories.records import invoice_record, invoice_view

log = logging.getLogger(__name__)


class Investigations:
    def __init__(self, pool, settings, client, provider=None):
        self.pool, self.settings, self.client = pool, settings, client
        self.provider = provider if provider is not None else provider_for(settings)
        self.tasks = set()
        self.lock = asyncio.Lock()

    async def start(self, org, invoice_id):
        if not self.provider and not self.settings.enable_deterministic_fallback:
            raise HTTPException(503, "AI is unavailable and rules-only fallback is disabled.")
        async with self.lock:
            async with tenant(self.pool, org) as conn:
                current = await cases.latest_case(conn, org, invoice_id)
                if current:
                    current = await cases.expire_case(conn, current)
                    if current["status"] != "error":
                        return current
                if len(self.tasks) >= self.settings.investigation_concurrency:
                    raise HTTPException(429, "Investigations are busy. Try again shortly.")
                row, created = await cases.begin_case(
                    conn, org, invoice_id, self.settings.investigation_timeout_seconds
                )
            if created:
                task = asyncio.create_task(self.run(org, row))
                self.tasks.add(task)
                task.add_done_callback(self.tasks.discard)
            return row

    async def run(self, org, case):
        identifier = case["id"]

        async def emit(*args, **kwargs):
            async with tenant(self.pool, org) as conn:
                return await cases.append_event(conn, org, identifier, *args, **kwargs)

        try:
            async with asyncio.timeout(self.settings.investigation_timeout_seconds):
                async with tenant(self.pool, org) as conn:
                    invoice = invoice_view(await invoice_record(conn, org, case["invoice_id"]))
                graph = build_graph(
                    provider=self.provider,
                    pool=self.pool,
                    settings=self.settings,
                    client=self.client,
                    emit=emit,
                )
                result = await graph.ainvoke(
                    {
                        "investigation_id": str(identifier),
                        "organization_id": org,
                        "invoice_id": invoice["id"],
                        "invoice_claims": invoice,
                        "trusted_baseline_snapshot": case["baseline"],
                        "mandatory_check_results": [],
                        "discrepancies": [],
                        "collected_evidence": [],
                        "executed_tools": [],
                        "agent_messages": [],
                        "investigation_errors": [],
                        "policy_verdict": None,
                        "missing_evidence": [],
                        "required_verification": False,
                        "started_at": case["started_at"].isoformat(),
                        "execution": "AGENTIC",
                        "ai_status": "AVAILABLE",
                        "turns": 0,
                        "calls": [],
                    }
                )
                provider, model = (
                    (self.provider.provider, self.provider.model) if self.provider else (None, None)
                )
                async with tenant(self.pool, org) as conn:
                    await cases.finish_case(
                        conn,
                        org,
                        identifier,
                        result["mandatory_check_results"],
                        result["policy_verdict"],
                        result["execution"],
                        result["ai_status"],
                        provider,
                        model,
                    )
        except asyncio.CancelledError:
            await self.fail(org, identifier, "The service restarted during the investigation. Run it again.")
            raise
        except (TimeoutError, ProviderError) as error:
            reason = (
                "The investigation exceeded its time limit. Run it again."
                if isinstance(error, TimeoutError)
                else str(error)
            )
            await self.fail(org, identifier, reason)
        except Exception as error:
            log.error("Investigation failed (%s)", type(error).__name__)
            await self.fail(org, identifier, "The investigation could not complete. Run it again.")

    async def fail(self, org, identifier, reason):
        try:
            async with tenant(self.pool, org) as conn:
                await cases.fail_case(conn, org, identifier, reason)
        except Exception as error:
            log.error("Investigation failure could not be persisted (%s)", type(error).__name__)

    async def close(self):
        active = list(self.tasks)
        for task in active:
            task.cancel()
        await asyncio.gather(*active, return_exceptions=True)
        if self.provider and hasattr(self.provider, "client"):
            await self.provider.client.close()
