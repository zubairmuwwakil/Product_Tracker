export type InventoryState = {
  backupUnits: number;
  inUseUnits: number;
  openedAt: Date | null;
};

export type InventoryCommand =
  | { type: "PURCHASED"; quantity: number }
  | { type: "OPENED" }
  | { type: "FINISHED" }
  | { type: "RETURNED" | "DISCARDED"; quantity: number; bucket: "BACKUP" | "IN_USE" }
  | { type: "ADJUSTMENT"; backupDelta: number; inUseDelta: number };

export type PlannedInventoryEvent = {
  backupDelta: number;
  inUseDelta: number;
  quantityDelta: number;
  next: InventoryState;
};

export type InventoryUrgency = "CRITICAL" | "BUY_NOW" | "RESTOCK" | "STOCKED" | "INACTIVE";

export type NeedHealth = {
  onHand: number;
  backupUnits: number;
  inUseUnits: number;
  buyQty: number;
  urgency: InventoryUrgency;
};

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  assertInteger(value, label);
  if (value <= 0) {
    throw new Error(`${label} must be greater than zero`);
  }
}

function validateState(state: InventoryState): void {
  assertInteger(state.backupUnits, "backupUnits");
  assertInteger(state.inUseUnits, "inUseUnits");
  if (state.backupUnits < 0) throw new Error("Inventory cannot have negative backup units");
  if (state.inUseUnits < 0 || state.inUseUnits > 1) {
    throw new Error("A product may have at most one active/open unit");
  }
}

export function planInventoryEvent(
  state: InventoryState,
  command: InventoryCommand,
  occurredAt: Date,
): PlannedInventoryEvent {
  validateState(state);

  let backupDelta = 0;
  let inUseDelta = 0;
  let openedAt = state.openedAt;

  switch (command.type) {
    case "PURCHASED":
      assertPositiveInteger(command.quantity, "quantity");
      backupDelta = command.quantity;
      break;

    case "OPENED":
      if (state.inUseUnits !== 0) throw new Error("This product already has a unit in use");
      if (state.backupUnits < 1) throw new Error("Cannot open a product with no unopened backup unit");
      backupDelta = -1;
      inUseDelta = 1;
      openedAt = occurredAt;
      break;

    case "FINISHED":
      if (state.inUseUnits < 1) throw new Error("Cannot finish a product with no unit in use");
      inUseDelta = -1;
      openedAt = null;
      break;

    case "RETURNED":
    case "DISCARDED":
      assertPositiveInteger(command.quantity, "quantity");
      if (command.bucket === "BACKUP") {
        if (state.backupUnits < command.quantity) {
          throw new Error(`Cannot ${command.type.toLowerCase()} more backup units than are on hand`);
        }
        backupDelta = -command.quantity;
      } else {
        if (command.quantity !== 1 || state.inUseUnits !== 1) {
          throw new Error(`${command.type} from IN_USE requires exactly one active unit`);
        }
        inUseDelta = -1;
        openedAt = null;
      }
      break;

    case "ADJUSTMENT":
      assertInteger(command.backupDelta, "backupDelta");
      assertInteger(command.inUseDelta, "inUseDelta");
      if (command.backupDelta === 0 && command.inUseDelta === 0) {
        throw new Error("Adjustment must change at least one inventory bucket");
      }
      backupDelta = command.backupDelta;
      inUseDelta = command.inUseDelta;
      break;
  }

  const next: InventoryState = {
    backupUnits: state.backupUnits + backupDelta,
    inUseUnits: state.inUseUnits + inUseDelta,
    openedAt,
  };

  validateState(next);

  if (next.inUseUnits === 0) {
    next.openedAt = null;
  } else if (!next.openedAt) {
    next.openedAt = occurredAt;
  }

  return {
    backupDelta,
    inUseDelta,
    quantityDelta: backupDelta + inUseDelta,
    next,
  };
}

export function deriveNeedHealth(input: {
  active: boolean;
  backupTarget: number;
  reorderPoint: number;
  backupUnits: number;
  inUseUnits: number;
}): NeedHealth {
  const backupTarget = Math.max(0, Math.trunc(input.backupTarget));
  const reorderPoint = Math.max(0, Math.trunc(input.reorderPoint));
  const backupUnits = Math.max(0, Math.trunc(input.backupUnits));
  const inUseUnits = Math.max(0, Math.trunc(input.inUseUnits));
  const onHand = backupUnits + inUseUnits;

  let urgency: InventoryUrgency;
  if (!input.active) urgency = "INACTIVE";
  else if (onHand <= 0) urgency = "CRITICAL";
  else if (onHand <= reorderPoint) urgency = "BUY_NOW";
  else if (backupUnits < backupTarget) urgency = "RESTOCK";
  else urgency = "STOCKED";

  return {
    onHand,
    backupUnits,
    inUseUnits,
    buyQty: input.active ? Math.max(0, backupTarget + 1 - onHand) : 0,
    urgency,
  };
}

export const urgencyPriority: Record<InventoryUrgency, number> = {
  CRITICAL: 1,
  BUY_NOW: 2,
  RESTOCK: 3,
  STOCKED: 4,
  INACTIVE: 5,
};
