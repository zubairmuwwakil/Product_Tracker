import { closeDb } from "./db.js";
import { requestWorkerStop, runWorkerLoop } from "./worker-runtime.js";

const shutdown = async (signal: string) => {
  console.log("Worker stopping", { signal });
  requestWorkerStop();
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await runWorkerLoop();
} finally {
  await closeDb();
}
