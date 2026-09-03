import { InventoryEventSource, InventoryEventType } from "@prisma/client";
import { requireNotionConfig } from "../config.js";
import { prisma } from "../db.js";
import { getNotionClient } from "./notion.js";

const PRODUCT_TRACKER_EVENT_ID_PROPERTY = "Product Tracker Event ID";

function sourceLabel(source: InventoryEventSource): "Manual" | "AI" | "Import" {
  if (source === InventoryEventSource.NOTION) return "Manual";
  if (source === InventoryEventSource.IMPORT) return "Import";
  return "AI";
}

function notionEventType(type: InventoryEventType): string | null {
  const labels: Partial<Record<InventoryEventType, string>> = {
    PURCHASED: "Purchased",
    OPENED: "Opened",
    FINISHED: "Finished",
    RETURNED: "Returned",
    DISCARDED: "Discarded",
    ADJUSTMENT: "Adjustment",
  };
  return labels[type] ?? null;
}

async function findProjectedPageId(dataSourceId: string, eventId: string): Promise<string | null> {
  const response = await getNotionClient().dataSources.query({
    data_source_id: dataSourceId.replace(/^collection:\/\//, ""),
    page_size: 2,
    filter: {
      property: PRODUCT_TRACKER_EVENT_ID_PROPERTY,
      rich_text: { equals: eventId },
    },
  } as any);

  const pageIds = response.results
    .filter((row) => row.object === "page")
    .map((row) => row.id);

  if (pageIds.length > 1) {
    throw new Error(`Multiple Notion Inventory Events found for Product Tracker event ${eventId}`);
  }

  return pageIds[0] ?? null;
}

async function rememberProjectedPage(eventId: string, notionPageId: string): Promise<void> {
  const updated = await prisma.inventoryEvent.updateMany({
    where: { id: eventId, notionEventPageId: null },
    data: { notionEventPageId: notionPageId },
  });
  if (updated.count === 1) return;

  const current = await prisma.inventoryEvent.findUnique({
    where: { id: eventId },
    select: { notionEventPageId: true },
  });
  if (!current) throw new Error(`Inventory event ${eventId} disappeared while recording its Notion projection`);
  if (current.notionEventPageId && current.notionEventPageId !== notionPageId) {
    throw new Error(
      `Inventory event ${eventId} is already mapped to a different Notion page ${current.notionEventPageId}`,
    );
  }
}

export async function projectInventoryEvent(eventId: string): Promise<void> {
  const notionConfig = requireNotionConfig();
  const event = await prisma.inventoryEvent.findUnique({
    where: { id: eventId },
    include: { product: true, need: true },
  });
  if (!event || event.type === InventoryEventType.BASELINE || event.notionEventPageId) return;
  if (!event.product.notionPageId || !event.need.notionPageId) {
    throw new Error(`Cannot project inventory event ${event.id}: missing Notion product/need mapping`);
  }

  const eventType = notionEventType(event.type);
  if (!eventType) return;

  const existingPageId = await findProjectedPageId(notionConfig.inventoryEventsDataSourceId, event.id);
  if (existingPageId) {
    await rememberProjectedPage(event.id, existingPageId);
    return;
  }

  const created = await getNotionClient().pages.create({
    parent: { data_source_id: notionConfig.inventoryEventsDataSourceId.replace(/^collection:\/\//, "") },
    properties: {
      Event: { title: [{ text: { content: `${eventType} — ${event.product.name}` } }] },
      "Event Date": { date: { start: event.occurredAt.toISOString() } },
      "Event Type": { select: { name: eventType } },
      "Quantity Delta": { number: event.quantityDelta },
      Product: { relation: [{ id: event.product.notionPageId }] },
      "Shopping Need": { relation: [{ id: event.need.notionPageId }] },
      Source: { select: { name: sourceLabel(event.source) } },
      Notes: { rich_text: event.note ? [{ text: { content: event.note.slice(0, 1900) } }] : [] },
      [PRODUCT_TRACKER_EVENT_ID_PROPERTY]: { rich_text: [{ text: { content: event.id } }] },
    },
  } as any);

  await rememberProjectedPage(event.id, created.id);
}
