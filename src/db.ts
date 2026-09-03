import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "./config.js";

const prismaContext = new AsyncLocalStorage<PrismaClient>();
let sharedPrisma: PrismaClient | undefined;

function createPrisma(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    max: config.DATABASE_POOL_MAX,
    idleTimeoutMillis: config.DATABASE_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: config.DATABASE_CONNECTION_TIMEOUT_MS,
  });

  return new PrismaClient({
    adapter,
    transactionOptions: {
      maxWait: 10_000,
      timeout: 10_000,
    },
  });
}

function currentPrisma(): PrismaClient {
  const scoped = prismaContext.getStore();
  if (scoped) return scoped;

  sharedPrisma ??= createPrisma(config.DATABASE_URL);
  return sharedPrisma;
}

// Keep the existing import surface (`prisma.model...`) while routing every
// operation to the Prisma Client associated with the current async context.
// Local Node processes fall back to one shared client; Cloudflare handlers are
// wrapped with `withDbClient` so no database I/O is reused across invocations.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = currentPrisma();
    const value = Reflect.get(client as object, property, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export async function withDbClient<T>(connectionString: string, work: () => Promise<T>): Promise<T> {
  const client = createPrisma(connectionString);
  try {
    return await prismaContext.run(client, work);
  } finally {
    await client.$disconnect();
  }
}

export async function closeDb(): Promise<void> {
  if (!sharedPrisma) return;
  const client = sharedPrisma;
  sharedPrisma = undefined;
  await client.$disconnect();
}
