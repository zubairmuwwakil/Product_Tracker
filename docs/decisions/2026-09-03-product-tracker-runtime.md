# 2026-09-03 — Product Tracker Runtime: Vercel + Neon + Event-Driven Async Work

**Status:** Adopted target architecture. The Neon mirror is live; runtime cutover is not yet complete.

The cross-system governing decision is also recorded in `zubairmuwwakil/LLM4LIFE`.

## Decision

Use this as the target runtime:

```text
ChatGPT / clients / Notion webhook
              |
              v
        Product Tracker API
          Vercel Functions
              |
              v
             Neon
 canonical inventory/event state
              |
              v
 durable asynchronous processing
 Vercel Queue/Workflow primitive
              |
              v
 Notion projection / notifications / future clients
```

Neon remains the canonical database. Vercel is a replaceable runtime.

## Why

The existing implementation contains a continuously running inbox/outbox polling worker. A temporary Render design would have preserved that process, but hosting should not be chosen around an avoidable polling loop.

The target should instead fit the user's existing Vercel stack and use event-driven/durable asynchronous processing. Normal inventory mutations already originate from API commands or webhooks, so those events should trigger async projection/retry work directly.

## Rules

- Keep Fastify/domain code portable; do not move business logic into hosting-specific handlers.
- Inventory mutations remain durable domain events.
- External writes remain idempotent.
- Webhook receipts remain deduplicated.
- Preserve a database outbox/dispatch record where needed to avoid transaction-vs-publish dual-write races.
- Retry external projection without duplicating canonical inventory events.
- Keep a reconciliation path for missed events/drift.
- Do not use frequent Hobby Cron as an emulation of the old permanent worker.
- Notion remains the live control surface until end-to-end runtime verification is complete.

## Migration sequence

1. Keep the verified Neon mirror unchanged.
2. Make the Fastify API Vercel-compatible.
3. Refactor normal polling-worker work into durable event/queue/workflow consumers.
4. Preserve database outbox/dispatch semantics where required for atomicity.
5. Deploy to Vercel.
6. Verify health and authenticated reads.
7. Verify an inventory mutation is exactly-once at the domain-event level under retries.
8. Verify Notion webhook authentication/deduplication.
9. Verify durable asynchronous projection/retries.
10. Verify drift reconciliation.
11. Only then make Product Tracker/Neon authoritative and demote Notion to projection/rollback.

## Superseded direction

The earlier Render single-web-service Blueprint and `RUN_WORKER_IN_PROCESS=true` hosted target are superseded. Transitional worker-loop code may remain temporarily while the event-driven refactor is implemented.
