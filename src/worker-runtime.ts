import { OutboxStatus, OutboxType } from "@prisma/client";
import { config } from "./config.js";
import { prisma } from "./db.js";
import {
  processNotionWebhookReceipt,
  projectInventoryEvent,
  projectProductState,
} from "./integrations/notion.js";

const STALE_LOCK_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 8;
let stopping = false;

function backoff(attempt: number): number {
  return Math.min(5 * 60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

async function recoverStaleLocks(): Promise<void> {
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

async function drainWebhookInbox(): Promise<number> {
  const candidates = await prisma.webhookReceipt.findMany({
    where: { processedAt: null, lockedAt: null, availableAt: { lte: new Date() } },
    orderBy: { receivedAt: "asc" },
    take: config.OUTBOX_BATCH_SIZE,
  });

  let processed = 0;
  for (const candidate of candidates) {
    const claim = await prisma.webhookReceipt.updateMany({
      where: { id: candidate.id, processedAt: null, lockedAt: null },
      data: { lockedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claim.count !== 1) continue;

    try {
      await processNotionWebhookReceipt(candidate);
      await prisma.webhookReceipt.update({
        where: { id: candidate.id },
        data: { processedAt: new Date(), lockedAt: null, lastError: null },
      });
      processed += 1;
    } catch (error) {
      const attempt = candidate.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      await prisma.webhookReceipt.update({
        where: { id: candidate.id },
        data: {
          lockedAt: null,
          lastError: message.slice(0, 4000),
          availableAt: new Date(Date.now() + backoff(attempt)),
        },
      });
      console.error("Webhook inbox processing failed", { id: candidate.id, attempt, error });
    }
  }
  return processed;
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

async function drainOutbox(): Promise<number> {
  const candidates = await prisma.outboxEvent.findMany({
    where: { status: OutboxStatus.PENDING, availableAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: config.OUTBOX_BATCH_SIZE,
  });

  let processed = 0;
  for (const candidate of candidates) {
    const claim = await prisma.outboxEvent.updateMany({
      where: { id: candidate.id, status: OutboxStatus.PENDING },
      data: { status: OutboxStatus.PROCESSING, lockedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claim.count !== 1) continue;

    try {
      await processOutbox(candidate);
      await prisma.outboxEvent.update({
        where: { id: candidate.id },
        data: { status: OutboxStatus.PROCESSED, processedAt: new Date(), lockedAt: null, lastError: null },
      });
      processed += 1;
    } catch (error) {
      const attempt = candidate.attempts + 1;
      const terminal = attempt >= MAX_ATTEMPTS;
      const message = error instanceof Error ? error.message : String(error);
      await prisma.outboxEvent.update({
        where: { id: candidate.id },
        data: {
          status: terminal ? OutboxStatus.FAILED : OutboxStatus.PENDING,
          lockedAt: null,
          lastError: message.slice(0, 4000),
          availableAt: new Date(Date.now() + backoff(attempt)),
        },
      });
      console.error("Outbox processing failed", { id: candidate.id, type: candidate.type, attempt, terminal, error });
    }
  }
  return processed;
}

export async function drainInventoryQueuesOnce(): Promise<{ inbox: number; outbox: number }> {
  const inbox = await drainWebhookInbox();
  const outbox = await drainOutbox();
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
