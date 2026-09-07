import pg from "pg";
import { config } from "../src/config.js";

const RUNTIME_ROLE = "product_tracker_runtime";

function pgConnectionString(): string {
  const url = new URL(config.DATABASE_URL);
  // `schema=public` is a Prisma convention, not a libpq connection parameter.
  url.searchParams.delete("schema");
  return url.toString();
}

const client = new pg.Client({ connectionString: pgConnectionString() });

try {
  await client.connect();
  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [RUNTIME_ROLE]);
  if (existing.rowCount === 0) {
    await client.query(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN`);
    console.log(`Created local/test database role: ${RUNTIME_ROLE}`);
  } else {
    console.log(`Database role already exists: ${RUNTIME_ROLE}`);
  }
} finally {
  await client.end();
}
