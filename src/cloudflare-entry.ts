type HyperdriveBinding = {
  connectionString: string;
};

type BootstrapEnv = {
  DATABASE_URL?: string;
  HYPERDRIVE?: HyperdriveBinding;
};

let workerModulePromise: Promise<typeof import("./cloudflare-worker.js")> | undefined;

function configureDatabaseEnvironment(env: BootstrapEnv): void {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Product Tracker requires HYPERDRIVE or DATABASE_URL");
  }

  // The shared Prisma/config modules are also used by the local Node runtime.
  // Set only DATABASE_URL before dynamically importing them so the Cloudflare
  // runtime can prefer Hyperdrive without coupling the domain layer to Workers.
  process.env.DATABASE_URL = connectionString;
}

async function getWorker(env: BootstrapEnv) {
  configureDatabaseEnvironment(env);
  workerModulePromise ??= import("./cloudflare-worker.js");
  return (await workerModulePromise).default;
}

export default {
  async fetch(request: Request, env: BootstrapEnv, ctx: any): Promise<Response> {
    return (await getWorker(env)).fetch(request, env as any, ctx);
  },

  async queue(batch: any, env: BootstrapEnv): Promise<void> {
    await (await getWorker(env)).queue(batch);
  },

  async scheduled(controller: unknown, env: BootstrapEnv): Promise<void> {
    await (await getWorker(env)).scheduled(controller, env as any);
  },
};
