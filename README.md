# Product Tracker

Postgres-backed personal inventory service with Neon as durable state, Cloudflare as the production runtime, and Notion as a transitional human control/projection surface.

## Architecture

```text
Notion / ChatGPT / clients
          |
          v
 Cloudflare Worker
 API + webhook ingress
          |
          v
      Hyperdrive
          |
          v
         Neon
 canonical inventory + events
 outbox + webhook receipts
          |
          v
 Cloudflare Queue
 async projection / retries
          |
          v
 Notion projection / future effects
```

Neon owns durable inventory truth. Cloudflare owns runtime execution, queue delivery, retry infrastructure, and pooled database connectivity through Hyperdrive.

## Production state

### Mirror/data layer — verified

The production database is `product_tracker` inside the existing LLM4LIFE Neon project.

Verified snapshot:

- 25 active inventory Needs;
- 26 active Products;
- 26 inventory balances;
- 26 import baseline events;
- zero orphan Product/balance relationships;
- zero balance-vs-baseline mismatches;
- derived state: 5 `BUY_NOW`, 1 `RESTOCK`, 19 `STOCKED`.

The 25/26 relationship is expected because one functional Need has two active SKUs.

### Cloudflare Phase 2 — production verified

Live Worker:

```text
llm4life-product-tracker
```

Verified production behavior:

- `GET /health` succeeds;
- authenticated `GET /v1/needs` returns the 25-Need Neon snapshot;
- signed Notion webhook requests are accepted;
- webhook receipts are durably persisted in Neon;
- Cloudflare Queue processes webhook receipts on the first attempt without errors;
- the protected `/internal/relay` reports zero pending webhook/outbox work when clean;
- a reversible Notion property edit and its restoration were both received and processed after Hyperdrive deployment;
- production Prisma baseline is recorded;
- Cloudflare Hyperdrive is bound for Neon connectivity;
- Hyperdrive uses the dedicated least-privilege Neon role `product_tracker_runtime`, not the database-owner credential.

## Ownership status

Product Tracker/Neon is the target canonical personal-care inventory owner.

Notion is still a **transitional human control/projection surface** until the remaining mutation/retry gates below are deliberately verified. Do not silently dual-write around the domain service.

## Design rules

- **PostgreSQL owns durable inventory state after final write cutover.**
- **Inventory changes are events.** API handlers do not directly mutate balances.
- **Notion becomes a projection/control surface.** Human edits are translated into audited events.
- **Stable keys beat titles.** `need.personal-care.*` and `product.*` keys are canonical identifiers.
- **Derived state stays derived.** On-hand, urgency and buy quantity come from facts and policy.
- **Every external write is idempotent.** API callers provide an `Idempotency-Key`.
- **External side effects are durable and retry-safe.** A committed inventory mutation never depends on Notion being online.
- **Prefer event-driven processing to permanent polling.** Reconciliation only recovers durable pending work that missed normal Queue delivery.
- **Use least-privilege runtime credentials.** Migrations and runtime writes use separate authority boundaries.

## Runtime implementation

`src/cloudflare-worker.ts` provides:

- `GET /health`;
- authenticated `GET /v1/needs`;
- authenticated + idempotent `POST /v1/inventory/events`;
- signed `POST /webhooks/notion` ingestion;
- Cloudflare Queue consumption;
- protected `POST /internal/relay`;
- low-frequency scheduled reconciliation.

`wrangler.jsonc` defines:

- Worker: `llm4life-product-tracker`;
- Queue: `llm4life-product-tracker-events`;
- DLQ: `llm4life-product-tracker-events-dlq`;
- Queue batching/retries;
- 5-minute reconciliation trigger;
- Hyperdrive binding;
- Cloudflare observability.

The legacy Fastify server and standalone worker remain useful for local development/migration fallback. They are not the long-term production runtime.

## Reliability model

```text
API / webhook
      |
      v
 Neon transaction
 event/balance + outbox/receipt
      |
      v
 Cloudflare Queue
      |
      v
 Notion projection / external effect
```

If the database commit succeeds but Queue publication fails, the Neon outbox/receipt row remains durable. The scheduled relay republishes only Product Tracker's own pending delivery ledger; it does **not** poll Notion.

## Core API

- `GET /health`
- `GET /v1/needs`
- `POST /v1/inventory/events`
- `POST /webhooks/notion`
- `POST /internal/relay`

All `/v1/*` routes require `Authorization: Bearer $API_BEARER_TOKEN`. Inventory mutations also require `Idempotency-Key`.

## Remaining final-cutover tests

Do not demote Notion to projection/rollback-only until these are deliberately verified:

1. duplicate/retried `POST /v1/inventory/events` requests produce exactly one canonical inventory event;
2. a real intentional inventory mutation produces the expected outbound Notion projection;
3. retry behavior does not duplicate canonical events or side effects;
4. reconciliation recovers a deliberately pending durable delivery row;
5. DLQ/retry behavior is observable.

After those pass, route all human/agent personal-care inventory mutations through Product Tracker and make Notion optional projection/rollback UI.

## Migration phases

1. **Mirror — complete.**
2. **Cloudflare implementation — complete.**
3. **Cloudflare Phase 2 webhook/Queue/Hyperdrive verification — complete.**
4. **Write-path/idempotency/retry cutover tests — next.**
5. **Postgres-authoritative human/agent write cutover.**
6. **Forecasting from consumption history.**

## Existing production database baseline

The production database was initialized from `20260831114000_init` before Prisma migration history existed. The one-time production baseline is now recorded. Future schema changes use:

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
