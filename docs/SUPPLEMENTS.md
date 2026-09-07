# Supplement tracking

Supplements share Product Tracker's canonical inventory engine. They are not a separate database or a parallel inventory system.

## Domain model

```text
InventoryNeed
├── SupplementPlan           personal regimen / target
└── Product                  purchasable physical SKU
    └── SupplementProfile    label/container facts
        └── SupplementIngredient[]

Product
├── InventoryBalance
└── InventoryEvent[]
```

### Ownership rules

- `InventoryNeed` answers **what functional item should be kept stocked?**
- `SupplementPlan` answers **what is the current intended regimen?**
- `Product` answers **which specific physical SKU is owned/bought?**
- `SupplementProfile` answers **what does this SKU's label/container say?**
- `SupplementIngredient` stores variable ingredient facts without creating one database column per nutrient.
- `InventoryBalance` and `InventoryEvent` remain the only inventory state/history mechanism.

A brand switch therefore does not change the regimen. Example: the `Creatine Monohydrate` Need can keep a 3–5 g/day plan while its active Product changes from one brand to another.

## Product types

Existing rows migrate to:

```text
PERSONAL_CARE
```

New supplement SKUs use:

```text
SUPPLEMENT
```

`OTHER` is a safe extension point for future inventory domains without turning category-specific fields into a universal Product blob.

## API

Authenticated endpoints include:

```text
GET /v1/needs
GET /v1/supplements
POST /v1/inventory/events
```

`GET /v1/supplements` returns active supplement plans together with inventory health, active supplement products, serving facts and ingredients.

## Idempotency

New InventoryEvents persist a SHA-256 semantic request fingerprint. Replaying the same idempotency key with the same command returns the existing event. Reusing the key for a different command returns:

```json
{"error":"idempotency_key_conflict"}
```

Events created before this migration have a null fingerprint and preserve the previous replay behavior.

## History protection

Production runtime permissions are explicit. `product_tracker_runtime` may:

- `SELECT` and `INSERT` InventoryEvents;
- update only `InventoryEvent.notionEventPageId` for the external projection;
- not delete InventoryEvents;
- not rewrite inventory audit fields.

Foreign keys from InventoryEvent to Product/InventoryNeed use `RESTRICT`, preventing parent deletion from erasing history. Catalog records should normally be retired with `active=false`, not physically deleted.

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

## Bootstrap the current stack

After the schema migration is deployed:

```bash
npm run bootstrap:supplements
```

The bootstrap is idempotent. It creates or refreshes the 12 functional supplement Needs and their SupplementPlans, but deliberately does **not** invent brands, products, inventory counts, prices, URLs or label facts.

Specific Product rows should be added when the actual SKU is known. This avoids silently converting a generic regimen into fake inventory.

## Future additions

Only add these when the data/use case exists:

- `InventoryLot` for expiration/lot-level tracking;
- `SupplementIntake` for adherence/consumption tracking;
- consumption forecasting for estimated run-out dates;
- a dedicated mobile UI once its authentication boundary is defined.

Do not overload `InventoryEvent` with dose/adherence events; inventory state and consumption history are separate domains.
