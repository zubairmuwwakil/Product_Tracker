import { describe, expect, it } from "vitest";
import { deriveNeedHealth, planInventoryEvent } from "./inventory.js";

const at = new Date("2026-08-31T12:00:00.000Z");

describe("deriveNeedHealth", () => {
  it("matches the canonical Notion replenishment model", () => {
    expect(
      deriveNeedHealth({ active: true, backupTarget: 2, reorderPoint: 1, backupUnits: 0, inUseUnits: 0 }),
    ).toMatchObject({ urgency: "CRITICAL", onHand: 0, buyQty: 3 });

    expect(
      deriveNeedHealth({ active: true, backupTarget: 2, reorderPoint: 1, backupUnits: 1, inUseUnits: 0 }),
    ).toMatchObject({ urgency: "BUY_NOW", onHand: 1, buyQty: 2 });

    expect(
      deriveNeedHealth({ active: true, backupTarget: 2, reorderPoint: 1, backupUnits: 1, inUseUnits: 1 }),
    ).toMatchObject({ urgency: "RESTOCK", onHand: 2, buyQty: 1 });

    expect(
      deriveNeedHealth({ active: true, backupTarget: 2, reorderPoint: 1, backupUnits: 2, inUseUnits: 1 }),
    ).toMatchObject({ urgency: "STOCKED", onHand: 3, buyQty: 0 });
  });
});

describe("planInventoryEvent", () => {
  it("moves a backup into use without changing physical on-hand quantity", () => {
    const result = planInventoryEvent(
      { backupUnits: 2, inUseUnits: 0, openedAt: null },
      { type: "OPENED" },
      at,
    );
    expect(result).toMatchObject({ backupDelta: -1, inUseDelta: 1, quantityDelta: 0 });
    expect(result.next).toEqual({ backupUnits: 1, inUseUnits: 1, openedAt: at });
  });

  it("finishing an open unit reduces total inventory", () => {
    const result = planInventoryEvent(
      { backupUnits: 1, inUseUnits: 1, openedAt: at },
      { type: "FINISHED" },
      new Date("2026-09-15T12:00:00.000Z"),
    );
    expect(result.quantityDelta).toBe(-1);
    expect(result.next).toEqual({ backupUnits: 1, inUseUnits: 0, openedAt: null });
  });

  it("rejects impossible state transitions", () => {
    expect(() =>
      planInventoryEvent({ backupUnits: 0, inUseUnits: 0, openedAt: null }, { type: "OPENED" }, at),
    ).toThrow(/no unopened backup/i);

    expect(() =>
      planInventoryEvent(
        { backupUnits: 0, inUseUnits: 0, openedAt: null },
        { type: "ADJUSTMENT", backupDelta: -1, inUseDelta: 0 },
        at,
      ),
    ).toThrow(/negative backup/i);
  });
});
