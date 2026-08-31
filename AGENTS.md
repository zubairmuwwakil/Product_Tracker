# Product Tracker agent rules

## Source of truth

- PostgreSQL is the durable source of truth for inventory state and history.
- Notion is a human-facing projection/control surface.
- Stable `InventoryNeed.key` and `Product.key` values are identities. Titles are labels only.

## Mutation rule

Never directly change `InventoryBalance` from an API route, agent command, or future UI. All meaningful inventory changes go through the inventory domain service and create an `InventoryEvent` in the same serializable transaction as the balance update.

The only exception is bootstrap creation of a missing balance, and that creation must also write a `BASELINE` event.

## External side effects

Notion writes are never part of the inventory transaction. Commit an `OutboxEvent`, then let the worker project the committed state. Make every side effect idempotent.

## Notion synchronization

- Treat webhook payloads as change signals, not current state.
- Always retrieve the latest page before applying a Notion-originated edit.
- Verify signed webhook payloads against the exact raw request body.
- During mirror phase, a human inventory-count edit in Notion becomes an auditable `ADJUSTMENT` event in Postgres.
- Do not use Notion's legacy `Alert State` as logic. Product Tracker derives inventory health from facts.

## Open-source references

Grocy and InvenTree are behavioral/architectural references only. No third-party source code is copied here. Do not import AGPL code from Homebox or Shelf into this repository unless the licensing strategy is intentionally changed and documented first.

## Checks

Before merging material code changes:

```bash
npm run check
```

Never commit real secrets, database URLs, Notion tokens, webhook verification tokens, or bearer tokens.
