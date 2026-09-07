import { createHash } from "node:crypto";
import {
  InventoryEventSource,
  InventoryEventType,
  OutboxType,
  Prisma,
  ProductType,
  type InventoryEvent,
} from "@prisma/client";
import { prisma } from "../db.js";
import {
  deriveNeedHealth,
  planInventoryEvent,
  urgencyPriority,
  type InventoryCommand,
} from "../domain/inventory.js";

export type RecordInventoryEventInput = {
  productKey: string;
  command: InventoryCommand;
  source: InventoryEventSource;
  idempotencyKey: string;
  occurredAt?: Date;
  note?: string;
  externalEventId?: string;
};

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_CONFLICT";

  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key was already used for a different inventory command: ${idempotencyKey}`);
    this.name = "IdempotencyConflictError";
  }
}

function asPrismaEventType(type: InventoryCommand["type"]): InventoryEventType {
  return InventoryEventType[type];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`Unsupported value in idempotency fingerprint: ${typeof value}`);
}

export function inventoryRequestHash(input: RecordInventoryEventInput): string {
  const canonical = canonicalJson({
    productKey: input.productKey,
    command: input.command,
    source: input.source,
    occurredAt: input.occurredAt?.toISOString() ?? null,
    note: input.note ?? null,
    externalEventId: input.externalEventId ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

async function runSerializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" || error.code === "P2002");
      if (!retryable || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 25));
    }
  }
  throw new Error("Serializable transaction retry loop exhausted");
}

export async function recordInventoryEvent(input: RecordInventoryEventInput): Promise<InventoryEvent> {
  if (!input.idempotencyKey.trim()) throw new Error("idempotencyKey is required");
  const occurredAt = input.occurredAt ?? new Date();
  const requestHash = inventoryRequestHash(input);

  return runSerializable(async (tx) => {
    const existing = await tx.inventoryEvent.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      // Pre-hardening events have no hash. Preserve backwards-compatible replay behavior for them.
      if (existing.requestHash && existing.requestHash !== requestHash) {
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      return existing;
    }

    const product = await tx.product.findUnique({
      where: { key: input.productKey },
      include: { need: true, balance: true },
    });
    if (!product) throw new Error(`Unknown product key: ${input.productKey}`);
    if (!product.active) throw new Error(`Product is inactive: ${input.productKey}`);

    const current = product.balance ?? {
      backupUnits: 0,
      inUseUnits: 0,
      openedAt: null,
    };

    if (!product.balance) {
      await tx.inventoryBalance.create({
        data: { productId: product.id, backupUnits: 0, inUseUnits: 0 },
      });
    }

    const planned = planInventoryEvent(
      {
        backupUnits: current.backupUnits,
        inUseUnits: current.inUseUnits,
        openedAt: current.openedAt,
      },
      input.command,
      occurredAt,
    );

    await tx.inventoryBalance.update({
      where: { productId: product.id },
      data: {
        backupUnits: planned.next.backupUnits,
        inUseUnits: planned.next.inUseUnits,
        openedAt: planned.next.openedAt,
        version: { increment: 1 },
      },
    });

    const event = await tx.inventoryEvent.create({
      data: {
        productId: product.id,
        needId: product.needId,
        type: asPrismaEventType(input.command.type),
        source: input.source,
        backupDelta: planned.backupDelta,
        inUseDelta: planned.inUseDelta,
        quantityDelta: planned.quantityDelta,
        occurredAt,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        ...(input.externalEventId ? { externalEventId: input.externalEventId } : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    });

    if (input.source !== InventoryEventSource.NOTION && input.source !== InventoryEventSource.IMPORT) {
      await tx.outboxEvent.create({
        data: {
          type: OutboxType.NOTION_PRODUCT_STATE,
          aggregateId: product.id,
          dedupeKey: `notion-product-state:${input.idempotencyKey}`,
          payload: { productId: product.id, inventoryEventId: event.id },
        },
      });
    }

    await tx.outboxEvent.create({
      data: {
        type: OutboxType.NOTION_INVENTORY_EVENT,
        aggregateId: event.id,
        dedupeKey: `notion-inventory-event:${input.idempotencyKey}`,
        payload: { inventoryEventId: event.id },
      },
    });

    return event;
  });
}

export async function createBaseline(input: {
  productKey: string;
  backupUnits: number;
  inUseUnits: number;
  openedAt: Date | null;
}): Promise<void> {
  await runSerializable(async (tx) => {
    const product = await tx.product.findUnique({ where: { key: input.productKey } });
    if (!product) throw new Error(`Unknown product key: ${input.productKey}`);

    const existingBalance = await tx.inventoryBalance.findUnique({ where: { productId: product.id } });
    if (existingBalance) return;

    if (!Number.isInteger(input.backupUnits) || input.backupUnits < 0) {
      throw new Error("Baseline backupUnits must be a non-negative integer");
    }
    if (input.inUseUnits !== 0 && input.inUseUnits !== 1) {
      throw new Error("Baseline inUseUnits must be 0 or 1");
    }

    const openedAt = input.inUseUnits === 1 ? input.openedAt ?? new Date() : null;
    await tx.inventoryBalance.create({
      data: {
        productId: product.id,
        backupUnits: input.backupUnits,
        inUseUnits: input.inUseUnits,
        openedAt,
      },
    });

    await tx.inventoryEvent.create({
      data: {
        productId: product.id,
        needId: product.needId,
        type: InventoryEventType.BASELINE,
        source: InventoryEventSource.IMPORT,
        backupDelta: input.backupUnits,
        inUseDelta: input.inUseUnits,
        quantityDelta: input.backupUnits + input.inUseUnits,
        occurredAt: openedAt ?? new Date(),
        idempotencyKey: `baseline:${product.key}`,
        note: "Initial state imported from Notion",
      },
    });
  });
}

export async function reconcileNotionBalance(input: {
  productKey: string;
  backupUnits: number;
  inUseUnits: number;
  openedAt: Date | null;
  lastEditedAt: Date;
}): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { key: input.productKey },
    include: { balance: true },
  });
  if (!product) throw new Error(`Unknown product key: ${input.productKey}`);

  if (!product.balance) {
    await createBaseline(input);
    return;
  }

  const backupDelta = input.backupUnits - product.balance.backupUnits;
  const inUseDelta = input.inUseUnits - product.balance.inUseUnits;
  const currentOpened = product.balance.openedAt?.getTime() ?? null;
  const desiredOpened = input.inUseUnits === 1 ? input.openedAt?.getTime() ?? null : null;
  const openedAtChanged = currentOpened !== desiredOpened;

  if (backupDelta === 0 && inUseDelta === 0 && !openedAtChanged) return;

  await recordInventoryEvent({
    productKey: input.productKey,
    command: {
      type: "ADJUSTMENT",
      backupDelta,
      inUseDelta,
      ...(openedAtChanged ? { openedAt: input.openedAt } : {}),
    },
    source: InventoryEventSource.NOTION,
    idempotencyKey: `notion-state:${product.notionPageId ?? product.key}:${input.lastEditedAt.toISOString()}`,
    occurredAt: input.lastEditedAt,
    note: "Inventory state edited in Notion",
  });
}

export async function listNeedHealth(): Promise<Array<Record<string, unknown>>> {
  const needs = await prisma.inventoryNeed.findMany({
    include: {
      products: {
        include: { balance: true },
      },
    },
  });

  return needs
    .map((need) => {
      const activeProducts = need.products.filter((product) => product.active);
      const backupUnits = activeProducts.reduce((sum, product) => sum + (product.balance?.backupUnits ?? 0), 0);
      const inUseUnits = activeProducts.reduce((sum, product) => sum + (product.balance?.inUseUnits ?? 0), 0);
      const health = deriveNeedHealth({
        active: need.active,
        backupTarget: need.backupTarget,
        reorderPoint: need.reorderPoint,
        backupUnits,
        inUseUnits,
      });

      return {
        key: need.key,
        name: need.name,
        aisle: need.aisle,
        defaultRetailer: need.defaultRetailer,
        backupTarget: need.backupTarget,
        reorderPoint: need.reorderPoint,
        ...health,
        products: activeProducts.map((product) => ({
          key: product.key,
          name: product.name,
          brand: product.brand,
          productType: product.productType,
          backupUnits: product.balance?.backupUnits ?? 0,
          inUseUnits: product.balance?.inUseUnits ?? 0,
          openedAt: product.balance?.openedAt ?? null,
        })),
      };
    })
    .sort((a, b) => {
      const ap = urgencyPriority[a.urgency as keyof typeof urgencyPriority];
      const bp = urgencyPriority[b.urgency as keyof typeof urgencyPriority];
      return ap - bp || String(a.name).localeCompare(String(b.name));
    });
}

function decimalString(value: Prisma.Decimal | null): string | null {
  return value?.toString() ?? null;
}

const supplementPriorityOrder = {
  CORE: 1,
  OPTIONAL: 2,
  SITUATIONAL: 3,
} as const;

export async function listSupplementStack(): Promise<Array<Record<string, unknown>>> {
  const needs = await prisma.inventoryNeed.findMany({
    where: {
      supplementPlan: { is: { active: true } },
    },
    include: {
      supplementPlan: true,
      products: {
        where: { active: true, productType: ProductType.SUPPLEMENT },
        include: {
          balance: true,
          supplementProfile: {
            include: { ingredients: { orderBy: { name: "asc" } } },
          },
        },
      },
    },
  });

  return needs
    .map((need) => {
      const plan = need.supplementPlan!;
      const backupUnits = need.products.reduce((sum, product) => sum + (product.balance?.backupUnits ?? 0), 0);
      const inUseUnits = need.products.reduce((sum, product) => sum + (product.balance?.inUseUnits ?? 0), 0);
      const health = deriveNeedHealth({
        active: need.active,
        backupTarget: need.backupTarget,
        reorderPoint: need.reorderPoint,
        backupUnits,
        inUseUnits,
      });

      return {
        key: need.key,
        name: need.name,
        priority: plan.priority,
        target: {
          minAmount: decimalString(plan.targetMinAmount),
          maxAmount: decimalString(plan.targetMaxAmount),
          unit: plan.targetUnit,
          frequency: plan.frequency,
          instructions: plan.instructions,
          rationale: plan.rationale,
        },
        inventory: health,
        products: need.products.map((product) => ({
          key: product.key,
          name: product.name,
          brand: product.brand,
          price: product.price?.toString() ?? null,
          productUrl: product.productUrl,
          needsIdentification: product.needsIdentification,
          backupUnits: product.balance?.backupUnits ?? 0,
          inUseUnits: product.balance?.inUseUnits ?? 0,
          openedAt: product.balance?.openedAt ?? null,
          profile: product.supplementProfile
            ? {
                form: product.supplementProfile.form,
                servingSize: decimalString(product.supplementProfile.servingSize),
                servingUnit: product.supplementProfile.servingUnit,
                servingsPerContainer: decimalString(product.supplementProfile.servingsPerContainer),
                notes: product.supplementProfile.notes,
                ingredients: product.supplementProfile.ingredients.map((ingredient) => ({
                  key: ingredient.key,
                  name: ingredient.name,
                  amountPerServing: decimalString(ingredient.amountPerServing),
                  unit: ingredient.unit,
                  form: ingredient.form,
                  notes: ingredient.notes,
                })),
              }
            : null,
        })),
      };
    })
    .sort((a, b) => {
      const ap = supplementPriorityOrder[a.priority as keyof typeof supplementPriorityOrder];
      const bp = supplementPriorityOrder[b.priority as keyof typeof supplementPriorityOrder];
      return ap - bp || String(a.name).localeCompare(String(b.name));
    });
}
