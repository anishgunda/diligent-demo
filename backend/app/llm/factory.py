from app.config import Settings
from app.llm.base import Provider
from app.llm.grok import Grok


def provider_for(settings: Settings) -> Provider | None:
    if settings.llm_provider == "none" or not settings.xai_api_key:
        return None
    return Grok(settings)
