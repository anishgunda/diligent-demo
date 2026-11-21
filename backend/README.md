# IdentityTwin Phase 2

The live Next.js application uses Clerk and sends signed session tokens to this FastAPI service. The backend stores organisation data and case history in PostgreSQL. The public mock deployment can continue using the original browser-only demo.

## Run and test

From `backend/` with Python 3.12 installed:

```sh
python -m venv .venv
python -m pip install -e ".[test]"
python -m pytest -q
python -m ruff check app tests
python -m app.main
```

Activate the virtual environment before installing. On Windows, use `.venv\Scripts\Activate.ps1`. On Linux or macOS, use `source .venv/bin/activate`. The API listens on port 8000 unless `PORT` is set. Start the frontend separately in mock mode or set up the live credentials below.

The integration suite uses a disposable database and restricted role created on the isolated PostgreSQL server specified by `TEST_DATABASE_ADMIN_URL`. It verifies official Clerk SDK validation against test-signed tokens, two tenant boundaries, separate reviewers, real PDF parsing, investigation events, case review and reports. Its storage transport and model are controlled test implementations. To test the configured xAI account explicitly, set `XAI_API_KEY`, `RUN_PAID_GROK_SMOKE=1` and run `python -m pytest -m paid -q`. This invokes the selected model twice and incurs provider charges.

## Deploy

1. **Clerk.** Enable Organizations, including email invitations, and create roles with keys `org:ap_analyst` and `org:finance_controller`. Grant the controller role to designated members. Default Clerk admin and member roles map to AP Analyst in IdentityTwin. The browser uses standard v2 session tokens. Configure permitted development and hosted frontend domains in the Clerk dashboard and use a Clerk instance appropriate for the target environment. Copy its Frontend API origin for `CLERK_ISSUER`. [Clerk session token claims](https://clerk.com/docs/guides/sessions/session-tokens)
2. **Supabase.** Run the files in [migrations](migrations/) in numeric order via the SQL Editor as the migration owner. Create a dedicated login role with a generated password and `NOBYPASSRLS`, then grant it the `identitytwin_runtime` role. Use this login's TLS connection string as `DATABASE_URL`. Use Supabase's session pooler if the runtime requires IPv4 and add the project reference to the login as shown in Supabase's connection details. The supplied Storage migration creates a private PDF bucket and denies direct browser roles. Set `SUPABASE_URL` to the project HTTPS origin and `SUPABASE_SERVICE_ROLE_KEY` to its server-only service-role JWT. [Supabase private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals)
3. **Render.** Push the reviewed repository to a Git remote you control and connect it at **New → Blueprint**. Select the root `render.yaml`. The Blueprint runs `pip install .` from `backend/`, starts `python -m app.main` on Render's port, checks `/health`, and sets one instance. Configure the variables in the table below. Check that `GET https://<service>.onrender.com/health` returns `{"status":"ok","database":"ready"}`. [Render Blueprint reference](https://render.com/docs/blueprint-spec)
4. **Vercel.** Configure a separate Next.js project or branch preview for live testing. Add `NEXT_PUBLIC_API_MODE=live`, `NEXT_PUBLIC_API_URL=https://<service>.onrender.com`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and server-only `CLERK_SECRET_KEY`. Add that project's exact HTTPS origin to Render's `FRONTEND_ORIGINS` and to the Clerk deployment configuration. Redeploy after setting frontend build variables. The existing mock deployment can retain `NEXT_PUBLIC_API_MODE=mock`.
5. **Verify.** Sign in, create two organisations and assign two users distinct roles in the first. Add a fictional supplier with a trusted domain and contact. As the analyst, enter a synthetic payment destination and propose onboarding. As the controller, verify and approve the proposal. Upload a text PDF with a different synthetic destination and matching supplier identity. Run the investigation, record an independent outcome, verify the report and repeat with a second organisation to test isolation.

| Environment | Variables |
| --- | --- |
| Render, required | `DATABASE_URL`, `FRONTEND_ORIGINS`, `CLERK_ISSUER`, `CLERK_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PAYMENT_FINGERPRINT_KEY` |
| Render, to use Grok | `XAI_API_KEY`, with `LLM_MODEL=grok-4.3` as the default. Add `COMPANIES_HOUSE_API_KEY` for registry lookups. |
| Vercel live | `NEXT_PUBLIC_API_MODE`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, server-only `CLERK_SECRET_KEY` |

Enter private credentials in the service dashboards. Generate `PAYMENT_FINGERPRINT_KEY` once from at least 32 random bytes, keep it server-side, and retain it across releases. Rotating it without a migration invalidates prior comparisons. See [backend/.env.example](.env.example) for optional configuration, including a Clerk public key or token audience.

For the Supabase runtime login, substitute a generated secret in the SQL Editor:

```sql
create role identitytwin_api login nobypassrls password 'REPLACE_WITH_GENERATED_PASSWORD';
grant identitytwin_runtime to identitytwin_api;
```

## Operational limits

- The worker is in-process. Events and reports are durable. Graceful shutdown marks interrupted jobs failed, and after a hard restart the API expires abandoned runs when the case is accessed. Keep one service instance and one worker until durable execution is introduced.
- PDF parsing covers supported labelled fields in text PDFs up to 15 MB and 20 pages. Image-only files require OCR. Uncertain fields stay blank for review. Unattached uploads become inaccessible to clients after 24 hours. Storage deletion and retention scheduling are operator tasks in this phase.
- Rules-only mode reports skipped AI work and holds unresolved evidence. The evaluations page retains its fixture data in mock mode. Live evaluations have no results until measured runs are published.
- Policy dispositions and verified supplier changes inform an independent approval process. This service exposes no payment transfer operation.
