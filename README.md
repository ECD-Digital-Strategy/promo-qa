# Promo QA Automation

Serverless QA for Shopify banner scheduling. Supabase Edge Functions watch
Emil's incomplete Asana banner QA tasks, read the linked theme's
`templates/index.json` through Shopify Theme Access, and ask Claude to
interpret varying task and theme schemas. Deterministic code re-checks dates,
links, and disabled blocks before anything is written.

Only banner QA tasks are in scope: the name must contain both "banner" (or
"banners") and "QA", e.g. "Banner Upload QA" or "Promo Banner QA". Discount
cards like "Promo QA" or "LABOR15 QA" are ignored.

- Confident pass: completes the QA task.
- Failure or ambiguity: leaves the task open and comments with the exact
  issues. The same issues are never posted twice, even on forced runs; a new
  comment only goes out when the issues change.
- No theme editor link yet (due within 3 days, design done): one casual
  reminder tagging the Banner Upload assignee.
- Store without Theme Access: one casual comment plus an email to Emil.
- @mentioning Emil on the QA task or its parent ("ready", "fixed",
  "uploaded") forces a fresh QA and gets a 1-2 sentence reply.

## Triggers

- `asana-webhook` receives project webhooks plus task-level webhooks on every
  open banner QA task and its parent. Banner Upload QA cards are usually nested
  subtasks with no project, so project webhooks alone miss their comments.
- `qa-runner` registers task webhooks for new QA tasks on every run and, on
  full sweeps, removes them once a QA task is no longer open.
  `npm run webhook:sync-tasks` does the same on demand (`-- --dry-run` to
  preview).
- A `pg_cron` safety net (`promo-qa-safety-net`) runs a full sweep every
  4 hours. Full sweeps reconcile task webhooks against Asana's own list, and
  the cron run also prunes run history older than 90 days.
- `asana-webhook` only accepts a new hook-secret handshake while qa-runner or a
  setup script has opened a short registration window, answers Asana
  immediately, and runs each comment once even when both a project and a task
  webhook deliver it.
- Claude answers for store, design-readiness and comment-intent questions are
  cached for 14 days by their exact input (`ai_answer_cache`), so unchanged
  tasks aren't re-asked on every sweep.

## Safety

- Theme Access tokens are encrypted in Postgres using a key held only in Edge
  Function secrets.
- The browser-facing Supabase roles cannot read `stores` or `qa_runs`.
- Dry runs never complete tasks, comment, email, or write run history.
- Claude identifies fields, but code independently re-reads and exactly compares
  the mapped dates and links before permitting completion.

## Configure and deploy

Requirements: Node 20+, Supabase CLI, a Supabase project, Asana PAT, Anthropic
API key, one Shopify Theme Access token per store, and optional SMTP details.

1. Copy `.env.example` to `.env.local` and fill the local values. Generate
   `STORE_TOKEN_ENCRYPTION_KEY` as a long random value and keep it stable.

2. Link the intended Supabase project and apply migrations:

   ```powershell
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push
   ```

3. Set Edge Function secrets:

   ```powershell
   supabase secrets set ASANA_ACCESS_TOKEN="..." ANTHROPIC_API_KEY="..." STORE_TOKEN_ENCRYPTION_KEY="..."
   supabase secrets set SMTP_HOST="..." SMTP_PORT="587" SMTP_SECURE="false" SMTP_USER="..." SMTP_PASS="..." SMTP_FROM="..." ALERT_EMAIL_TO="..."
   ```

   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are supplied to hosted Edge
   Functions automatically.

4. Register each store. The token stays in `.env.local` and is encrypted before
   storage:

   ```powershell
   npm run store:seed -- power-planter-augers power-planter-augers.myshopify.com
   ```

5. Deploy:

   ```powershell
   supabase functions deploy qa-runner asana-webhook admin-api --project-ref YOUR_PROJECT_REF
   ```

6. Add the project URL and the runner secret to Supabase Vault so `pg_cron`
   can call `qa-runner` with the `x-qa-runner-secret` header:

   ```sql
   select vault.create_secret(
     'https://YOUR_PROJECT_REF.supabase.co',
     'promo_qa_project_url'
   );
   select vault.create_secret(
     'SAME_VALUE_AS_QA_RUNNER_SECRET',
     'promo_qa_runner_secret'
   );
   ```

   The migrations schedule `public.invoke_promo_qa_runner()` every 4 hours.
   Until both Vault values exist, it safely skips runs with a database warning.

7. Register webhooks: `npm run webhook:register` (project webhooks) and
   `npm run webhook:sync-tasks` (task-level webhooks on banner QA cards).

## Verify before enabling writes

Run unit tests:

```powershell
npm test
```

Dry-run one Asana task against the deployed or locally served function:

```powershell
npm run qa:local -- 1215994997303258
```

Set `SUPABASE_FUNCTION_URL=http://127.0.0.1:54321/functions/v1/qa-runner` to
target `supabase functions serve`. The request always sends
`dryRun: true, force: true`, so it never writes to Asana.

For a real run that writes to Asana, POST to `qa-runner` with the
`x-qa-runner-secret` header and `{ "taskGid": "...", "dryRun": false, "force": true }`.
`force` re-runs QA even if the task is unchanged, but still won't repeat a
comment that is already on the task.

## Add another store

Add its local token using the normalized variable name:

```dotenv
SHOPIFY_THEME_ACCESS__NEW_STORE=shptka_...
```

Then run:

```powershell
npm run store:seed -- new-store new-store.myshopify.com
```

No code or redeployment is required.
