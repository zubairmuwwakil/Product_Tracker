# 2026-09-03 — Product Tracker Runtime: Cloudflare Workers + Queues + Neon

**Status:** Adopted and production cutover complete. Product Tracker/Neon is canonical; Notion is projection/rollback UI.

The cross-system governing decision is also recorded in `zubairmuwwakil/LLM4LIFE`.

## Decision

Use this production runtime:

```text
ChatGPT / clients
       |
       v
Cloudflare Worker
 HTTP ingress / auth / API
       |
       v
   Hyperdrive
       |
       v
      Neon
 canonical inventory/event state
 outbox + webhook receipts
 dead-letter receipts
       |
       v
Cloudflare Queue
 projection / retries / reconciliation
       |
       v
Notion projection
```

Neon is the canonical database. Cloudflare is compute, ingress, queueing, retry and workflow infrastructure; it does not own inventory truth. Notion is not an authoritative production write source.

Production sets `NOTION_INBOUND_SYNC_ENABLED=false`. Signed Notion webhooks remain authenticated and acknowledged, but are ignored for state mutation while this switch is disabled. This keeps rollback reversible without creating dual ownership.

## Why

Product Tracker originally used a conventional Node/Fastify API plus a continuously running PostgreSQL polling worker. Preserving that loop on an always-on host would have optimized for an implementation detail instead of the desired architecture.

Cloudflare provides the needed primitives in one platform: Workers for HTTP execution, Queues for durable asynchronous delivery/retries, scheduled handlers for reconciliation, and Hyperdrive for Neon connectivity. This also reduces infrastructure-platform sprawl across LLM4LIFE.

## Reliability model

The database transaction remains the durable boundary:

1. commit inventory event/balance changes and outbox rows atomically in Neon;
2. publish resulting work to Cloudflare Queue;
3. queue consumers perform external side effects;
4. processed/failed state is persisted in Neon;
5. the scheduled relay republishes due durable rows that missed normal Queue delivery;
6. application failures back off and become terminal `FAILED` at attempt 8;
7. queue-handler/platform failures use Cloudflare retries and then the DLQ;
8. production consumes the DLQ and persists each dead-letter message in `DeadLetterEvent` by Cloudflare message ID.

This avoids pretending a PostgreSQL transaction and a remote queue publish can be one atomic operation while keeping failure evidence durable.

## Verified cutover gates

- Hosted `/health` and authenticated `/v1/needs` verified.
- Duplicate/retried API mutations produce one canonical InventoryEvent.
- Signed Notion webhook authentication/deduplication verified before inbound demotion.
- Outbound Neon → Notion projection verified.
- Durable application retry/backoff and terminal attempt-8 failure verified in isolated staging.
- Reconciliation recovery of deliberately pending durable work verified.
- Cloudflare platform retry and DLQ routing verified with a deliberate staging queue-handler crash.
- Prisma/pg Worker lifecycle was changed to invocation-scoped database clients after a cross-invocation I/O failure was discovered in staging.
- Production `v0.3.0` cutover health reported `notionInboundSyncEnabled=false`, with zero pending webhook/outbox work.

## Rules

- Inventory mutations are durable domain events.
- External writes are idempotent/replay-safe.
- Queue delivery is at-least-once.
- Preserve the Neon outbox, webhook receipt and dead-letter ledgers.
- Do not recreate a continuous polling loop inside Workers.
- Reconciliation is a low-frequency safety net only.
- Keep business/domain logic separate from Cloudflare-specific delivery code where practical.
- Runtime database clients must be invocation-scoped in Cloudflare Workers.
- Product Tracker/Neon owns personal-care inventory state.
- Notion is projection/reference/rollback UI only unless inbound sync is explicitly re-enabled for recovery.
- Human/agent inventory mutations must route through Product Tracker's authenticated API.

## Remaining hardening

One narrow external exactly-once race remains for Notion event-page creation: if the remote page create succeeds but the DB update that stores `notionEventPageId` fails, a retry could create a duplicate page. The planned fix is a stable Product Tracker Event ID property in Notion, projected from the Neon InventoryEvent ID and queried before create.

After a clean post-cutover observation window, temporary reliability Worker/Queue resources and the temporary Neon reliability branch can be removed.

## Superseded directions

The earlier Render single-service design and subsequent Vercel Functions/Queue target are superseded. Cloudflare Workers + Queues + Hyperdrive + Neon is the adopted production architecture.
