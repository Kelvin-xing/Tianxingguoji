<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project-Specific Context

## Crawler Integration

This frontend is connected to the Hong Kong school admission crawler in:

```text
/Users/mingjiexing/Desktop/Tianxingguoji/automated_tracker_for_school_listing/hk-school-platform
```

Crawler production handoff source:

```text
hk-school-platform/apps/crawler/output/published/latest
```

Frontend deployed snapshot location:

```text
erp-frontend/data/crawler-source/latest
```

The frontend currently reads these Git-committed snapshot files:

- `records.json`
- `review_queue.json`
- `run_summary.json`
- `publish_manifest.json`

The UI accesses crawler data through these Next.js API routes:

- `GET /api/crawler/schools`
- `GET /api/crawler/review-queue`
- `GET /api/crawler/summary`
- `GET/POST/PATCH /api/crawler/tickets`
- `GET/PUT /api/crawler/config`
- `GET/POST /api/crawler/review-decisions`

Writable state uses Neon Postgres through `DATABASE_URL`, not local JSON:

- `crawler_tickets`
- `crawler_review_decisions`
- `crawler_config`
- `crawler_runs`

`lib/crawler/db.ts` auto-creates those tables if missing.

## Current Pages

- `/selector`: full school filtering from crawler snapshot.
- `/schools`: admission operations table with per-school ticket button.
- `/dashboard`: crawler summary and school counts.
- `/admin/crawler`: crawl config, review queue, review decisions, and user tickets.
- `/students` and `/students/[id]`: student CRM; details include the 16-field study application assessment.

## Deployment Workflow

The frontend is deployed by Vercel from GitHub. Do not run local `pnpm lint` or `pnpm build` unless the user explicitly asks.

Preferred workflow:

1. Modify frontend code or synced snapshot.
2. Commit in this repo.
3. Push `main` to `origin`.
4. Let Vercel build/deploy.

## Current Limitation And Next Step

Crawler school data does not auto-update in Vercel yet. A new crawler run only updates the crawler repo output. The frontend sees it after copying these files into `data/crawler-source/latest`, committing, and pushing this frontend repo.

Next planned improvement: add an automated sync job after crawler production publish that copies the four snapshot files into this repo and pushes a deploy commit, or replace Git snapshots with a database/object-storage source read directly by the frontend.
