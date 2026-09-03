type HyperdriveBinding = {
  connectionString: string;
};

type BootstrapEnv = {
  DATABASE_URL?: string;
  HYPERDRIVE?: HyperdriveBinding;
};

type WorkerModule = typeof import("./cloudflare-worker.js");
type DbModule = typeof import("./db.js");

type RuntimeModules = {
  worker: WorkerModule["default"];
  withDbClient: DbModule["withDbClient"];
};

let runtimeModulesPromise: Promise<RuntimeModules> | undefined;

function configureDatabaseEnvironment(env: BootstrapEnv): string {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Product Tracker requires HYPERDRIVE or DATABASE_URL");
  }

  // Shared config is also used by the local Node runtime. Set DATABASE_URL
  // before the first dynamic import, then pass the invocation's connection
  // string explicitly to the request-scoped Prisma client.
  process.env.DATABASE_URL = connectionString;
  return connectionString;
}

async function getRuntimeModules(env: BootstrapEnv): Promise<RuntimeModules> {
  configureDatabaseEnvironment(env);
  runtimeModulesPromise ??= Promise.all([import("./cloudflare-worker.js"), import("./db.js")]).then(
    ([workerModule, dbModule]) => ({
      worker: workerModule.default,
      withDbClient: dbModule.withDbClient,
    }),
  );
  return runtimeModulesPromise;
}

export default {
  async fetch(request: Request, env: BootstrapEnv, ctx: any): Promise<Response> {
    const connectionString = configureDatabaseEnvironment(env);
    const { worker, withDbClient } = await getRuntimeModules(env);
    return withDbClient(connectionString, () => worker.fetch(request, env as any, ctx));
  },

  async queue(batch: any, env: BootstrapEnv): Promise<void> {
    const connectionString = configureDatabaseEnvironment(env);
    const { worker, withDbClient } = await getRuntimeModules(env);
    await withDbClient(connectionString, () => worker.queue(batch));
  },

  async scheduled(controller: unknown, env: BootstrapEnv): Promise<void> {
    const connectionString = configureDatabaseEnvironment(env);
    const { worker, withDbClient } = await getRuntimeModules(env);
    await withDbClient(connectionString, () => worker.scheduled(controller, env as any));
  },
};
