import { verifyWebhookSignature } from "@notionhq/client";
import { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config, requireNotionConfig } from "../config.js";
import { prisma } from "../db.js";

type RawBodyRequest = FastifyRequest & { rawBody?: string | Buffer };

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function registerNotionWebhookRoute(app: FastifyInstance): Promise<void> {
  app.post(
    "/webhooks/notion",
    { config: { rawBody: true } },
    async (request, reply) => {
      const body = request.body as Record<string, any> | undefined;

      if (body && typeof body.verification_token === "string") {
        request.log.warn(
          { verificationToken: body.verification_token },
          "Notion webhook verification token received. Store it as NOTION_WEBHOOK_VERIFICATION_TOKEN, verify the subscription in Notion, then rotate/redact setup logs.",
        );
        return reply.code(200).send({ ok: true, verification: "received" });
      }

      let notionConfig;
      try {
        notionConfig = requireNotionConfig({ requireWebhookSecret: true });
      } catch (error) {
        request.log.error(error, "Signed Notion webhook received before webhook secret was configured");
        return reply.code(503).send({ error: "webhook_not_configured" });
      }

      const raw = (request as RawBodyRequest).rawBody;
      const signature = headerValue(request.headers["x-notion-signature"]);
      if (!raw || !signature || !notionConfig.webhookVerificationToken) {
        return reply.code(401).send({ error: "missing_webhook_signature" });
      }

      const trusted = await verifyWebhookSignature({
        body: typeof raw === "string" ? raw : raw.toString("utf8"),
        signature,
        verificationToken: notionConfig.webhookVerificationToken,
      });
      if (!trusted) return reply.code(401).send({ error: "invalid_webhook_signature" });

      if (!body || typeof body.id !== "string" || typeof body.type !== "string") {
        return reply.code(400).send({ error: "invalid_webhook_payload" });
      }

      const entityId = body.entity?.type === "page" && typeof body.entity.id === "string" ? body.entity.id : null;

      try {
        await prisma.webhookReceipt.create({
          data: {
            provider: "NOTION",
            externalEventId: body.id,
            eventType: body.type,
            entityId,
            payload: body as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return reply.code(200).send({ ok: true, duplicate: true });
        }
        throw error;
      }

      request.log.info({ eventId: body.id, eventType: body.type, entityId }, "Queued Notion webhook event");
      return reply.code(202).send({ ok: true });
    },
  );
}
