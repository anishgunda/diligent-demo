from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated

import httpx
from clerk_backend_api import Clerk
from clerk_backend_api.security.types import AuthenticateRequestOptions
from fastapi import Depends, HTTPException, Request

from app.config import Settings, get_settings


@dataclass(frozen=True)
class Principal:
    user: str
    org: str
    organisation_name: str
    role: str


@lru_cache
def clerk_client(secret: str) -> Clerk:
    return Clerk(bearer_auth=secret)


def authenticate(request: Request, settings: Annotated[Settings, Depends(get_settings)]) -> Principal:
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer ") or len(header) > 8192:
        raise HTTPException(401, "A Clerk session token is required.")
    if not (settings.clerk_secret_key and settings.clerk_issuer and settings.origins):
        raise HTTPException(503, "Clerk authentication is not configured.")
    client = clerk_client(settings.clerk_secret_key.get_secret_value())
    signed_request = httpx.Request(request.method, str(request.url), headers={"Authorization": header})
    options = AuthenticateRequestOptions(
        authorized_parties=settings.origins,
        jwt_key=settings.clerk_jwt_key.get_secret_value().replace("\\n", "\n")
        if settings.clerk_jwt_key
        else None,
        audience=settings.clerk_audience,
        accepts_token=["session_token"],
    )
    try:
        state = client.authenticate_request(signed_request, options)
    except Exception:
        raise HTTPException(503, "Clerk session verification is unavailable.") from None
    if not state.is_signed_in or not state.payload:
        raise HTTPException(401, "The Clerk session is invalid or expired.")
    claims = state.payload
    if (
        claims.get("iss") != settings.clerk_issuer.rstrip("/")
        or claims.get("azp") not in settings.origins
        or not claims.get("sid")
    ):
        raise HTTPException(401, "The Clerk session is invalid for this application.")
    organisation = claims.get("o")
    if claims.get("sts") == "pending" or not isinstance(organisation, dict):
        raise HTTPException(403, "Select an active organisation in Clerk.")
    user, org, role = claims.get("sub"), organisation.get("id"), organisation.get("rol")
    if not (
        isinstance(user, str) and user.startswith("user_") and isinstance(org, str) and org.startswith("org_")
    ):
        raise HTTPException(403, "The session has no active organisation membership.")
    role = role.removeprefix("org:") if isinstance(role, str) else ""
    controller = settings.clerk_controller_role.removeprefix("org:")
    if role == controller:
        mapped = "FINANCE_CONTROLLER"
    elif role in {"ap_analyst", "admin", "member"}:
        mapped = "AP_ANALYST"
    else:
        raise HTTPException(403, "This organisation role does not have access.")
    return Principal(user, org, str(organisation.get("slg") or org), mapped)


Identity = Annotated[Principal, Depends(authenticate)]


def controller(identity: Identity) -> Principal:
    if identity.role != "FINANCE_CONTROLLER":
        raise HTTPException(403, "Finance Controller access is required.")
    return identity


Controller = Annotated[Principal, Depends(controller)]
