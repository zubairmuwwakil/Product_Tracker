-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "InventoryEventType" AS ENUM ('BASELINE', 'PURCHASED', 'OPENED', 'FINISHED', 'RETURNED', 'DISCARDED', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "InventoryEventSource" AS ENUM ('API', 'NOTION', 'IMPORT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OutboxType" AS ENUM ('NOTION_PRODUCT_STATE', 'NOTION_INVENTORY_EVENT');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "InventoryNeed" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aisle" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "backupTarget" INTEGER NOT NULL DEFAULT 1,
    "reorderPoint" INTEGER NOT NULL DEFAULT 1,
    "defaultRetailer" TEXT,
    "notes" TEXT,
    "notionPageId" TEXT,
    "notionLastEditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryNeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "needId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "careArea" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "paoMonths" INTEGER,
    "price" DECIMAL(12,2),
    "productUrl" TEXT,
    "repurchasePolicy" TEXT,
    "retailerOverride" TEXT,
    "notes" TEXT,
    "needsIdentification" BOOLEAN NOT NULL DEFAULT false,
    "notionPageId" TEXT,
    "notionLastEditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryBalance" (
    "productId" TEXT NOT NULL,
    "backupUnits" INTEGER NOT NULL DEFAULT 0,
    "inUseUnits" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryBalance_pkey" PRIMARY KEY ("productId")
);

-- CreateTable
CREATE TABLE "InventoryEvent" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "needId" TEXT NOT NULL,
    "type" "InventoryEventType" NOT NULL,
    "source" "InventoryEventSource" NOT NULL,
    "backupDelta" INTEGER NOT NULL DEFAULT 0,
    "inUseDelta" INTEGER NOT NULL DEFAULT 0,
    "quantityDelta" INTEGER NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    "externalEventId" TEXT,
    "note" TEXT,
    "notionEventPageId" TEXT,

    CONSTRAINT "InventoryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "type" "OutboxType" NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "aggregateId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "entityId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryNeed_key_key" ON "InventoryNeed"("key");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryNeed_notionPageId_key" ON "InventoryNeed"("notionPageId");

-- CreateIndex
CREATE INDEX "InventoryNeed_active_idx" ON "InventoryNeed"("active");

-- CreateIndex
CREATE UNIQUE INDEX "Product_key_key" ON "Product"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Product_notionPageId_key" ON "Product"("notionPageId");

-- CreateIndex
CREATE INDEX "Product_needId_active_idx" ON "Product"("needId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryEvent_idempotencyKey_key" ON "InventoryEvent"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryEvent_notionEventPageId_key" ON "InventoryEvent"("notionEventPageId");

-- CreateIndex
CREATE INDEX "InventoryEvent_productId_occurredAt_idx" ON "InventoryEvent"("productId", "occurredAt");

-- CreateIndex
CREATE INDEX "InventoryEvent_needId_occurredAt_idx" ON "InventoryEvent"("needId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_dedupeKey_key" ON "OutboxEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_idx" ON "OutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE INDEX "WebhookReceipt_provider_processedAt_availableAt_idx" ON "WebhookReceipt"("provider", "processedAt", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_provider_externalEventId_key" ON "WebhookReceipt"("provider", "externalEventId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_needId_fkey" FOREIGN KEY ("needId") REFERENCES "InventoryNeed"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryEvent" ADD CONSTRAINT "InventoryEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryEvent" ADD CONSTRAINT "InventoryEvent_needId_fkey" FOREIGN KEY ("needId") REFERENCES "InventoryNeed"("id") ON DELETE CASCADE ON UPDATE CASCADE;
