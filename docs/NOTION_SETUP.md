# Notion connection setup

Product Tracker starts in **mirror mode**: the existing Notion databases remain editable while Postgres begins collecting canonical state and inventory history.

## 1. Create/share a Notion integration

Create an internal Notion integration and give it read/write access to the three canonical data sources:

- Shopping Needs
- Personal Care Products
- Inventory Events

Store the integration token as `NOTION_TOKEN` in the deployment secret store.

## 2. Configure data source IDs

Set:

```text
NOTION_SHOPPING_NEEDS_DATA_SOURCE_ID=<Shopping Needs data source UUID>
NOTION_PRODUCTS_DATA_SOURCE_ID=<Personal Care Products data source UUID>
NOTION_INVENTORY_EVENTS_DATA_SOURCE_ID=<Inventory Events data source UUID>
```

The service accepts UUIDs with or without dashes and also tolerates a `collection://` prefix.

Do not commit the actual IDs or tokens into source control.

## 3. Bootstrap Postgres

After the database migration:

```bash
npm run bootstrap:notion
```

The importer loads active Shopping Needs first, then active Personal Care Products. The first observed product state creates a `BASELINE` inventory event. Later Notion count changes create `ADJUSTMENT` events rather than silently replacing history.

## 4. Deploy a public HTTPS endpoint

Notion requires a secure, publicly reachable webhook URL. Deploy the API and expose:

```text
POST https://<service-host>/webhooks/notion
```

## 5. Create the Notion webhook subscription

In the Notion integration's **Webhooks** tab, subscribe to:

- `page.created`
- `page.properties_updated`
- `page.deleted`
- `page.undeleted`

Notion sends a one-time `verification_token` to the endpoint. The API intentionally logs that token only during the unverified setup flow. Copy it into the deployment secret store as:

```text
NOTION_WEBHOOK_VERIFICATION_TOKEN=<verification token>
```

Then finish verification in the Notion UI and restart/redeploy the service with the secret present.

For production events, Product Tracker validates `X-Notion-Signature` against the **exact raw request body** using Notion's SDK helper.

Official docs: https://developers.notion.com/reference/webhooks

## 6. Run the outbox worker

Run exactly one worker initially:

```bash
npm run start:worker
```

API/agent mutations commit to Postgres first. The worker then updates the corresponding Notion Product row and appends a record to Notion's Inventory Events database. A Notion outage therefore cannot roll back or lose a committed inventory transaction.

## 7. Cutover criteria for Postgres-authoritative mode

Do not remove direct Notion editing immediately. First verify:

1. Bootstrap counts equal the Notion inventory view.
2. Notion edits reliably arrive as Postgres `ADJUSTMENT` events.
3. API purchases/open/finish operations project back to Notion.
4. Outbox retry/reconciliation is clean for at least a few normal inventory cycles.

After that, meaningful inventory changes should go through Product Tracker commands; Notion remains the display/control UI rather than the primary state store.
