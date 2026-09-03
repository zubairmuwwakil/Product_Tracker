import productionWorker from "./cloudflare-entry.js";

type ReliabilityQueue = {
  send(body: unknown): Promise<unknown>;
};

type ReliabilityEnv = {
  API_BEARER_TOKEN: string;
  INVENTORY_QUEUE: ReliabilityQueue;
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
};

function authorized(request: Request, env: ReliabilityEnv): boolean {
  return request.headers.get("authorization") === `Bearer ${env.API_BEARER_TOKEN}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: ReliabilityEnv, ctx: unknown): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/internal/reliability/enqueue-malformed") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      await env.INVENTORY_QUEUE.send(null);
      return json({ ok: true, enqueued: "malformed" }, 202);
    }

    return productionWorker.fetch(request, env as any, ctx as any);
  },

  async queue(batch: unknown, env: ReliabilityEnv): Promise<void> {
    await productionWorker.queue(batch as any, env as any);
  },
};
