import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
  API_BEARER_TOKEN: z.string().min(24).optional(),
  NOTION_TOKEN: z.string().min(1).optional(),
  NOTION_SHOPPING_NEEDS_DATA_SOURCE_ID: z.string().min(1).optional(),
  NOTION_PRODUCTS_DATA_SOURCE_ID: z.string().min(1).optional(),
  NOTION_INVENTORY_EVENTS_DATA_SOURCE_ID: z.string().min(1).optional(),
  NOTION_WEBHOOK_VERIFICATION_TOKEN: z.string().min(1).optional(),
  RUN_WORKER_IN_PROCESS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(20),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(5),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
});

export const config = EnvSchema.parse(process.env);

export function normalizeNotionId(value: string): string {
  return value.replace(/^collection:\/\//, "").replaceAll("-", "").toLowerCase();
}

export function requireApiBearerToken(): string {
  if (!config.API_BEARER_TOKEN) {
    throw new Error("API_BEARER_TOKEN is required to serve /v1 routes");
  }
  return config.API_BEARER_TOKEN;
}

export type NotionConfig = {
  token: string;
  shoppingNeedsDataSourceId: string;
  productsDataSourceId: string;
  inventoryEventsDataSourceId: string;
  webhookVerificationToken?: string;
};

export function requireNotionConfig(options: { requireWebhookSecret?: boolean } = {}): NotionConfig {
  const token = config.NOTION_TOKEN;
  const shoppingNeedsDataSourceId = config.NOTION_SHOPPING_NEEDS_DATA_SOURCE_ID;
  const productsDataSourceId = config.NOTION_PRODUCTS_DATA_SOURCE_ID;
  const inventoryEventsDataSourceId = config.NOTION_INVENTORY_EVENTS_DATA_SOURCE_ID;

  if (!token || !shoppingNeedsDataSourceId || !productsDataSourceId || !inventoryEventsDataSourceId) {
    throw new Error(
      "NOTION_TOKEN and all three NOTION_*_DATA_SOURCE_ID values are required for Notion synchronization",
    );
  }

  if (options.requireWebhookSecret && !config.NOTION_WEBHOOK_VERIFICATION_TOKEN) {
    throw new Error("NOTION_WEBHOOK_VERIFICATION_TOKEN is required for signed webhook events");
  }

  return {
    token,
    shoppingNeedsDataSourceId,
    productsDataSourceId,
    inventoryEventsDataSourceId,
    ...(config.NOTION_WEBHOOK_VERIFICATION_TOKEN
      ? { webhookVerificationToken: config.NOTION_WEBHOOK_VERIFICATION_TOKEN }
      : {}),
  };
}
