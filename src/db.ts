import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "./config.js";

const globalForDb = globalThis as unknown as {
  prisma?: PrismaClient;
  pgPool?: Pool;
};

const pool =
  globalForDb.pgPool ??
  new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    idleTimeoutMillis: config.DATABASE_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: config.DATABASE_CONNECTION_TIMEOUT_MS,
  });

if (config.NODE_ENV !== "production") {
  globalForDb.pgPool = pool;
}

const adapter = new PrismaPg(pool);

export const prisma =
  globalForDb.prisma ??
  new PrismaClient({
    adapter,
    transactionOptions: {
      maxWait: 10_000,
      timeout: 10_000,
    },
  });

if (config.NODE_ENV !== "production") {
  globalForDb.prisma = prisma;
}

export async function closeDb(): Promise<void> {
  await prisma.$disconnect();
  await pool.end();
}
