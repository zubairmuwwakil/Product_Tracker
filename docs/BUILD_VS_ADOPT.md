# Build vs. adopt decision — 2026-08-31

We scanned mature open-source inventory/home-inventory projects before building Product Tracker.

## Decision

**Build a narrow service, reuse proven patterns, do not fork an entire inventory product.**

The unique requirement is not generic inventory CRUD. It is the combination of:

- personal consumable inventory with an explicit active/open unit plus unopened backups;
- replenishment policy (`Backup Target`, `Reorder Point`, `Buy Qty`, urgency);
- append-only inventory history suitable for depletion forecasting;
- PostgreSQL as the durable source of truth;
- Notion as a bidirectional human control surface;
- narrow, safe commands for AI agents.

A full upstream product would add significantly more domain and UI surface than we need while still requiring custom Notion/agent synchronization.

## Grocy

Repository/site: https://grocy.info/ and https://github.com/grocy/grocy

**What we reuse conceptually**

- household-consumable vocabulary;
- purchase / consume / open / correction transaction semantics;
- stock journal/history;
- minimum-stock replenishment behavior.

**Why we do not fork it**

Grocy is an excellent household product, but its application architecture and opinionated full UI are not the Postgres-first service boundary we want. Wrapping it would leave Product Tracker dependent on a second application's domain and persistence model.

## InvenTree

Repository/docs: https://github.com/inventree/InvenTree and https://docs.inventree.org/

**What we reuse conceptually**

- immutable stock-tracking history;
- strong authenticated REST boundaries;
- explicit stock-adjustment operations;
- PostgreSQL-first production deployment patterns;
- event/plugin separation for external integrations.

**Why we do not fork it**

InvenTree is deliberately manufacturing/parts oriented. Its Part, StockItem, supplier, build, allocation, serial/batch and order domains would be structural baggage for personal-care and household consumables.

## Homebox

Repository: https://github.com/sysadminsmedia/homebox

Homebox is a strong home-inventory reference and supports PostgreSQL, but its core value is durable household asset organization rather than consumption and replenishment. Its AGPL license is also a reason not to casually copy implementation code into this service.

## Shelf

Repository: https://github.com/Shelf-nu/shelf.nu

Shelf demonstrates a modern TypeScript/Postgres asset stack, but is primarily equipment/asset custody and QR workflows rather than consumable replenishment. It is AGPL and is not the backend contract we need.

## Nango / workflow tools

Nango can become high-ROI later if Product Tracker becomes multi-user and needs OAuth/token lifecycle plus managed Notion integration infrastructure. For one private workspace it adds more infrastructure than it removes.

n8n/Make/Pipedream can be useful glue for notifications or experiments, but business rules and inventory state should not live in a visual workflow engine.

## Rule going forward

Before building a substantial generic inventory capability, check Grocy and InvenTree first. If a capability is domain-neutral and mature upstream, prefer adapting the pattern or integrating through an API instead of recreating it. Keep Product Tracker focused on the personal-data, Notion-sync and agent-control layers that are actually unique.
