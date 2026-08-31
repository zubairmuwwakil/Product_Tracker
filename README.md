# Product Tracker

Postgres-backed personal inventory service with Notion as the human control surface and an agent-safe API for inventory mutations.

## Architecture

```text
Notion (editable UI)
  -> signed webhook
Product Tracker API
  -> PostgreSQL (source of truth)
  -> Inventory events + current balance + transactional outbox
  -> Notion projection worker
AI / agents
  -> authenticated inventory commands
  -> same domain service
```

## Design rules

- **PostgreSQL owns durable inventory state.**
- **Inventory changes are events.** Do not directly mutate balances from API handlers.
- **Notion is a projection/control surface.** Human edits are translated into audited adjustment events.
- **Stable keys beat titles.** `need.personal-care.*` and `product.*` keys are canonical identifiers.
- **Derived state stays derived.** On-hand, urgency and buy quantity come from inventory facts and policy.
- **Every write is idempotent.** Agent/API callers provide an `Idempotency-Key`.
- **External side effects use the outbox.** A committed inventory mutation never depends on Notion being online.

## Reuse decision

We intentionally did **not** fork a full inventory application. See [`docs/BUILD_VS_ADOPT.md`](docs/BUILD_VS_ADOPT.md).

The implementation reuses proven *patterns* from mature inventory projects without importing their product/domain baggage:

- Grocy: purchase/open/consume/correction transaction semantics, minimum-stock replenishment and stock journal concepts.
- InvenTree: immutable stock tracking, strong REST boundaries, event/plugin architecture and Postgres-first deployment patterns.
- Homebox: useful reference for home-oriented entity organization, but its durable-asset focus is not the replenishment model needed here.

No third-party application source code is copied into this repository.

## Planned runtime

- Node.js 24
- TypeScript
- Fastify
- Prisma 7 + PostgreSQL 17
- Notion SDK
- Vitest

## Local setup

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate:dev
npm run bootstrap:notion
npm run dev
```

Run the outbox worker separately:

```bash
npm run dev:worker
```

## Core API

- `GET /health`
- `GET /v1/needs` — inventory health / shopping state
- `POST /v1/inventory/events` — purchase, open, finish, return, discard or adjust inventory
- `POST /webhooks/notion` — signed Notion change notifications

All `/v1/*` writes require `Authorization: Bearer $API_BEARER_TOKEN` and `Idempotency-Key`.

## Migration phases

1. **Mirror:** import the current Notion Shopping Needs + Personal Care Products into Postgres while Notion remains editable.
2. **Dual-write through domain service:** API/AI writes commit to Postgres, then the outbox updates Notion.
3. **Postgres-authoritative:** Notion becomes a projection; all meaningful inventory mutations flow through Product Tracker.
4. **Forecasting:** consumption history drives estimated depletion and reorder-by dates.
