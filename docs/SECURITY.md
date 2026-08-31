# Security notes

## Dependency policy

CI runs:

```bash
npm audit --omit=dev --audit-level=high
```

Production dependency advisories at High or Critical block merges unless there is a documented, time-bounded exception.

## Temporary `deepmerge-ts` override

As of 2026-08-31, Prisma 7.10.0's `@prisma/config` transitively pins `deepmerge-ts` below 8.0.0, which is affected by **GHSA-ggr8-5vv4-36mx / CVE-2026-40345** (stack exhaustion on recursive object graphs).

Product Tracker carries:

```json
{
  "overrides": {
    "deepmerge-ts": "^8.0.1"
  }
}
```

Rationale:

- patched `deepmerge-ts` starts at 8.0.0;
- `npm audit fix --force` proposes a breaking Prisma downgrade and is not acceptable;
- Prisma's affected use is its config loader, not request data handled by Product Tracker;
- Prisma's public issue for this advisory identifies the same consumer-side override while the upstream pin is being fixed;
- CI verifies Prisma schema validation, database application, production audit, TypeScript and tests with the override active.

**Removal condition:** on every Prisma minor upgrade, remove the override locally and run the production audit. Delete this override as soon as `@prisma/config` itself depends on `deepmerge-ts >= 8`.

References:

- https://github.com/advisories/GHSA-ggr8-5vv4-36mx
- https://github.com/prisma/orm/issues/30052

## Secret handling

Never commit:

- `DATABASE_URL` / `DIRECT_URL`
- `API_BEARER_TOKEN`
- `NOTION_TOKEN`
- `NOTION_WEBHOOK_VERIFICATION_TOKEN`

Notion webhook signature validation must always use the exact raw request body.
