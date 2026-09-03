import { timingSafeEqual } from "node:crypto";
import { verifyWebhookSignature } from "@notionhq/client";
import { InventoryEventSource, Prisma } from "@prisma/client";
import { z } from "zod";
import { requireNotionConfig } from "./config.js";
import { prisma } from "./db.js";
import { listNeedHealth, recordInventoryEvent } from "./services/inventory-service.js";
import {
  listDueOutboxIds,
  listDueWebhookReceiptIds,
  processOutboxById,
  processWebhookReceiptById,
  recoverStaleLocks,
  type WorkResult,
} from "./worker-runtime.js";

const WORKER_VERSION = "0.4.0";
const QUEUE_BATCH_LIMIT = 100;
const PRODUCTION_DLQ = "llm4life-product-tracker-events-dlq";
const ATTENTION_STALE_MS = 10 * 60_000;

type QueueWorkMessage =
  | { kind: "outbox"; id: string }
  | { kind: "notion_webhook"; id: string };

type QueueBinding = {
  send(body: QueueWorkMessage): Promise<unknown>;
  sendBatch(messages: Array<{ body: QueueWorkMessage }>): Promise<unknown>;
};

type WorkerEnv = {
  API_BEARER_TOKEN: string;
  INVENTORY_QUEUE: QueueBinding;
  NOTION_INBOUND_SYNC_ENABLED?: string;
};

type WorkerContext = {
  waitUntil(promise: Promise<unknown>): void;
};

type QueueMessage = {
  id: string;
  timestamp: Date;
  attempts: number;
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

type QueueBatch = {
  queue: string;
  messages: readonly QueueMessage[];
};

const CommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PURCHASED"), quantity: z.number().int().positive() }),
  z.object({ type: z.literal("OPENED") }),
  z.object({ type: z.literal("FINISHED") }),
  z.object({
    type: z.enum(["RETURNED", "DISCARDED"]),
    quantity: z.number().int().positive(),
    bucket: z.enum(["BACKUP", "IN_USE"]),
  }),
  z.object({
    type: z.literal("ADJUSTMENT"),
    backupDelta: z.number().int(),
    inUseDelta: z.number().int(),
  }),
]);

const EventRequestSchema = z.object({
  productKey: z.string().min(1),
  command: CommandSchema,
  occurredAt: z.iso.datetime().optional(),
  note: z.string().max(2000).optional(),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorDetails(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const candidate = error as Error & { code?: unknown; clientVersion?: unknown; meta?: unknown };
  return {
    name: candidate.name,
    message: candidate.message,
    code: candidate.code,
    clientVersion: candidate.clientVersion,
    meta: candidate.meta,
    stack: candidate.stack,
  };
}

function safeEqualToken(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAuthorized(request: Request, env: WorkerEnv): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  return Boolean(actual && env.API_BEARER_TOKEN && safeEqualToken(actual, env.API_BEARER_TOKEN));
}

function notionInboundSyncEnabled(env: WorkerEnv): boolean {
  return env.NOTION_INBOUND_SYNC_ENABLED !== "false";
}

function idempotencyKey(request: Request): string | null {
  const value = request.headers.get("idempotency-key")?.trim();
  return value && value.length <= 200 ? value : null;
}

function asQueueWorkMessage(body: unknown): QueueWorkMessage | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as { kind?: unknown; id?: unknown };
  if (typeof candidate.id !== "string") return null;
  if (candidate.kind === "outbox" || candidate.kind === "notion_webhook") {
    return { kind: candidate.kind, id: candidate.id };
  }
  return null;
}

function queueBodyType(body: unknown): string {
  if (body === null) return "null";
  if (Array.isArray(body)) return "array";
  return typeof body;
}

async function recordDeadLetter(queueName: string, message: QueueMessage): Promise<void> {
  const work = asQueueWorkMessage(message.body);
  const bodyType = queueBodyType(message.body);
  await prisma.deadLetterEvent.upsert({
    where: { messageId: message.id },
    create: {
      messageId: message.id,
      queueName,
      attempts: message.attempts,
      sentAt: message.timestamp,
      bodyType,
      workKind: work?.kind ?? null,
      workId: work?.id ?? null,
    },
    update: {
      queueName,
      attempts: message.attempts,
      receivedAt: new Date(),
      bodyType,
      workKind: work?.kind ?? null,
      workId: work?.id ?? null,
    },
  });

  console.error("Product Tracker dead-letter persisted", {
    messageId: message.id,
    queueName,
    attempts: message.attempts,
    bodyType,
    workKind: work?.kind ?? null,
    workId: work?.id ?? null,
  });
}

async function reliabilityStatus() {
  const staleBefore = new Date(Date.now() - ATTENTION_STALE_MS);
  const [failedOutbox, overdueOutbox, overdueWebhooks, unresolvedDeadLetters] = await Promise.all([
    prisma.outboxEvent.count({ where: { status: "FAILED" } }),
    prisma.outboxEvent.count({
      where: { status: "PENDING", availableAt: { lt: staleBefore } },
    }),
    prisma.webhookReceipt.count({
      where: { processedAt: null, availableAt: { lt: staleBefore } },
    }),
    prisma.deadLetterEvent.count({ where: { resolvedAt: null } }),
  ]);

  return {
    failedOutbox,
    overdueOutbox,
    overdueWebhooks,
    unresolvedDeadLetters,
    attentionRequired: failedOutbox + overdueOutbox + overdueWebhooks + unresolvedDeadLetters > 0,
  };
}

async function sendQueueMessages(queue: QueueBinding, messages: QueueWorkMessage[]): Promise<void> {
  for (let offset = 0; offset < messages.length; offset += QUEUE_BATCH_LIMIT) {
    const chunk = messages.slice(offset, offset + QUEUE_BATCH_LIMIT);
    if (chunk.length === 1) {
      await queue.send(chunk[0]!);
    } else if (chunk.length > 1) {
      await queue.sendBatch(chunk.map((body) => ({ body })));
    }
  }
}

async function enqueueOutboxForIdempotencyKey(queue: QueueBinding, key: string): Promise<number> {
  const rows = await prisma.outboxEvent.findMany({
    where: {
      dedupeKey: {
        in: [`notion-product-state:${key}`, `notion-inventory-event:${key}`],
      },
    },
    select: { id: true },
  });
  await sendQueueMessages(
    queue,
    rows.map((row) => ({ kind: "outbox", id: row.id })),
  );
  return rows.length;
}

async function relayPendingWork(env: WorkerEnv): Promise<{ webhooks: number; outbox: number }> {
  await recoverStaleLocks();
  const [webhookIds, outboxIds] = await Promise.all([
    listDueWebhookReceiptIds(100),
    listDueOutboxIds(100),
  ]);

  const messages: QueueWorkMessage[] = [
    ...webhookIds.map((id) => ({ kind: "notion_webhook" as const, id })),
    ...outboxIds.map((id) => ({ kind: "outbox" as const, id })),
  ];
  await sendQueueMessages(env.INVENTORY_QUEUE, messages);
  return { webhooks: webhookIds.length, outbox: outboxIds.length };
}

function queueRetry(message: QueueMessage, result: WorkResult): void {
  if (!result.retryAfterMs) {
    message.ack();
    return;
  }
  const delaySeconds = Math.max(1, Math.min(86_400, Math.ceil(result.retryAfterMs / 1000)));
  message.retry({ delaySeconds });
}

async function handleInventoryEvent(request: Request, env: WorkerEnv): Promise<Response> {
  if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

  const key = idempotencyKey(request);
  if (!key) return json({ error: "idempotency_key_required" }, 400);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const parsed = EventRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
  }

  try {
    const event = await recordInventoryEvent({
      productKey: parsed.data.productKey,
      command: parsed.data.command,
      source: InventoryEventSource.API,
      idempotencyKey: key,
      ...(parsed.data.occurredAt ? { occurredAt: new Date(parsed.data.occurredAt) } : {}),
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
    });
    const queued = await enqueueOutboxForIdempotencyKey(env.INVENTORY_QUEUE, key);
    return json({ event, queued }, 201);
  } catch (error) {
    console.warn("Inventory command rejected", errorDetails(error));
    return json({ error: error instanceof Error ? error.message : "inventory_command_failed" }, 409);
  }
}

async function handleNotionWebhook(request: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
  const rawBody = await request.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_webhook_payload" }, 400);
  }

  if (typeof body.verification_token === "string") {
    console.warn("Notion webhook verification token received", { verificationToken: body.verification_token });
    return json({ ok: true, verification: "received" });
  }

  let notionConfig;
  try {
    notionConfig = requireNotionConfig({ requireWebhookSecret: true });
  } catch (error) {
    console.error("Signed Notion webhook received before webhook secret was configured", errorDetails(error));
    return json({ error: "webhook_not_configured" }, 503);
  }

  const signature = request.headers.get("x-notion-signature");
  if (!signature || !notionConfig.webhookVerificationToken) {
    return json({ error: "missing_webhook_signature" }, 401);
  }

  const trusted = await verifyWebhookSignature({
    body: rawBody,
    signature,
    verificationToken: notionConfig.webhookVerificationToken,
  });
  if (!trusted) return json({ error: "invalid_webhook_signature" }, 401);

  if (typeof body.id !== "string" || typeof body.type !== "string") {
    return json({ error: "invalid_webhook_payload" }, 400);
  }

  if (!notionInboundSyncEnabled(env)) {
    const entity = body.entity as Record<string, unknown> | undefined;
    const entityId = entity?.type === "page" && typeof entity.id === "string" ? entity.id : null;
    console.log("Notion inbound webhook ignored because Neon is canonical", {
      externalEventId: body.id,
      eventType: body.type,
      entityId,
    });
    return json({ ok: true, ignored: true, reason: "notion_inbound_disabled" }, 202);
  }

  const entity = body.entity as Record<string, unknown> | undefined;
  const entityId = entity?.type === "page" && typeof entity.id === "string" ? entity.id : null;

  try {
    const receipt = await prisma.webhookReceipt.create({
      data: {
        provider: "NOTION",
        externalEventId: body.id,
        eventType: body.type,
        entityId,
        payload: body as Prisma.InputJsonValue,
      },
    });
    ctx.waitUntil(env.INVENTORY_QUEUE.send({ kind: "notion_webhook", id: receipt.id }));
    return json({ ok: true }, 202);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.webhookReceipt.findUnique({
        where: { provider_externalEventId: { provider: "NOTION", externalEventId: body.id } },
        select: { id: true, processedAt: true },
      });
      if (existing && !existing.processedAt) {
        ctx.waitUntil(env.INVENTORY_QUEUE.send({ kind: "notion_webhook", id: existing.id }));
      }
      return json({ ok: true, duplicate: true });
    }
    throw error;
  }
}

async function handleFetch(request: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    await prisma.$queryRawUnsafe("SELECT 1");
    return json({
      ok: true,
      service: "product-tracker",
      runtime: "cloudflare-worker",
      version: WORKER_VERSION,
      notionInboundSyncEnabled: notionInboundSyncEnabled(env),
    });
  }

  if (request.method === "GET" && url.pathname === "/v1/needs") {
    if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
    return json({ needs: await listNeedHealth() });
  }

  if (request.method === "GET" && url.pathname === "/internal/status") {
    if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
    return json({ ok: true, ...(await reliabilityStatus()) });
  }

  if (request.method === "POST" && url.pathname === "/v1/inventory/events") {
    return handleInventoryEvent(request, env);
  }

  if (request.method === "POST" && url.pathname === "/webhooks/notion") {
    return handleNotionWebhook(request, env, ctx);
  }

  if (request.method === "POST" && url.pathname === "/internal/relay") {
    if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
    return json({ ok: true, ...(await relayPendingWork(env)) });
  }

  return json({ error: "not_found" }, 404);
}

export default {
  fetch: handleFetch,

  async queue(batch: QueueBatch): Promise<void> {
    if (batch.queue === PRODUCTION_DLQ) {
      for (const message of batch.messages) {
        try {
          await recordDeadLetter(batch.queue, message);
          message.ack();
        } catch (error) {
          console.error("Failed to persist Product Tracker dead-letter", {
            messageId: message.id,
            queueName: batch.queue,
            error: errorDetails(error),
          });
          message.retry({ delaySeconds: 60 });
        }
      }
      return;
    }

    for (const message of batch.messages) {
      const work = asQueueWorkMessage(message.body);
      if (!work) {
        console.warn("Unknown Product Tracker queue message acknowledged", {
          messageId: message.id,
          queueName: batch.queue,
          bodyType: queueBodyType(message.body),
        });
        message.ack();
        continue;
      }

      try {
        if (work.kind === "outbox") {
          queueRetry(message, await processOutboxById(work.id));
        } else {
          queueRetry(message, await processWebhookReceiptById(work.id));
        }
      } catch (error) {
        console.error("Queue message processing crashed", {
          messageId: message.id,
          queueName: batch.queue,
          body: work,
          error: errorDetails(error),
        });
        message.retry({ delaySeconds: 30 });
      }
    }
  },

  async scheduled(_controller: unknown, env: WorkerEnv): Promise<void> {
    const relayed = await relayPendingWork(env);
    const status = await reliabilityStatus();
    if (status.attentionRequired) {
      console.error("Product Tracker reliability attention required", { relayed, ...status });
    } else {
      console.log("Inventory reconciliation relay complete", { relayed, ...status });
    }
  },
};
