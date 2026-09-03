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

Normal path:

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

If the database commit succeeds but queue publication fails, the durable Neon outbox/receipt row remains pending. The scheduled Cloudflare relay republishes due pending rows. This is why the database outbox remains useful even after adopting Queue.

The scheduled handler does **not** poll Notion. It only reconciles Product Tracker's own durable delivery ledger.

The governing runtime decision is recorded in [`docs/decisions/2026-09-03-product-tracker-runtime.md`](docs/decisions/2026-09-03-product-tracker-runtime.md).

## Local Node setup

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate:dev
npm run bootstrap:notion
npm run dev
```

The transitional standalone worker can still be run with:

```bash
npm run dev:worker
```

## Cloudflare development

Copy the placeholder file and fill secrets locally:

```bash
cp .dev.vars.example .dev.vars
npm install
npm run cloudflare:dev
```

Never commit `.dev.vars`.

Bundle validation:

```bash
npm run cloudflare:dry
```

The same Wrangler dry run is enforced in CI.

## Existing production database baseline

The production `product_tracker` database was initialized from the committed `20260831114000_init` schema before Prisma migration history existed. Record that one existing migration exactly once **before using `prisma migrate deploy` against production**:

```bash
npm run db:baseline
```

Run this with `DIRECT_URL` (preferred) or `DATABASE_URL` pointed at the production `product_tracker` database. After the baseline is recorded, future schema changes use:

```bash
npm run db:migrate:deploy
```

Do not run `db:push` against production.

## Cloudflare deployment prerequisites

Create the primary Queue once:

```bash
npm run cloudflare:queue:create
```

The consumer configuration references `llm4life-product-tracker-events-dlq` as the dead-letter queue.

Set these Worker secrets interactively with Wrangler; never paste them into source control:

- `DATABASE_URL`
- `API_BEARER_TOKEN`
- `NOTION_TOKEN`
- `NOTION_SHOPPING_NEEDS_DATA_SOURCE_ID`
- `NOTION_PRODUCTS_DATA_SOURCE_ID`
- `NOTION_INVENTORY_EVENTS_DATA_SOURCE_ID`
- `NOTION_WEBHOOK_VERIFICATION_TOKEN`

Then deploy with:

```bash
npm run cloudflare:deploy
```

The first production deployment uses the existing pooled Neon PostgreSQL URL directly. Hyperdrive is a later connection/pooling optimization after functional runtime verification; it is not required for the first cutover.

## Core API

- `GET /health`
- `GET /v1/needs` — inventory health / shopping state
- `POST /v1/inventory/events` — purchase, open, finish, return, discard or adjust inventory
- `POST /webhooks/notion` — signed Notion change notifications
- `POST /internal/relay` — protected manual delivery-ledger reconciliation

All `/v1/*` routes require `Authorization: Bearer $API_BEARER_TOKEN`. Inventory mutations additionally require `Idempotency-Key`.

## Migration phases

1. **Mirror — complete:** current Notion Shopping Needs + Personal Care Products are mirrored and parity-verified in Neon.
2. **Cloudflare runtime implementation — current:** Worker + Queue + reconciliation path committed and CI-validated before deployment.
3. **Runtime verification:** deploy and verify reads, webhook ingestion, queue retries, projection and reconciliation while Notion remains editable.
4. **Postgres-authoritative:** all meaningful inventory mutations flow through Product Tracker; Notion becomes projection/rollback UI.
5. **Connection hardening:** evaluate Hyperdrive once the runtime path is proven.
6. **Forecasting:** consumption history drives estimated depletion and reorder-by dates.

### Cutover gate

Do not demote Notion until all of these are verified against the Cloudflare service:

1. `/health` succeeds;
2. authenticated `GET /v1/needs` matches the Neon mirror;
3. an API mutation records exactly one durable inventory event under duplicate/retried requests;
4. a Notion webhook is authenticated, deduplicated and queued;
5. Queue processing successfully performs outbound Notion projection;
6. retries do not duplicate inventory events or side effects;
7. reconciliation recovers a deliberately pending delivery row;
8. the DLQ/retry path is observable;
9. only then switch human/agent writes to Product Tracker and make Notion a projection/rollback surface.
