-- Claude answer cache + atomic webhook secret storage (2026-11-08).
--
-- ai_answer_cache: cron and webhooks asked Claude ~640 times in a week about
-- 9 unchanged tasks (which store, is design done, what does this comment
-- want). qa-runner keys each answer by a hash of model + prompt + input, so
-- the same question is answered once. Pruned after 14 days by qa-runner.
--
-- add_asana_webhook_secret: every task webhook has its own hook secret.
-- asana-webhook used to read the list, change it and write it back, so two
-- writers at once could drop a fresh secret; that webhook's events then failed
-- signature checks and Asana deleted it. One upsert statement locks the row.
--
-- Service role only: no policies, RLS on.

create table if not exists public.ai_answer_cache (
  key text primary key,
  value jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.ai_answer_cache enable row level security;
revoke all on public.ai_answer_cache from anon, authenticated;
grant all on public.ai_answer_cache to service_role;

create index if not exists ai_answer_cache_created_at_idx
  on public.ai_answer_cache (created_at);

comment on table public.ai_answer_cache is
  'Claude answers keyed by a hash of model + prompt + input, so unchanged questions are not re-asked.';

create or replace function public.add_asana_webhook_secret(p_secret text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.promo_qa_settings (key, value, updated_at)
  values (
    'asana_webhook_secret',
    jsonb_build_object('secret', p_secret, 'secrets', jsonb_build_array(p_secret)),
    now()
  )
  on conflict (key) do update
  set
    value = jsonb_build_object(
      'secret', p_secret,
      'secrets', jsonb_build_array(p_secret) || coalesce((
        select jsonb_agg(existing)
        from jsonb_array_elements(promo_qa_settings.value -> 'secrets') existing
        where existing <> to_jsonb(p_secret)
      ), '[]'::jsonb)
    ),
    updated_at = now();
$$;

revoke all on function public.add_asana_webhook_secret(text) from public, anon, authenticated;
grant execute on function public.add_asana_webhook_secret(text) to service_role;
