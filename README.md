# Product Tracker

Postgres-backed personal inventory service with Notion as a transitional human control surface and an agent-safe API for inventory mutations.

## Architecture

```text
Notion (transitional editable UI) / ChatGPT / clients
                  |
                  v
          Product Tracker API
                  |
                  v
        PostgreSQL / Neon
   canonical inventory + events
                  |
                  v
       durable async processing
                  |
                  v
 Notion projection / notifications / future clients
```

## Production state

The mirror phase is live in the existing LLM4LIFE Neon project using a dedicated `product_tracker` database.

Verified mirror snapshot:

- 25 active inventory needs;
- 26 active products;
- 26 inventory balances;
- 26 import baseline events;
- zero orphan product/balance relationships;
- zero balance-vs-baseline mismatches.

The database mirror is **not yet the final write cutover**. Until the hosted API + durable async runtime is deployed and verified, Notion remains the live human control/source surface. Do not silently dual-write around the domain service.

## Design rules

- **PostgreSQL owns durable inventory state after runtime cutover.**
- **Inventory changes are events.** Do not directly mutate balances from API handlers.
- **Notion becomes a projection/control surface.** Human edits are translated into audited adjustment events.
- **Stable keys beat titles.** `need.personal-care.*` and `product.*` keys are canonical identifiers.
- **Derived state stays derived.** On-hand, urgency and buy quantity come from inventory facts and policy.
- **Every external write is idempotent.** Agent/API callers provide an `Idempotency-Key`.
- **External side effects are durable and retry-safe.** A committed inventory mutation never depends on Notion being online.
- **Prefer event-driven processing to permanent polling.** Reconciliation may poll when necessary, but the normal write path should react to events/webhooks.

## Reuse decision

We intentionally did **not** fork a full inventory application. See [`docs/BUILD_VS_ADOPT.md`](docs/BUILD_VS_ADOPT.md).

The implementation reuses proven *patterns* from mature inventory projects without importing their product/domain baggage:

- Grocy: purchase/open/consume/correction transaction semantics, minimum-stock replenishment and stock journal concepts.
- InvenTree: immutable stock tracking, strong REST boundaries, event/plugin architecture and Postgres-first deployment patterns.
- Homebox: useful reference for home-oriented entity organization, but its durable-asset focus is not the replenishment model needed here.

No third-party application source code is copied into this repository.

## Runtime

Current implementation:

- Node.js 24
- TypeScript
- Fastify
- Prisma 7 + PostgreSQL
- Notion SDK
- Vitest

The repository currently contains a reusable inbox/outbox worker loop that can run separately or in-process. That refactor is useful during migration, but **the infinite polling loop is not the long-term hosted architecture**.

### Target hosted runtime

The adopted target is:

```text
Fastify API -> Vercel Functions
                 |
                 v
                Neon
 canonical inventory/event state
                 |
                 v
 durable Vercel Queue/Workflow consumer
                 |
                 v
 Notion projection / future side effects
```

Do not choose a hosting provider merely to preserve the existing `while` polling loop. The API/domain service should remain portable, while asynchronous work moves toward durable event-driven consumers.

Vercel is a **runtime**, not the source of truth. Neon remains canonical.

Frequent Vercel Hobby Cron polling is intentionally **not** the target. Normal processing should be triggered by API writes/webhooks and durable async delivery; reconciliation may run separately at an appropriate low frequency if needed.

The governing runtime decision is documented in LLM4LIFE:

- `docs/decisions/2026-09-03-product-tracker-runtime.md`

## Local setup

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate:dev
npm run bootstrap:notion
npm run dev
```

During the transitional implementation, the existing worker can still be run separately:

```bash
npm run dev:worker
```

## Existing production database baseline

The production `product_tracker` database was initialized from the committed `20260831114000_init` schema before Prisma migration history existed. Record that one existing migration exactly once **before using `prisma migrate deploy` against production**:

```bash
npm run db:baseline
```

Run this with `DIRECT_URL` (preferred) or `DATABASE_URL` pointed at the production `product_tracker` database. After the baseline is recorded, future schema changes use the normal flow:

```bash
npm run db:migrate:deploy
```

Do not run `db:push` against production.

## Core API

- `GET /health`
- `GET /v1/needs` — inventory health / shopping state
- `POST /v1/inventory/events` — purchase, open, finish, return, discard or adjust inventory
- `POST /webhooks/notion` — signed Notion change notifications

All `/v1/*` routes require `Authorization: Bearer $API_BEARER_TOKEN`. Inventory mutations additionally require `Idempotency-Key`.

## Migration phases

1. **Mirror — complete:** the current Notion Shopping Needs + Personal Care Products snapshot is mirrored and parity-verified in Neon.
2. **Runtime refactor — current:** adapt Fastify to Vercel and replace normal permanent polling with durable event/queue/workflow processing while preserving the transactional domain model.
3. **Runtime verification:** deploy API + async processing and verify reads, webhook ingestion, retries, projection, and reconciliation while Notion remains editable.
4. **Postgres-authoritative:** all meaningful inventory mutations flow through Product Tracker; Notion becomes projection/rollback UI.
5. **Forecasting:** consumption history drives estimated depletion and reorder-by dates.

### Cutover gate

Do not demote Notion until all of these are verified against the hosted service:

1. `/health` succeeds;
2. authenticated `GET /v1/needs` matches the Neon mirror;
3. an API mutation records exactly one durable inventory event under retries;
4. a Notion webhook is authenticated, deduplicated, and processed;
5. durable async projection successfully updates the external projection;
6. retries do not duplicate inventory events or side effects;
7. reconciliation can identify and recover drift/missed events;
8. only then switch human/agent writes to Product Tracker and make Notion a projection/rollback surface.
