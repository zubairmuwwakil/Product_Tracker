import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import rawBody from "fastify-raw-body";
import { InventoryEventSource } from "@prisma/client";
import { z } from "zod";
import { config, requireApiBearerToken } from "./config.js";
import { closeDb, prisma } from "./db.js";
import { registerNotionWebhookRoute } from "./routes/notion-webhook.js";
import { listNeedHealth, recordInventoryEvent } from "./services/inventory-service.js";
import { requestWorkerStop, runWorkerLoop } from "./worker-runtime.js";

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

function safeEqualToken(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    const expected = requireApiBearerToken();
    const authorization = request.headers.authorization;
    const actual = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    if (!actual || !safeEqualToken(actual, expected)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => {
    await prisma.$queryRawUnsafe("SELECT 1");
    return { ok: true, workerMode: config.RUN_WORKER_IN_PROCESS ? "in-process" : "external" };
  });

  app.get("/v1/needs", async () => ({ needs: await listNeedHealth() }));

  app.post("/v1/inventory/events", async (request, reply) => {
    const parsed = EventRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const idempotencyHeader = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return reply.code(400).send({ error: "idempotency_key_required" });
    }

    try {
      const event = await recordInventoryEvent({
        productKey: parsed.data.productKey,
        command: parsed.data.command,
        source: InventoryEventSource.API,
        idempotencyKey,
        ...(parsed.data.occurredAt ? { occurredAt: new Date(parsed.data.occurredAt) } : {}),
        ...(parsed.data.note ? { note: parsed.data.note } : {}),
      });
      return reply.code(201).send({ event });
    } catch (error) {
      request.log.warn(error, "Inventory command rejected");
      return reply.code(409).send({ error: error instanceof Error ? error.message : "inventory_command_failed" });
    }
  });

  await registerNotionWebhookRoute(app);
  return app;
}

const app = await buildServer();
const workerLoop = config.RUN_WORKER_IN_PROCESS
  ? runWorkerLoop().catch((error) => {
      app.log.error(error, "In-process inventory worker stopped unexpectedly");
      throw error;
    })
  : null;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  requestWorkerStop();
  await app.close();
  if (workerLoop) {
    try {
      await workerLoop;
    } catch (error) {
      app.log.error(error, "Inventory worker failed during shutdown");
    }
  }
  await closeDb();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.PORT, host: "0.0.0.0" });
