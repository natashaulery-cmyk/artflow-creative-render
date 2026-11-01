# Art Flow Creative — Railway migration (staging only)

**Status:** planning / preparation. Production remains on Vercel. Do not point artflowcreative.com at Railway, cancel Vercel, or merge this branch before a complete working staging deployment.

## Existing application

- Repository: `nulery3529/artflow-creative`, branch `main`.
- Web app: Vite + React, output `dist/`.
- Server: Vercel-style Node handlers in `api/*.mjs`; these are **not** automatically served by Railway as Vercel functions. A real Node HTTP adapter/server is required.
- Auth: Better Auth, backed by PostgreSQL.
- Data: PostgreSQL connection through `DATABASE_URL` / `POSTGRES_URL` (Neon in current source). Check the actual database and its backups before a cutover; Vercel hosting and database billing are separate.
- Four hourly sync jobs in `vercel.json`: `gmail-sales-cron` (minute 0), `marketplace-orders-cron` (minute 10), `yahoo-mail-cron` (minute 20), `gmail-expense-cron` (minute 30), all UTC. Railway scheduled jobs must be set up separately and verified; Vercel cron headers will not exist there.
- Domain: `artflowcreative.com`, `www.artflowcreative.com`; Wix nameservers `ns8.wixdns.net` and `ns9.wixdns.net` currently point traffic to Vercel. Keep DNS untouched until Railway tests pass.
- There is a legacy `/api/mobile-listing-sync` rewrite to a Vercel-hosted proxy; avoid leaving Railway dependent on that Vercel proxy.
- Application uses OAuth integrations, mailbox webhooks, and password resets; all service callbacks and redirect URLs require verification.

## Deployment sequence

1. Connect Railway and its GitHub integration to `nulery3529/artflow-creative`, using the `railway-migration` branch first.
2. Implement and test a Node server that serves both the `dist/` app and every needed `api/` handler. Preserve raw request streams for signed webhooks and Better Auth; do not expose `api/_*.mjs` helpers.
3. Verify the existing PostgreSQL database is available and back up user data. If the Neon project was deleted, recover or replace its database **before** promoting the site.
4. Transfer required variable **values securely into Railway** from the owner's secret manager/Vercel, never into GitHub or a markdown file. Existing variable *names* found in Vercel: `DATABASE_URL`, `POSTGRES_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_DEV_ID`, `EBAY_RUNAME`, `RESEND_API_KEY`, `PASSWORD_RESET_FROM`, `RESEND_EXPENSE_WEBHOOK_SECRET`, `JWT_SECRET`, `OPENAI_API_KEY`. The existing project also has legacy Etsy keys; do not copy unneeded credentials.
5. Create a new `CRON_SECRET`, configure secure authenticated scheduled jobs at the original four UTC schedules, and prevent simultaneous duplicate syncs from Vercel.
6. Deploy to a Railway temporary URL. Check homepage, login/logout, account creation, password reset, session renewal, dashboard, orders, expenses, eBay connection, Gmail sync, Yahoo sync, and all webhooks. Confirm OAuth redirect URIs and Better Auth base URL for the new origin.
7. Check Railway usage and billing assumptions. A $5 plan does not guarantee a $5 bill; always-on services, job usage, and Neon are additional consumption/cost considerations.
8. Add the domain on Railway, update DNS at Wix only after staging passes, monitor error logs and order ingestion, then decommission Vercel and its schedules. Keep a tested rollback path.

## Non-goals / safety

- Never commit tokens, secrets, database dumps, or private data.
- Never change production DNS or delete Vercel automatically as part of a migration preparation branch.
- Never assume a successful static Vite deploy means login, database, APIs, or cron jobs work.
- Avoid enabling Vercel and Railway cron jobs at the same time.
