# Product Tracker

Postgres-backed personal inventory service with Neon as canonical durable state, Cloudflare Workers/Queues as the production runtime, and Notion as a projection/rollback UI.

## Architecture

```text
ChatGPT / clients
       |
       v
Cloudflare Worker
 authenticated API
       |
       v
   Hyperdrive
       |
       v
      Neon
 canonical inventory + events
 outbox + webhook receipts
 dead-letter receipts
       |
       v
Cloudflare Queue
 retries + reconciliation
       |
       v
Notion projection
```

Neon owns inventory truth. Cloudflare owns runtime execution, queue delivery, retry/reconciliation infrastructure, and database connectivity through Hyperdrive. Notion is not an authoritative write source in production.

## Production state

The production database is `product_tracker` inside the existing LLM4LIFE Neon project.

Verified baseline:

- 25 active inventory Needs;
- 26 active Products;
- 26 inventory balances;
- 26 import baseline events;
- zero orphan Product/balance relationships;
- zero balance-vs-baseline mismatches;
- derived state at migration baseline: 5 `BUY_NOW`, 1 `RESTOCK`, 19 `STOCKED`.

The 25/26 relationship is expected because one functional Need has two active SKUs.

Live Worker:

```text
llm4life-product-tracker
```

## Canonical ownership — cut over 2026-09-03

**Product Tracker/Neon is the canonical personal-care inventory owner.**

Production runs with:

```text
NOTION_INBOUND_SYNC_ENABLED=false
```

Signed Notion webhooks remain authenticated and acknowledged, but they do not mutate Neon while the switch is disabled. This preserves a reversible rollback path without allowing silent dual-write ownership.

All human/agent inventory mutations should go through Product Tracker's authenticated event API. Notion is projection/reference/rollback UI only.

## Reliability status — Phase 2 complete

Verified in production/staging before canonical cutover:

- hosted `/health` and authenticated `/v1/needs`;
- duplicate/retried API mutations produce one canonical InventoryEvent;
- signed Notion webhook authentication, deduplication, Queue delivery and processing;
- outbound Neon → Notion projection;
- durable application retries with exponential backoff and terminal `FAILED` after attempt 8;
- reconciliation recovery of deliberately pending durable work;
- Cloudflare platform retries and dead-letter routing after queue-handler crashes;
- Hyperdrive + invocation-scoped Prisma/pg lifecycle for Workers;
- cron reconciliation operates without the earlier cross-invocation database I/O failure.

One narrow external exactly-once caveat remains: if Notion page creation succeeds but persistence of `notionEventPageId` fails immediately afterward, a retry could create a duplicate page. The planned hardening is a stable Product Tracker Event ID projected into Notion and queried before create.

## Durable observability

Production reliability state is durable in Neon:

- `OutboxEvent.status=FAILED` records application-side terminal failures;
- overdue `PENDING` outbox/webhook rows are detected by scheduled reconciliation;
- the production Worker also consumes `llm4life-product-tracker-events-dlq`;
- DLQ messages are persisted in `DeadLetterEvent` using Cloudflare's unique queue message ID;
- `GET /internal/status` exposes authenticated counts for failed outbox work, overdue work, overdue webhooks and unresolved dead letters;
- the 5-minute scheduled handler emits an error log whenever attention is required.

## Design rules

- **PostgreSQL owns durable inventory state.**
- **Inventory changes are events.** API handlers do not directly mutate balances.
- **Stable keys beat titles.** `need.personal-care.*` and `product.*` keys are canonical identifiers.
- **Derived state stays derived.** On-hand, urgency and buy quantity come from facts and policy.
- **Every external write is idempotent.** API callers provide an `Idempotency-Key`.
- **External side effects are durable and retry-safe.** A committed inventory mutation never depends on Notion being online.
- **Queue delivery is at-least-once.** Domain writes and projections must be replay-safe.
- **Reconciliation is a safety net, not polling architecture.**
- **Use least-privilege runtime credentials.** Migrations and runtime writes use separate authority boundaries.

## Core API

- `GET /health`
- authenticated `GET /v1/needs`
- authenticated `GET /internal/status`
- authenticated + idempotent `POST /v1/inventory/events`
- signed `POST /webhooks/notion`
- authenticated `POST /internal/relay`

Inventory mutations require `Authorization: Bearer $API_BEARER_TOKEN` and `Idempotency-Key`.

## Runtime implementation

`src/cloudflare-worker.ts` provides HTTP ingress, Queue consumption, DLQ persistence, reconciliation and reliability status.

`wrangler.jsonc` defines:

- Worker `llm4life-product-tracker`;
- Queue `llm4life-product-tracker-events`;
- DLQ `llm4life-product-tracker-events-dlq`;
- retry/batching policy;
- the main Worker as the DLQ consumer;
- 5-minute reconciliation;
- Hyperdrive;
- Cloudflare observability;
- Notion inbound sync disabled in production.

The legacy Fastify server and standalone worker remain useful for local development/migration fallback. They are not the long-term production runtime.

## Migration phases

1. **Mirror — complete.**
2. **Cloudflare runtime — complete.**
3. **Webhook/Queue/Hyperdrive verification — complete.**
4. **Idempotency/retry/reconciliation/DLQ gates — complete.**
5. **Neon-authoritative write cutover — complete.**
6. **Post-cutover observation and observability hardening — active.**
7. **Consumption-history forecasting — future.**

## Database migrations

The production database was initialized from `20260831114000_init` before Prisma migration history existed. The one-time production baseline is recorded. Future schema changes use:

```bash
npm run db:migrate:deploy
```

Do not run `db:push` against production.

## Cloudflare deployment

Validate before deployment:

```bash
npm install
npm run cloudflare:dry
```

Deploy:

```bash
npm run cloudflare:deploy
```

Never commit Worker secrets, Neon URLs, API tokens, Notion tokens, webhook verification secrets, or private inventory payloads.

## Local development

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate:dev
npm run bootstrap:notion
npm run dev
```

Cloudflare local development:

```bash
cp .dev.vars.example .dev.vars
npm run cloudflare:dev
```

Never commit `.dev.vars`.

## Decision records

- [`docs/BUILD_VS_ADOPT.md`](docs/BUILD_VS_ADOPT.md)
- [`docs/decisions/2026-09-03-product-tracker-runtime.md`](docs/decisions/2026-09-03-product-tracker-runtime.md)
