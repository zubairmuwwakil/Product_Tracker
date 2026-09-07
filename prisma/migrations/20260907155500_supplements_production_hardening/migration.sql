-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('PERSONAL_CARE', 'SUPPLEMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "SupplementPriority" AS ENUM ('CORE', 'OPTIONAL', 'SITUATIONAL');

-- Generalize Product without changing existing personal-care semantics.
ALTER TABLE "Product"
ADD COLUMN "productType" "ProductType" NOT NULL DEFAULT 'PERSONAL_CARE';

-- Persist an exact semantic fingerprint for idempotency conflict detection.
ALTER TABLE "InventoryEvent"
ADD COLUMN "requestHash" TEXT;

-- Supplement regimen belongs to the Need; label facts belong to the Product.
CREATE TABLE "SupplementPlan" (
    "needId" TEXT NOT NULL,
    "priority" "SupplementPriority" NOT NULL,
    "targetMinAmount" DECIMAL(12,4),
    "targetMaxAmount" DECIMAL(12,4),
    "targetUnit" TEXT,
    "frequency" TEXT,
    "instructions" TEXT,
    "rationale" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplementPlan_pkey" PRIMARY KEY ("needId")
);

CREATE TABLE "SupplementProfile" (
    "productId" TEXT NOT NULL,
    "form" TEXT,
    "servingSize" DECIMAL(12,4),
    "servingUnit" TEXT,
    "servingsPerContainer" DECIMAL(12,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplementProfile_pkey" PRIMARY KEY ("productId")
);

CREATE TABLE "SupplementIngredient" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amountPerServing" DECIMAL(12,4),
    "unit" TEXT,
    "form" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplementIngredient_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Product_productType_active_idx" ON "Product"("productType", "active");
CREATE INDEX "SupplementPlan_priority_active_idx" ON "SupplementPlan"("priority", "active");
CREATE UNIQUE INDEX "SupplementIngredient_productId_key_key" ON "SupplementIngredient"("productId", "key");
CREATE INDEX "SupplementIngredient_key_idx" ON "SupplementIngredient"("key");

ALTER TABLE "SupplementPlan"
ADD CONSTRAINT "SupplementPlan_needId_fkey"
FOREIGN KEY ("needId") REFERENCES "InventoryNeed"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupplementProfile"
ADD CONSTRAINT "SupplementProfile_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupplementIngredient"
ADD CONSTRAINT "SupplementIngredient_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "SupplementProfile"("productId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Event history must survive parent lifecycle changes.
ALTER TABLE "Product" DROP CONSTRAINT "Product_needId_fkey";
ALTER TABLE "Product"
ADD CONSTRAINT "Product_needId_fkey"
FOREIGN KEY ("needId") REFERENCES "InventoryNeed"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryEvent" DROP CONSTRAINT "InventoryEvent_productId_fkey";
ALTER TABLE "InventoryEvent"
ADD CONSTRAINT "InventoryEvent_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryEvent" DROP CONSTRAINT "InventoryEvent_needId_fkey";
ALTER TABLE "InventoryEvent"
ADD CONSTRAINT "InventoryEvent_needId_fkey"
FOREIGN KEY ("needId") REFERENCES "InventoryNeed"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Canonical-state invariants also live in Postgres so scripts/admin writes cannot corrupt state.
ALTER TABLE "InventoryNeed"
ADD CONSTRAINT "InventoryNeed_backupTarget_nonnegative_chk" CHECK ("backupTarget" >= 0),
ADD CONSTRAINT "InventoryNeed_reorderPoint_nonnegative_chk" CHECK ("reorderPoint" >= 0),
ADD CONSTRAINT "InventoryNeed_reorderPoint_sane_chk" CHECK ("reorderPoint" <= "backupTarget" + 1);

ALTER TABLE "Product"
ADD CONSTRAINT "Product_price_nonnegative_chk" CHECK (price IS NULL OR price >= 0),
ADD CONSTRAINT "Product_paoMonths_positive_chk" CHECK ("paoMonths" IS NULL OR "paoMonths" > 0);

ALTER TABLE "InventoryBalance"
ADD CONSTRAINT "InventoryBalance_backup_nonnegative_chk" CHECK ("backupUnits" >= 0),
ADD CONSTRAINT "InventoryBalance_inUse_range_chk" CHECK ("inUseUnits" BETWEEN 0 AND 1),
ADD CONSTRAINT "InventoryBalance_version_nonnegative_chk" CHECK (version >= 0),
ADD CONSTRAINT "InventoryBalance_opened_state_chk" CHECK (
  ("inUseUnits" = 0 AND "openedAt" IS NULL)
  OR ("inUseUnits" = 1 AND "openedAt" IS NOT NULL)
);

ALTER TABLE "InventoryEvent"
ADD CONSTRAINT "InventoryEvent_quantity_delta_consistent_chk"
CHECK ("quantityDelta" = "backupDelta" + "inUseDelta");

ALTER TABLE "SupplementPlan"
ADD CONSTRAINT "SupplementPlan_target_min_nonnegative_chk" CHECK ("targetMinAmount" IS NULL OR "targetMinAmount" >= 0),
ADD CONSTRAINT "SupplementPlan_target_max_nonnegative_chk" CHECK ("targetMaxAmount" IS NULL OR "targetMaxAmount" >= 0),
ADD CONSTRAINT "SupplementPlan_target_range_chk" CHECK (
  "targetMinAmount" IS NULL OR "targetMaxAmount" IS NULL OR "targetMaxAmount" >= "targetMinAmount"
),
ADD CONSTRAINT "SupplementPlan_target_unit_chk" CHECK (
  ("targetMinAmount" IS NULL AND "targetMaxAmount" IS NULL) OR "targetUnit" IS NOT NULL
);

ALTER TABLE "SupplementProfile"
ADD CONSTRAINT "SupplementProfile_serving_size_positive_chk" CHECK ("servingSize" IS NULL OR "servingSize" > 0),
ADD CONSTRAINT "SupplementProfile_servings_positive_chk" CHECK ("servingsPerContainer" IS NULL OR "servingsPerContainer" > 0),
ADD CONSTRAINT "SupplementProfile_serving_unit_chk" CHECK ("servingSize" IS NULL OR "servingUnit" IS NOT NULL);

ALTER TABLE "SupplementIngredient"
ADD CONSTRAINT "SupplementIngredient_amount_nonnegative_chk" CHECK ("amountPerServing" IS NULL OR "amountPerServing" >= 0),
ADD CONSTRAINT "SupplementIngredient_unit_chk" CHECK ("amountPerServing" IS NULL OR unit IS NOT NULL);

-- InventoryEvent is append-only audit history. The Notion projection identifier is the only mutable field.
CREATE FUNCTION "protect_inventory_event_history"()
RETURNS trigger
LANGUAGE plpgsql
AS 'BEGIN
  IF TG_OP = ''DELETE'' THEN
    RAISE EXCEPTION ''InventoryEvent is append-only and cannot be deleted'';
  END IF;

  IF (to_jsonb(NEW) - ''notionEventPageId'') IS DISTINCT FROM (to_jsonb(OLD) - ''notionEventPageId'') THEN
    RAISE EXCEPTION ''InventoryEvent audit fields are immutable'';
  END IF;

  RETURN NEW;
END;';

CREATE TRIGGER "InventoryEvent_append_only_trg"
BEFORE UPDATE OR DELETE ON "InventoryEvent"
FOR EACH ROW EXECUTE FUNCTION "protect_inventory_event_history"();
