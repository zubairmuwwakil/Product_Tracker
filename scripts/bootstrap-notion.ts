import { closeDb } from "../src/db.js";
import { bootstrapFromNotion } from "../src/integrations/notion.js";

try {
  const result = await bootstrapFromNotion();
  console.log(`Imported ${result.needs} active needs and ${result.products} active products from Notion.`);
} finally {
  await closeDb();
}
