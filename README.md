# Product Tracker

Postgres-backed personal inventory service with Notion as a transitional human control surface and an agent-safe API for inventory mutations.

## Architecture

```text
Notion (transitional UI) / ChatGPT / clients
                  |
                  v
          Cloudflare Worker
      HTTP API / webhook ingress
                  |
                  v
             Neon/Postgres
      canonical inventory + events
      outbox + webhook receipts
                  |
                  v
          Cloudflare Queue
       async projection / retries
                  |
                  v
 Notion projection / future side effects
```

Neon owns durable inventory truth. Cloudflare owns runtime execution, queue delivery and retry infrastructure.

## Production state

The mirror phase is live in the existing LLM4LIFE Neon project using a dedicated `product_tracker` database.

Verified mirror snapshot:

- 25 active inventory needs;
- 26 active products;
- 26 inventory balances;
- 26 import baseline events;
- zero orphan product/balance relationships;
- zero balance-vs-baseline mismatches.

The database mirror is **not yet the final write cutover**. Until the Cloudflare API + Queue runtime is deployed and verified, Notion remains the live human control/source surface. Do not silently dual-write around the domain service.

## Design rules

- **PostgreSQL owns durable inventory state after runtime cutover.**
- **Inventory changes are events.** Do not directly mutate balances from API handlers.
- **Notion becomes a projection/control surface.** Human edits are translated into audited adjustment events.
- **Stable keys beat titles.** `need.personal-care.*` and `product.*` keys are canonical identifiers.
- **Derived state stays derived.** On-hand, urgency and buy quantity come from inventory facts and policy.
- **Every external write is idempotent.** Agent/API callers provide an `Idempotency-Key`.
- **External side effects are durable and retry-safe.** A committed inventory mutation never depends on Notion being online.
- **Prefer event-driven processing to permanent polling.** Reconciliation exists only to recover durable pending work that missed normal queue delivery.

## Reuse decision

We intentionally did **not** fork a full inventory application. See [`docs/BUILD_VS_ADOPT.md`](docs/BUILD_VS_ADOPT.md).

The implementation reuses proven *patterns* from mature inventory projects without importing their product/domain baggage:

- Grocy: purchase/open/consume/correction transaction semantics, minimum-stock replenishment and stock journal concepts.
- InvenTree: immutable stock tracking, strong REST boundaries, event/plugin architecture and Postgres-first deployment patterns.
- Homebox: useful reference for home-oriented entity organization, but its durable-asset focus is not the replenishment model needed here.

No third-party application source code is copied into this repository.

## Runtime

Shared domain/runtime stack:

- Node.js 24 / Cloudflare Workers Node compatibility
- TypeScript
- Prisma 7 + PostgreSQL
- Notion SDK
- Vitest

The existing Fastify server and standalone worker remain useful for local development and migration fallback. They are **not** the long-term production runtime.

### Cloudflare production target

`src/cloudflare-worker.ts` implements:

- `GET /health`;
- authenticated `GET /v1/needs`;
- authenticated/idempotent `POST /v1/inventory/events`;
- signed `POST /webhooks/notion` ingestion;
- Cloudflare Queue consumption;
- a protected manual reconciliation endpoint;
- a low-frequency scheduled reconciliation relay.

`wrangler.jsonc` defines:

- Worker: `llm4life-product-tracker`;
- Queue: `llm4life-product-tracker-events`;
- DLQ: `llm4life-product-tracker-events-dlq`;
- Queue batching/retries;
- a 5-minute reconciliation trigger;
- Cloudflare observability.

### Reliability model

```text
API/webhook
   |
   v
Neon transaction
 event/balance + outbox/receipt
   |
   v
Cloudflare Queue
   |
   v
Notion projection / external side effect
```

If the database commit succeeds but queue publication fails, the durable Neon outbox/receipt row remains pending and the scheduled Cloudflare relay republishes it. The scheduled handler does **not** poll Notion; it only reconciles Product Tracker's own delivery ledger.

The governing runtime decision is recorded in [`docs/decisions/2026-09-03-product-tracker-runtime.md`](docs/decisions/2026-09-03-product-tracker-runtime.md).

## Local development

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate:dev
npm run bootstrap:notion
npm run dev
```

Transitional standalone worker:

```bash
npm run dev:worker
```

Cloudflare local development:

```bash
cp .dev.vars.example .dev.vars
npm install
npm run cloudflare:dev
```

Never commit `.dev.vars`. Validate the Worker bundle with:

```bash
npm run cloudflare:dry
```

The same dry run is enforced in CI.

## Existing production database baseline

The production `product_tracker` database was initialized from `20260831114000_init` before Prisma migration history existed. Record that migration exactly once **before normal production `prisma migrate deploy` use**:

```bash
npm run db:baseline
```

Run it with `DIRECT_URL` (preferred) or `DATABASE_URL` pointed at production. Afterward, future schema changes use:

```bash
npm run db:migrate:deploy
```

Do not run `db:push` against production.

## Cloudflare deployment prerequisites

Create the main Queue and DLQ separately so rerunning one provisioning step does not hide or block the other:

```bash
npm run cloudflare:queue:create
npm run cloudflare:dlq:create
```

If Cloudflare reports that either queue already exists, verify the named queue and continue with the missing one rather than treating an existing queue as a deployment failure.

Set Worker secrets interactively with Wrangler; never commit or paste them into public source:

- `DATABASE_URL`
- `API_BEARER_TOKEN`
- `NOTION_TOKEN`
- `NOTION_SHOPPING_NEEDS_DATA_SOURCE_ID`
- `NOTION_PRODUCTS_DATA_SOURCE_ID`
- `NOTION_INVENTORY_EVENTS_DATA_SOURCE_ID`
- `NOTION_WEBHOOK_VERIFICATION_TOKEN`

Then deploy:

```bash
npm run cloudflare:deploy
```

The first production deployment uses the existing pooled Neon URL directly. Hyperdrive is a later connection/pooling optimization after functional runtime verification.

## Core API

- `GET /health`
- `GET /v1/needs`
- `POST /v1/inventory/events`
- `POST /webhooks/notion`
- `POST /internal/relay`

All `/v1/*` routes require `Authorization: Bearer $API_BEARER_TOKEN`. Inventory mutations also require `Idempotency-Key`.

## Migration phases

1. **Mirror — complete.**
2. **Cloudflare implementation — complete/CI-green; deployment pending.**
3. **Runtime verification — next.**
4. **Postgres-authoritative cutover.**
5. **Connection hardening / Hyperdrive evaluation.**
6. **Forecasting from consumption history.**

### Cutover gate

Do not demote Notion until:

1. `/health` succeeds;
2. authenticated `GET /v1/needs` matches Neon;
3. duplicate/retried API requests produce exactly one canonical inventory event;
4. Notion webhook is authenticated, deduplicated and queued;
5. Queue processing performs outbound Notion projection;
6. retries do not duplicate events or side effects;
7. reconciliation recovers a deliberately pending delivery row;
8. DLQ/retry behavior is observable;
9. only then switch human/agent writes to Product Tracker and make Notion projection/rollback-only.
