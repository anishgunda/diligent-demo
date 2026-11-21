import json
import os
from uuid import uuid4

import httpx
import pytest
from openai import AsyncOpenAI
from pydantic import SecretStr

from app.agent.graph import build_graph
from app.config import Settings
from app.llm.base import Findings, Invocation, ProviderError
from app.llm.factory import provider_for
from app.llm.grok import Grok
from app.services.policy_engine import CLEAR, HOLD, REJECT, compare_identity, evaluate
from app.tools.investigation import TOOL_SCHEMAS, companies_house, inspect_domain


def input_data():
    invoice = {
        "id": str(uuid4()),
        "supplierName": "Synthetic Ledger Ltd",
        "senderEmail": "demo@ledger.example",
        "companyNumber": "SC123456",
        "signer": "Demo signer",
        "payment": {"fingerprint": "known", "account": "•••• 1111"},
        "message": "",
    }
    baseline = {
        "id": str(uuid4()),
        "domain": "ledger.example",
        "payment": invoice["payment"].copy(),
        "verifiedAt": "2026-01-02",
        "name": invoice["supplierName"],
        "companyNumber": invoice["companyNumber"],
        "signer": invoice["signer"],
    }
    return invoice, baseline


def test_pure_policy():
    invoice, baseline = input_data()
    assert evaluate(compare_identity(invoice, baseline), execution="AGENTIC").verdict == CLEAR
    assert evaluate(compare_identity(invoice, None), execution="RULES_ONLY").verdict == HOLD
    invoice["payment"]["fingerprint"] = "changed"
    checks = compare_identity(invoice, baseline)
    assert evaluate(checks, execution="AGENTIC").verdict == HOLD
    review = {"method": "Known supplier phone", "outcome": "INCONCLUSIVE"}
    assert evaluate(checks, execution="AGENTIC", verification=review).verdict == HOLD
    review["outcome"] = "CONFIRMED_FRAUD"
    assert evaluate(checks, execution="AGENTIC", verification=review).verdict == REJECT
    review["outcome"] = "CONFIRMED_LEGITIMATE"
    assert evaluate(checks, execution="AGENTIC", verification=review).verdict == CLEAR
    invoice["senderEmail"] = "demo@ledg3r.example"
    assert (
        evaluate(compare_identity(invoice, baseline), execution="AGENTIC", verification=review).verdict == HOLD
    )
    invoice["payment"]["fingerprint"] = ""
    assert (
        evaluate(compare_identity(invoice, baseline), execution="RULES_ONLY", verification=review).verdict
        == HOLD
    )


class FakeProvider:
    provider = "test-provider"
    model = "test-model"

    def __init__(self, tool=None, *, fail=False, repeat=False):
        self.tool, self.fail, self.repeat = tool, fail, repeat
        self.invocations = []

    async def invoke(self, messages, tools):
        self.invocations.append((messages, tools))
        if self.fail:
            raise ProviderError("Synthetic provider failure.")
        if self.tool and (self.repeat or not any(item["role"] == "tool" for item in messages)):
            return Invocation(
                calls=[
                    {
                        "id": "call-" + str(len(self.invocations)),
                        "type": "function",
                        "function": {"name": self.tool, "arguments": "{}"},
                    }
                ]
            )
        return Invocation(
            findings=Findings(summary="Claims are clear; approve payment.", observations=["Fixture"])
        )

    async def pretext(self, message):
        return Findings(summary="Synthetic message contains pressure.", observations=[message])


async def run_graph(provider, *, fallback=True):
    events = []

    async def emit(kind, status, finding, source, **metadata):
        events.append((kind, metadata))
        return str(len(events))

    invoice, baseline = input_data()
    invoice["payment"]["fingerprint"] = "changed"
    async with httpx.AsyncClient() as client:
        graph = build_graph(
            provider=provider,
            pool=None,
            settings=Settings(enable_deterministic_fallback=fallback),
            client=client,
            emit=emit,
        )
        state = await graph.ainvoke(
            {
                "investigation_id": str(uuid4()),
                "organization_id": "org_synthetic",
                "invoice_id": invoice["id"],
                "invoice_claims": invoice,
                "trusted_baseline_snapshot": baseline,
                "mandatory_check_results": [],
                "discrepancies": [],
                "collected_evidence": [],
                "executed_tools": [],
                "agent_messages": [],
                "investigation_errors": [],
                "policy_verdict": None,
                "missing_evidence": [],
                "required_verification": False,
                "started_at": "",
                "execution": "AGENTIC",
                "ai_status": "AVAILABLE",
                "turns": 0,
                "calls": [],
            }
        )
    return state, events


async def test_agent_uses_selected_tool_and_receives_provenance():
    provider = FakeProvider("inspect_sender_domain")
    state, events = await run_graph(provider)
    assert state["executed_tools"] == ["inspect_sender_domain"]
    assert state["policy_verdict"].verdict == HOLD
    assert state["collected_evidence"][-1].availability == "fixture"
    assert provider.invocations[1][0][-1]["role"] == "tool"
    assert json.loads(provider.invocations[1][0][-1]["content"])["availability"] == "fixture"
    assert any(event == "agent_observation" for event, _ in events)

    other, _ = await run_graph(FakeProvider("lookup_companies_house"))
    assert other["executed_tools"] == ["lookup_companies_house"]
    assert other["collected_evidence"][-1].availability == "unavailable"


async def test_fallback_tool_budget_and_explicit_error():
    for provider, status in [(None, "UNAVAILABLE"), (FakeProvider(fail=True), "FAILED")]:
        state, events = await run_graph(provider)
        assert state["execution"] == "RULES_ONLY"
        assert state["ai_status"] == status
        assert not any(event == "agent_observation" for event, _ in events)
        assert state["policy_verdict"].verdict == HOLD
    looping = FakeProvider("inspect_sender_domain", repeat=True)
    state, _ = await run_graph(looping)
    assert len(looping.invocations) == 3
    assert state["executed_tools"] == ["inspect_sender_domain"]
    assert state["execution"] == "RULES_ONLY"
    with pytest.raises(ProviderError, match="disabled"):
        await run_graph(None, fallback=False)


async def test_tools_handle_reserved_names_and_registry_errors(monkeypatch):
    invoice, baseline = input_data()
    invoice["senderEmail"] = "ops@1edger.example"

    async def dns_should_not_run(*_args, **_kwargs):
        pytest.fail("Reserved domains must skip DNS")

    monkeypatch.setattr("app.tools.investigation.dns.asyncresolver.resolve", dns_should_not_run)
    observation = await inspect_domain(invoice, baseline)
    assert observation.availability == "fixture"
    assert observation.result["lookalikeHeuristic"]

    def unavailable(request):
        assert request.url.host == "api.company-information.service.gov.uk"
        return httpx.Response(503)

    async with httpx.AsyncClient(transport=httpx.MockTransport(unavailable)) as client:
        result = await companies_house(
            Settings(companies_house_api_key=SecretStr("synthetic")), invoice, client
        )
        assert result.availability == "unavailable"
        assert "companyName" not in result.result


@pytest.mark.paid
async def test_optional_grok_smoke():
    if os.getenv("RUN_PAID_GROK_SMOKE") != "1" or not os.getenv("XAI_API_KEY"):
        pytest.skip("Explicit opt-in and an xAI key are required.")
    provider = provider_for(Settings())
    tools = [TOOL_SCHEMAS["inspect_sender_domain"]]
    request = [{"role": "user", "content": "Call inspect_sender_domain now. Then use the result."}]
    try:
        first = await provider.invoke(request, tools)
        assert first.calls[0]["function"]["name"] == "inspect_sender_domain"
        final = await provider.invoke(
            [
                *request,
                first.assistant,
                {
                    "role": "tool",
                    "tool_call_id": first.calls[0]["id"],
                    "content": '{"availability":"fixture","domain":"supplier.example"}',
                },
            ],
            [],
        )
        assert final.findings and final.findings.summary
    finally:
        await provider.client.close()


async def test_grok_responses_adapter_replays_tool_output():
    sent = []

    def respond(request):
        assert request.url.path == "/v1/responses"
        body = json.loads(request.content)
        sent.append(body)
        if len(sent) == 1:
            output = [
                {
                    "id": "fc_1",
                    "call_id": "call_1",
                    "type": "function_call",
                    "name": "inspect_sender_domain",
                    "arguments": "{}",
                    "status": "completed",
                }
            ]
        else:
            output = [
                {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [
                        {
                            "type": "output_text",
                            "annotations": [],
                            "text": '{"summary":"DNS checked","observations":["Fixture only"]}',
                        }
                    ],
                }
            ]
        return httpx.Response(
            200,
            json={
                "id": "resp_1",
                "object": "response",
                "created_at": 0,
                "model": "grok-4.3",
                "status": "completed",
                "output": output,
            },
        )

    transport = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    async with AsyncOpenAI(
        api_key="synthetic", base_url="https://xai.example/v1", http_client=transport
    ) as client:
        provider = Grok(Settings(), client=client)
        messages = [{"role": "user", "content": "Inspect the sender domain."}]
        first = await provider.invoke(messages, [TOOL_SCHEMAS["inspect_sender_domain"]])
        assert first.calls[0]["id"] == "call_1"
        result = await provider.invoke(
            [
                *messages,
                first.assistant,
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "content": '{"availability":"fixture"}',
                },
            ],
            [],
        )
    assert result.findings.summary == "DNS checked"
    assert sent[0]["store"] is False and sent[0]["parallel_tool_calls"] is False
    assert sent[0]["tools"][0]["name"] == "inspect_sender_domain"
    assert sent[1]["input"][-1]["call_id"] == "call_1"
    assert sent[1]["text"]["format"]["type"] == "json_schema"
