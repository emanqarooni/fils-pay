# Bug fixes

| # | Where | Bug | Cause | Fix |
|---|---|---|---|---|
| 1 | ops/Dockerfile.node | compose failed: file not found | Dockerfile missing from repo copy | Created it (node:20, copy, npm install) |
| 2 | db/migrations/0054_views.sql | migrate failed: relation settlement_batch_events does not exist | View used a table no migration creates | Use transaction_events.settlement_batch_id IS NULL (from 0023) |
| 3 | db/migrations/0055_chart_of_accounts_suspense.sql | migrate failed: column "code" does not exist | Insert used columns of a different schema | Use real columns id, name, kind; kind 'asset' like 0007 |
| 4 | ops/docker-compose.yml (seed) | seed failed: encryption key decoded to 34 bytes | Built-in dev key has the wrong length | Set a valid 32-byte base64 WEBHOOK_SECRET_ENCRYPTION_KEY on seed |
| 5 | apps/web/vite.config.ts | login "Failed to fetch" (CORS) | API sends no CORS headers, web calls it cross-origin | Vite proxy for /v1 to :3000, VITE_API_BASE_URL empty |
