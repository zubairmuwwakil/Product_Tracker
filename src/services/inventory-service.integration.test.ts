import { randomUUID } from "node:crypto";
import { InventoryEventSource, ProductType, SupplementPriority } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db.js";
import {
  IdempotencyConflictError,
  listSupplementStack,
  recordInventoryEvent,
} from "./inventory-service.js";

const integration = describe.skipIf(!process.env.DATABASE_URL);

integration("inventory service with Postgres", () => {
  const suffix = randomUUID();
  const needKey = `need.test.${suffix}`;
  const productKey = `product.test.${suffix}`;
  const idempotencyKey = `test:${suffix}:purchase`;
  let needId = "";
  let productId = "";
  let eventId = "";

  beforeAll(async () => {
    const need = await prisma.inventoryNeed.create({
      data: {
        key: needKey,
        name: "Integration Test Creatine",
        aisle: "Supplements",
        backupTarget: 1,
        reorderPoint: 1,
      },
    });
    needId = need.id;

    const product = await prisma.product.create({
      data: {
        key: productKey,
        needId,
        name: "Integration Test Creatine Product",
        brand: "Test",
        productType: ProductType.SUPPLEMENT,
      },
    });
    productId = product.id;
  });

  it("replays the same idempotent command but rejects key reuse with a different command", async () => {
    const first = await recordInventoryEvent({
      productKey,
      command: { type: "PURCHASED", quantity: 1 },
      source: InventoryEventSource.API,
      idempotencyKey,
      note: "integration test",
    });
    eventId = first.id;

    const replay = await recordInventoryEvent({
      productKey,
      command: { type: "PURCHASED", quantity: 1 },
      source: InventoryEventSource.API,
      idempotencyKey,
      note: "integration test",
    });

    expect(replay.id).toBe(first.id);
    expect(first.requestHash).toMatch(/^[a-f0-9]{64}$/);

    await expect(
      recordInventoryEvent({
        productKey,
        command: { type: "PURCHASED", quantity: 2 },
        source: InventoryEventSource.API,
        idempotencyKey,
        note: "integration test",
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("enforces canonical inventory invariants in Postgres", async () => {
    await expect(
      prisma.inventoryBalance.update({
        where: { productId },
        data: { backupUnits: -1 },
      }),
    ).rejects.toThrow();

    const balance = await prisma.inventoryBalance.findUniqueOrThrow({ where: { productId } });
    expect(balance.backupUnits).toBe(1);
  });

  it("keeps inventory history append-only and prevents parent deletion", async () => {
    await expect(prisma.inventoryEvent.delete({ where: { id: eventId } })).rejects.toThrow();
    await expect(prisma.product.delete({ where: { id: productId } })).rejects.toThrow();
    await expect(prisma.inventoryNeed.delete({ where: { id: needId } })).rejects.toThrow();
  });

  it("projects regimen facts separately from supplement label facts", async () => {
    await prisma.supplementPlan.create({
      data: {
        needId,
        priority: SupplementPriority.CORE,
        targetMinAmount: 3,
        targetMaxAmount: 5,
        targetUnit: "g/day",
        frequency: "daily",
        instructions: "Take consistently.",
      },
    });

    await prisma.supplementProfile.create({
      data: {
        productId,
        form: "powder",
        servingSize: 5,
        servingUnit: "g",
        servingsPerContainer: 100,
        ingredients: {
          create: {
            key: "creatine-monohydrate",
            name: "Creatine monohydrate",
            amountPerServing: 5,
            unit: "g",
          },
        },
      },
    });

    const stack = await listSupplementStack();
    const item = stack.find((entry) => entry.key === needKey);

    expect(item).toMatchObject({
      key: needKey,
      priority: "CORE",
      target: { minAmount: "3", maxAmount: "5", unit: "g/day", frequency: "daily" },
      inventory: { onHand: 1 },
    });
  });
});
