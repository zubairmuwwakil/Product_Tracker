# 2026-09-03 — Product Tracker Runtime: Cloudflare Workers + Queues + Neon

**Status:** Adopted target architecture. The Neon mirror is live; Cloudflare runtime implementation is in progress and write cutover is not yet complete.

The cross-system governing decision is also recorded in `zubairmuwwakil/LLM4LIFE`.

## Decision

Use this as the target runtime:

```text
ChatGPT / clients / Notion webhook
              |
              v
      Cloudflare Worker
   HTTP ingress / auth / API
              |
              v
             Neon
 canonical inventory/event state
 transactional outbox + receipts
              |
              v
      Cloudflare Queue
 async projection / retries
              |
              v
 Notion projection / future effects
```

A low-frequency Cloudflare scheduled handler may relay durable Neon outbox/webhook rows that were committed but were not successfully published to Queue. It is a reconciliation safety net, not the normal processing path and does not poll Notion.

Neon remains the canonical database. Cloudflare is compute, ingress, queueing, retry and workflow infrastructure; it does not own inventory truth.

## Why

Product Tracker originally used a conventional Node/Fastify API plus a continuously running PostgreSQL polling worker. Choosing a traditional always-on host merely to preserve that loop would optimize for an implementation detail instead of the desired architecture.

Cloudflare now provides the required primitives in one platform:

- Workers for HTTP/API execution;
- Queues for durable asynchronous delivery, batching and retries;
- scheduled handlers for reconciliation;
- Workflows if future multi-step durable processes justify them;
- PostgreSQL connectivity to Neon, with Hyperdrive available as a future connection optimization.

This also consolidates LLM4LIFE infrastructure because Cloudflare is already production-live for the Google Tasks projection.

## Reliability model

The database transaction remains the durable boundary:

1. commit inventory event/balance changes and outbox rows atomically in Neon;
2. publish the resulting outbox work to Cloudflare Queue;
3. queue consumers perform external side effects;
4. processed state is persisted back to Neon;
5. the reconciliation trigger republishes any due durable rows that were never successfully queued or became stale.

This avoids pretending a PostgreSQL transaction and a remote queue publish can be one atomic operation.

## Rules

- Inventory mutations remain durable domain events.
- External writes remain idempotent.
- Webhook receipts remain deduplicated.
- Queue delivery is at-least-once; canonical inventory writes must therefore be safe to retry.
- Preserve the Neon outbox/receipt ledger even though Queue handles normal asynchronous delivery.
- Do not recreate the old continuous polling loop inside Workers.
- Reconciliation may inspect only durable pending delivery state at a low frequency.
- Keep business/domain logic separate from Cloudflare-specific ingress/delivery code where practical.
- Notion remains the live control surface until end-to-end runtime verification is complete.
- Hyperdrive is an optimization after functional runtime validation, not a prerequisite for first deployment.

## Migration sequence

1. Keep the verified Neon mirror unchanged.
2. Add a Cloudflare Worker HTTP entrypoint for health, authenticated reads/writes and Notion webhooks.
3. Refactor worker processing into exact-by-ID handlers reusable by Queue consumers and the legacy Node loop.
4. Bind a Cloudflare Queue and dead-letter queue.
5. Publish normal webhook/outbox work immediately after durable database commit.
6. Add a low-frequency reconciliation trigger for missed queue publishes/stale claims.
7. Validate TypeScript, Prisma migrations, tests, security audit and Wrangler dry-run in CI.
8. Provision the Queue and Worker secrets in Cloudflare.
9. Deploy the Worker.
10. Verify `/health` and authenticated `/v1/needs` against the Neon mirror.
11. Verify exactly-once domain behavior under duplicate/retried inventory requests.
12. Verify Notion webhook signature validation/deduplication and Queue processing.
13. Verify outbound Notion projection and retry behavior.
14. Only then make Product Tracker/Neon authoritative and demote Notion to projection/rollback.

## Superseded directions

The earlier Render single-service design and the subsequent Vercel Functions/Queue target are superseded. Cloudflare is now the preferred Product Tracker runtime because it provides the needed event-driven primitives while reducing infrastructure-platform sprawl across LLM4LIFE.
