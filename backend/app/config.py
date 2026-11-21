from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_ignore_empty=True, extra="ignore")

    database_url: SecretStr | None = None
    require_live_configuration: bool = False
    frontend_origins: str = "http://localhost:3000"
    clerk_secret_key: SecretStr | None = None
    clerk_jwt_key: SecretStr | None = None
    clerk_issuer: str = ""
    clerk_audience: str | None = None
    clerk_controller_role: str = "org:finance_controller"
    supabase_url: str = ""
    supabase_service_role_key: SecretStr | None = None
    payment_fingerprint_key: SecretStr | None = None
    companies_house_api_key: SecretStr | None = None
    llm_provider: str = "grok"
    llm_model: str = "grok-4.3"
    llm_fallback_provider: str = "none"
    llm_timeout_seconds: float = Field(30, ge=1, le=60)
    enable_deterministic_fallback: bool = True
    investigation_timeout_seconds: int = Field(125, ge=15, le=240)
    investigation_concurrency: int = Field(3, ge=1, le=10)

    def model_post_init(self, _context):
        if self.require_live_configuration and not (
            self.database_url
            and self.clerk_secret_key
            and self.clerk_issuer
            and self.origins
            and self.supabase_url
            and self.supabase_service_role_key
            and self.payment_fingerprint_key
        ):
            raise ValueError(
                "Live configuration requires the database, Clerk, private storage and payment key."
            )
        if "*" in self.origins:
            raise ValueError("FRONTEND_ORIGINS must list explicit application origins.")
        if self.llm_fallback_provider != "none":
            raise ValueError("LLM_FALLBACK_PROVIDER must be none. No fallback LLM adapter is installed.")
        if self.llm_provider not in {"grok", "none"}:
            raise ValueError("LLM_PROVIDER must be grok or none.")
        if self.payment_fingerprint_key and len(self.payment_fingerprint_key.get_secret_value()) < 32:
            raise ValueError("PAYMENT_FINGERPRINT_KEY requires at least 32 characters.")

    xai_api_key: SecretStr | None = None
    xai_base_url: str = "https://api.x.ai/v1"

    @property
    def origins(self) -> list[str]:
        return [item.strip().rstrip("/") for item in self.frontend_origins.split(",") if item.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
