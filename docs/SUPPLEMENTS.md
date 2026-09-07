# Supplement tracking

Supplements use Product Tracker's existing canonical inventory engine. They are not a separate database or a parallel inventory system.

## Domain model

```text
InventoryNeed
├── SupplementPlan           regimen / target
└── Product                  purchasable physical SKU
    └── SupplementProfile    label/container facts
        └── SupplementIngredient[]

Product
├── InventoryBalance
└── InventoryEvent[]
```

## Ownership rules

- `InventoryNeed` answers what functional item should be kept stocked.
- `SupplementPlan` stores the intended regimen independently of any brand or SKU.
- `Product` represents the specific physical SKU that is owned or purchased.
- `SupplementProfile` stores serving/container facts from that SKU's label.
- `SupplementIngredient` stores variable ingredients without adding one Product column per nutrient.
- `InventoryBalance` and `InventoryEvent` remain the only inventory state/history mechanism.

This means changing brands does not require changing the regimen attached to the functional Need.

## Product types

Existing products migrate to `PERSONAL_CARE`. Supplement SKUs use `SUPPLEMENT`. `OTHER` is an extension point for future inventory domains without turning Product into a category-specific field dump.

## API

Authenticated endpoints include:

```text
GET /v1/needs
GET /v1/supplements
POST /v1/inventory/events
```

`GET /v1/supplements` returns active supplement plans together with inventory health, active supplement products, serving facts, and ingredient facts.

## Idempotency

New InventoryEvents store a SHA-256 semantic request fingerprint. Replaying the same idempotency key with the same command returns the existing event. Reusing the key for a different command returns:

```json
{"error":"idempotency_key_conflict"}
```

Events created before this migration have a null fingerprint and preserve the prior replay behavior.

## History protection

Foreign keys from InventoryEvent to Product and InventoryNeed use `RESTRICT`, so deleting a catalog parent cannot erase inventory history. Catalog records should normally be retired with `active=false` rather than physically deleted.

The production runtime is intended to have only `SELECT`/`INSERT` on InventoryEvent plus column-level update permission for `notionEventPageId`, which is required by the external projection. Audit fields must not be rewritten by the runtime.

## Database invariants

Postgres CHECK constraints protect canonical facts even if a future script bypasses the application service. They cover:

- non-negative inventory and policy values;
- `inUseUnits` limited to 0 or 1;
- `openedAt` consistent with whether a unit is in use;
- non-negative prices and positive PAO values;
- event delta arithmetic;
- valid supplement target ranges and units;
- positive serving/container quantities;
- ingredient amount/unit consistency.

## Private regimen data

This repository is public. Personal supplement plans, dosages, notes, health context, inventory counts, purchase URLs, and label data must not be committed as seed fixtures. Populate personal stack data through private database/admin tooling after the schema is deployed.

Synthetic test fixtures are acceptable as long as they are clearly non-user data.

## Future additions

Add these only when the use case exists:

- `InventoryLot` for expiration and lot-level tracking;
- `SupplementIntake` for adherence/consumption tracking;
- consumption forecasting for estimated run-out dates;
- a dedicated mobile UI after its session/authentication boundary is defined.

Do not overload `InventoryEvent` with adherence events; inventory state and consumption history are separate domains.
