# Phase 2 setup

The live integration is implemented in this repository. Follow the [backend deployment runbook](../backend/README.md) to configure Clerk, apply the Supabase migrations, deploy the Render API and connect a Vercel live environment. The existing Vercel mock app can retain its current configuration.

The [API contract](api-contract.md) describes the wire format. The [investigation architecture](agent-architecture.md) explains model tool calling, the deterministic policy and recovery behaviour. Durable worker execution, OCR, retention automation and measured live evaluations are future work.
