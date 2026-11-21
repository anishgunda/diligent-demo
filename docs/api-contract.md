# IdentityTwin live API

The HTTP adapter uses the FastAPI origin in `NEXT_PUBLIC_API_URL`. Protected requests carry a Clerk v2 session token as `Authorization: Bearer <token>`. The backend checks signature, issuer, authorised party, active organisation and role. The organisation and reviewer are derived from the verified token.

| Method and path | Behaviour |
| --- | --- |
| `GET /health` | Check startup and database connectivity. |
| `GET /api/me` | Return the verified organisation, user and application role. |
| `GET /api/invoices` and `GET /api/invoices/{id}` | Return authorised invoice records and case state. |
| `POST /api/extract` | Accept multipart `file`, optional `senderEmail` and `message`. Return an editable draft, an extraction ID, missing fields and masked payment candidates. |
| `POST /api/invoices` | Save reviewed fields and an optional extraction ID and payment candidate ID. Saving the same extraction twice returns its existing invoice. |
| `GET /api/invoices/{id}/document` | Retrieve the private PDF through the authorised API. |
| `GET /api/suppliers`, `POST /api/suppliers`, `PATCH /api/suppliers/{id}` | Read and maintain the organisation's supplier directory. |
| `POST /api/payment-candidates` | Accept a UK sort code and account number over TLS. Return a masked, user-scoped candidate ID and an organisation-keyed comparison fingerprint. |
| `GET /api/suppliers/{id}/payment-options` | Return current authorised payment candidates for the user. |
| `POST /api/suppliers/{id}/payment-proposals` | Record a candidate as a pending baseline change. |
| `POST /api/suppliers/{id}/payment-proposals/{proposalId}/approve` | Approve independently verified payment details. Controller role and separation of proposer and approver are enforced. |
| `POST /api/investigate` | Accept `{ invoiceId }`, return `202 { investigationId, phase }` and start work independently of the SSE connection. |
| `GET /api/investigations/{id}` and `GET /api/investigations/{id}/events` | Return the current case or stream saved events. |
| `POST /api/cases/{invoiceId}/verification-request` | Persist an internal verification request for a held case. |
| `POST /api/cases/{invoiceId}/verify` | Append the method, outcome, trusted contact source and notes. Controller role is enforced. |
| `GET /api/reports` and `GET /api/investigations/{id}/report` | Return the latest audit version per case or for a specific investigation. |
| `GET /api/evals` | Return an empty collection until measured live evaluations are published. The frontend retains synthetic fixtures in mock mode. |

See the [frontend types](../src/lib/types.ts) and [backend Pydantic schemas](../backend/app/schemas.py). PDFs, original unredacted messages and raw bank numbers are excluded from invoice and report JSON. Payment authorisation remains outside this workflow.

## Events

Use authenticated fetch for SSE. Frames include `id`, `investigationId`, monotonic `sequence`, `timestamp`, `type`, `status`, `finding`, `source`, `mode` and optional tool, latency, model and execution metadata. Structured evidence is carried in `payload`.

The server emits `investigation_started`, `tool_started`, `tool_completed`, `tool_failed`, `agent_observation`, `policy_evaluated`, `investigation_completed` and `investigation_failed` as applicable. Reconnect with `?after=N` or `Last-Event-ID: <investigationId>-N`. Saved records replay in ascending sequence before following new events. Terminal events close the stream. Heartbeat comments keep idle streams open.

Cross-organisation resources return `404`. Invalid tokens return `401`. Insufficient membership or role returns `403`. Other common statuses include `409` for conflicting state, `413` for oversized bodies, `415` for unsupported media, `422` for validation or unsupported PDFs, `429` for request or job capacity, and `503` for unavailable dependencies.
