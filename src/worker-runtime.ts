import { OutboxStatus, OutboxType } from "@prisma/client";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { projectInventoryEvent } from "./integrations/notion-event-projection.js";
import { processNotionWebhookReceipt, projectProductState } from "./integrations/notion.js";

const STALE_LOCK_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 8;
let stopping = false;

export type WorkResult = {
  processed: boolean;
  retryAfterMs?: number;
};

function backoff(attempt: number): number {
  return Math.min(5 * 60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

export async function recoverStaleLocks(): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
  await prisma.outboxEvent.updateMany({
    where: { status: OutboxStatus.PROCESSING, lockedAt: { lt: staleBefore } },
    data: { status: OutboxStatus.PENDING, lockedAt: null },
  });
  await prisma.webhookReceipt.updateMany({
    where: { processedAt: null, lockedAt: { lt: staleBefore } },
    data: { lockedAt: null },
  });
}

export async function listDueWebhookReceiptIds(limit = config.OUTBOX_BATCH_SIZE): Promise<string[]> {
  const rows = await prisma.webhookReceipt.findMany({
    where: { processedAt: null, lockedAt: null, availableAt: { lte: new Date() } },
    orderBy: { receivedAt: "asc" },
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export async function listDueOutboxIds(limit = config.OUTBOX_BATCH_SIZE): Promise<string[]> {
  const rows = await prisma.outboxEvent.findMany({
    where: { status: OutboxStatus.PENDING, availableAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export async function processWebhookReceiptById(id: string): Promise<WorkResult> {
  const candidate = await prisma.webhookReceipt.findUnique({ where: { id } });
  if (!candidate || candidate.processedAt) return { processed: false };

  const now = new Date();
  if (candidate.availableAt > now) {
    return { processed: false, retryAfterMs: candidate.availableAt.getTime() - now.getTime() };
  }

  const claim = await prisma.webhookReceipt.updateMany({
    where: { id: candidate.id, processedAt: null, lockedAt: null },
    data: { lockedAt: now, attempts: { increment: 1 } },
  });
  if (claim.count !== 1) return { processed: false };

  try {
    await processNotionWebhookReceipt(candidate);
    await prisma.webhookReceipt.update({
      where: { id: candidate.id },
      data: { processedAt: new Date(), lockedAt: null, lastError: null },
    });
    return { processed: true };
  } catch (error) {
    const attempt = candidate.attempts + 1;
    const delay = backoff(attempt);
    const message = error instanceof Error ? error.message : String(error);
    await prisma.webhookReceipt.update({
      where: { id: candidate.id },
      data: {
        lockedAt: null,
        lastError: message.slice(0, 4000),
        availableAt: new Date(Date.now() + delay),
      },
    });
    console.error("Webhook inbox processing failed", { id: candidate.id, attempt, error });
    return { processed: false, retryAfterMs: delay };
  }
}

async function processOutbox(row: { id: string; type: OutboxType; aggregateId: string }): Promise<void> {
  switch (row.type) {
    case OutboxType.NOTION_PRODUCT_STATE:
      await projectProductState(row.aggregateId);
      return;
    case OutboxType.NOTION_INVENTORY_EVENT:
      await projectInventoryEvent(row.aggregateId);
      return;
  }
}

export async function processOutboxById(id: string): Promise<WorkResult> {
  const candidate = await prisma.outboxEvent.findUnique({ where: { id } });
  if (!candidate || candidate.status === OutboxStatus.PROCESSED || candidate.status === OutboxStatus.FAILED) {
    return { processed: false };
  }

  const now = new Date();
  if (candidate.status !== OutboxStatus.PENDING) return { processed: false };
  if (candidate.availableAt > now) {
    return { processed: false, retryAfterMs: candidate.availableAt.getTime() - now.getTime() };
  }

  const claim = await prisma.outboxEvent.updateMany({
    where: { id: candidate.id, status: OutboxStatus.PENDING },
    data: { status: OutboxStatus.PROCESSING, lockedAt: now, attempts: { increment: 1 } },
  });
  if (claim.count !== 1) return { processed: false };

  try {
    await processOutbox(candidate);
    await prisma.outboxEvent.update({
      where: { id: candidate.id },
      data: { status: OutboxStatus.PROCESSED, processedAt: new Date(), lockedAt: null, lastError: null },
    });
    return { processed: true };
  } catch (error) {
    const attempt = candidate.attempts + 1;
    const terminal = attempt >= MAX_ATTEMPTS;
    const delay = backoff(attempt);
    const message = error instanceof Error ? error.message : String(error);
    await prisma.outboxEvent.update({
      where: { id: candidate.id },
      data: {
        status: terminal ? OutboxStatus.FAILED : OutboxStatus.PENDING,
        lockedAt: null,
        lastError: message.slice(0, 4000),
        availableAt: new Date(Date.now() + delay),
      },
    });
    console.error("Outbox processing failed", { id: candidate.id, type: candidate.type, attempt, terminal, error });
    return terminal ? { processed: false } : { processed: false, retryAfterMs: delay };
  }
}

export async function drainInventoryQueuesOnce(): Promise<{ inbox: number; outbox: number }> {
  let inbox = 0;
  for (const id of await listDueWebhookReceiptIds()) {
    if ((await processWebhookReceiptById(id)).processed) inbox += 1;
  }

  let outbox = 0;
  for (const id of await listDueOutboxIds()) {
    if ((await processOutboxById(id)).processed) outbox += 1;
  }

  return { inbox, outbox };
}

export function requestWorkerStop(): void {
  stopping = true;
}

export async function runWorkerLoop(): Promise<void> {
  stopping = false;
  await recoverStaleLocks();
  while (!stopping) {
    const { inbox, outbox } = await drainInventoryQueuesOnce();
    if (inbox + outbox === 0) {
      await new Promise((resolve) => setTimeout(resolve, config.OUTBOX_POLL_MS));
    }
  }
}
