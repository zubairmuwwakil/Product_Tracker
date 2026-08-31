import { Client } from "@notionhq/client";
import { InventoryEventSource, InventoryEventType, type Prisma } from "@prisma/client";
import { normalizeNotionId, requireNotionConfig } from "../config.js";
import { prisma } from "../db.js";
import { reconcileNotionBalance } from "../services/inventory-service.js";

let client: Client | undefined;

export function getNotionClient(): Client {
  if (!client) {
    const notionConfig = requireNotionConfig();
    client = new Client({ auth: notionConfig.token });
  }
  return client;
}

type NotionPage = {
  id: string;
  last_edited_time: string;
  archived?: boolean;
  in_trash?: boolean;
  parent: Record<string, unknown>;
  properties: Record<string, any>;
};

function asFullPage(value: unknown): NotionPage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.object !== "page" || !candidate.properties || !candidate.parent) return null;
  return value as NotionPage;
}

function plainText(property: any): string | null {
  const items = property?.type === "title" ? property.title : property?.type === "rich_text" ? property.rich_text : null;
  if (!Array.isArray(items)) return null;
  const text = items.map((item) => item?.plain_text ?? "").join("").trim();
  return text || null;
}

function numberValue(property: any): number | null {
  return property?.type === "number" && typeof property.number === "number" ? property.number : null;
}

function checkboxValue(property: any): boolean {
  return property?.type === "checkbox" ? Boolean(property.checkbox) : false;
}

function selectValue(property: any): string | null {
  return property?.type === "select" ? property.select?.name ?? null : null;
}

function urlValue(property: any): string | null {
  return property?.type === "url" ? property.url ?? null : null;
}

function dateValue(property: any): Date | null {
  if (property?.type !== "date" || !property.date?.start) return null;
  const value = new Date(property.date.start);
  return Number.isNaN(value.getTime()) ? null : value;
}

function relationIds(property: any): string[] {
  if (property?.type !== "relation" || !Array.isArray(property.relation)) return [];
  return property.relation.map((item: any) => item.id).filter((id: unknown): id is string => typeof id === "string");
}

function parentDataSourceId(page: NotionPage): string | null {
  const parent = page.parent as Record<string, unknown>;
  if (parent.type === "data_source_id" && typeof parent.data_source_id === "string") {
    return parent.data_source_id;
  }
  return null;
}

function canonicalPageActive(page: NotionPage): boolean {
  return !page.archived && !page.in_trash && checkboxValue(page.properties["Active?"]);
}

function stableKeyOrNull(page: NotionPage, propertyName: "Need ID" | "Product ID"): string | null {
  return plainText(page.properties[propertyName]);
}

async function assertImmutableKey(input: {
  kind: "need" | "product";
  notionPageId: string;
  observedKey: string;
}): Promise<void> {
  const existing =
    input.kind === "need"
      ? await prisma.inventoryNeed.findUnique({ where: { notionPageId: input.notionPageId } })
      : await prisma.product.findUnique({ where: { notionPageId: input.notionPageId } });

  if (existing && existing.key !== input.observedKey) {
    throw new Error(
      `Stable ${input.kind} key changed in Notion from ${existing.key} to ${input.observedKey}. ` +
        "Change the display title instead, or migrate the key explicitly.",
    );
  }
}

async function syncNeedPageObject(page: NotionPage): Promise<string | null> {
  const active = canonicalPageActive(page);
  const key = stableKeyOrNull(page, "Need ID");

  if (!key) {
    const mapped = await prisma.inventoryNeed.findUnique({ where: { notionPageId: page.id } });
    if (mapped && !active) {
      await prisma.inventoryNeed.update({
        where: { id: mapped.id },
        data: { active: false, notionLastEditedAt: new Date(page.last_edited_time) },
      });
      return mapped.id;
    }
    return null;
  }

  await assertImmutableKey({ kind: "need", notionPageId: page.id, observedKey: key });

  const name = plainText(page.properties["Need"]) ?? key;
  const backupTarget = Math.max(0, Math.trunc(numberValue(page.properties["Backup Target"]) ?? 1));
  const reorderPoint = Math.max(0, Math.trunc(numberValue(page.properties["Reorder Point"]) ?? 1));

  const data = {
    name,
    aisle: selectValue(page.properties["Aisle"]),
    active,
    backupTarget,
    reorderPoint,
    defaultRetailer: selectValue(page.properties["Default Retailer"]),
    notes: plainText(page.properties["Notes"]),
    notionPageId: page.id,
    notionLastEditedAt: new Date(page.last_edited_time),
  };

  const existingByPage = await prisma.inventoryNeed.findUnique({ where: { notionPageId: page.id } });
  const need = existingByPage
    ? await prisma.inventoryNeed.update({ where: { id: existingByPage.id }, data })
    : await prisma.inventoryNeed.upsert({
        where: { key },
        create: { key, ...data },
        update: data,
      });

  return need.id;
}

async function syncProductPageObject(page: NotionPage): Promise<string | null> {
  const active = canonicalPageActive(page);
  const key = stableKeyOrNull(page, "Product ID");

  if (!key) {
    const mapped = await prisma.product.findUnique({ where: { notionPageId: page.id } });
    if (mapped && !active) {
      await prisma.product.update({
        where: { id: mapped.id },
        data: { active: false, notionLastEditedAt: new Date(page.last_edited_time) },
      });
      return mapped.id;
    }
    return null;
  }

  await assertImmutableKey({ kind: "product", notionPageId: page.id, observedKey: key });

  const relatedNeedIds = relationIds(page.properties["Shopping Need"]);
  if (relatedNeedIds.length !== 1) {
    throw new Error(`Product ${key} must relate to exactly one Shopping Need`);
  }

  const notionNeedPageId = relatedNeedIds[0]!;
  let need = await prisma.inventoryNeed.findUnique({ where: { notionPageId: notionNeedPageId } });
  if (!need) {
    await syncNeedPage(notionNeedPageId);
    need = await prisma.inventoryNeed.findUnique({ where: { notionPageId: notionNeedPageId } });
  }
  if (!need) throw new Error(`Could not resolve Shopping Need for product ${key}`);

  const lastEditedAt = new Date(page.last_edited_time);
  const data = {
    needId: need.id,
    name: plainText(page.properties["Product"]) ?? key,
    brand: plainText(page.properties["Brand"]),
    careArea: selectValue(page.properties["Care Area"]),
    active,
    paoMonths: numberValue(page.properties["PAO (months)"])
      ? Math.trunc(numberValue(page.properties["PAO (months)"])!)
      : null,
    price: numberValue(page.properties["Price"]),
    productUrl: urlValue(page.properties["Product Link"]),
    repurchasePolicy: selectValue(page.properties["Repurchase?"]),
    retailerOverride: selectValue(page.properties["Retailer Override"]),
    notes: plainText(page.properties["Notes"]),
    needsIdentification: checkboxValue(page.properties["Needs Identification?"]),
    notionPageId: page.id,
    notionLastEditedAt: lastEditedAt,
  };

  const existingByPage = await prisma.product.findUnique({ where: { notionPageId: page.id } });
  const product = existingByPage
    ? await prisma.product.update({ where: { id: existingByPage.id }, data })
    : await prisma.product.upsert({
        where: { key },
        create: { key, ...data },
        update: data,
      });

  const backupUnits = Math.max(0, Math.trunc(numberValue(page.properties["Backup Units"]) ?? 0));
  const inUseUnits = checkboxValue(page.properties["In Use?"]) ? 1 : 0;
  const openedAt = dateValue(page.properties["Opened Date"]);

  await reconcileNotionBalance({
    productKey: product.key,
    backupUnits,
    inUseUnits,
    openedAt,
    lastEditedAt,
  });

  return product.id;
}

export async function syncNeedPage(pageId: string): Promise<string | null> {
  const page = asFullPage(await getNotionClient().pages.retrieve({ page_id: pageId }));
  if (!page) throw new Error(`Notion page ${pageId} was partial or unavailable`);
  return syncNeedPageObject(page);
}

export async function syncProductPage(pageId: string): Promise<string | null> {
  const page = asFullPage(await getNotionClient().pages.retrieve({ page_id: pageId }));
  if (!page) throw new Error(`Notion page ${pageId} was partial or unavailable`);
  return syncProductPageObject(page);
}

export async function syncNotionPageById(pageId: string): Promise<void> {
  const page = asFullPage(await getNotionClient().pages.retrieve({ page_id: pageId }));
  if (!page) return;

  const parentId = parentDataSourceId(page);
  if (!parentId) return;
  const notionConfig = requireNotionConfig();
  const normalizedParent = normalizeNotionId(parentId);

  if (normalizedParent === normalizeNotionId(notionConfig.shoppingNeedsDataSourceId)) {
    await syncNeedPageObject(page);
  } else if (normalizedParent === normalizeNotionId(notionConfig.productsDataSourceId)) {
    await syncProductPageObject(page);
  }
}

export async function markNotionPageInactive(pageId: string): Promise<void> {
  await prisma.$transaction([
    prisma.product.updateMany({ where: { notionPageId: pageId }, data: { active: false } }),
    prisma.inventoryNeed.updateMany({ where: { notionPageId: pageId }, data: { active: false } }),
  ]);
}

async function queryAllPages(dataSourceId: string): Promise<string[]> {
  const notion = getNotionClient();
  const ids: string[] = [];
  let startCursor: string | undefined;

  do {
    const response = await notion.dataSources.query({
      data_source_id: dataSourceId.replace(/^collection:\/\//, ""),
      page_size: 100,
      filter: {
        property: "Active?",
        checkbox: { equals: true },
      },
      ...(startCursor ? { start_cursor: startCursor } : {}),
    });

    for (const row of response.results) {
      if (row.object === "page") ids.push(row.id);
    }
    startCursor = response.has_more && response.next_cursor ? response.next_cursor : undefined;
  } while (startCursor);

  return ids;
}

export async function bootstrapFromNotion(): Promise<{ needs: number; products: number }> {
  const notionConfig = requireNotionConfig();
  const needPageIds = await queryAllPages(notionConfig.shoppingNeedsDataSourceId);
  for (const id of needPageIds) await syncNeedPage(id);

  const productPageIds = await queryAllPages(notionConfig.productsDataSourceId);
  for (const id of productPageIds) await syncProductPage(id);

  return { needs: needPageIds.length, products: productPageIds.length };
}

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

export async function projectProductState(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { balance: true },
  });
  if (!product?.notionPageId || !product.balance) return;

  await getNotionClient().pages.update({
    page_id: product.notionPageId,
    properties: {
      "Backup Units": { number: product.balance.backupUnits },
      "In Use?": { checkbox: product.balance.inUseUnits === 1 },
      "Opened Date": {
        date:
          product.balance.inUseUnits === 1 && product.balance.openedAt
            ? { start: product.balance.openedAt.toISOString() }
            : null,
      },
    },
  } as any);
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
    },
  } as any);

  await prisma.inventoryEvent.update({
    where: { id: event.id },
    data: { notionEventPageId: created.id },
  });
}

export async function processNotionWebhookReceipt(receipt: {
  id: string;
  eventType: string;
  entityId: string | null;
  payload: Prisma.JsonValue;
}): Promise<void> {
  if (!receipt.entityId) return;
  if (receipt.eventType === "page.deleted") {
    await markNotionPageInactive(receipt.entityId);
    return;
  }
  if (receipt.eventType.startsWith("page.")) {
    await syncNotionPageById(receipt.entityId);
  }
}
