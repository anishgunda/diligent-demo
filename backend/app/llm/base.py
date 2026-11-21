from dataclasses import dataclass, field
from typing import Protocol

from pydantic import BaseModel, Field


class Findings(BaseModel):
    summary: str = Field(max_length=600)
    observations: list[str] = Field(max_length=5)


@dataclass
class Invocation:
    findings: Findings | None = None
    calls: list[dict] = field(default_factory=list)
    assistant: dict = field(default_factory=dict)


class ProviderError(RuntimeError):
    pass


class Provider(Protocol):
    provider: str
    model: str

    async def invoke(self, messages: list[dict], tools: list[dict]) -> Invocation: ...

    async def pretext(self, message: str) -> Findings: ...
