-- Phase 1 / migration 2: tables. RLS + grants are in migration 4.
-- `users` is Supabase's auth.users; `profiles` extends it.

-- ── Identity ───────────────────────────────────────────────
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text,
  avatar_url text,
  timezone text not null default 'Asia/Kolkata',
  preferred_currency text not null default 'INR' check (preferred_currency ~ '^[A-Z]{3}$'),
  preferred_markets public.market_kind[] not null default '{}',
  role public.user_role not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  default_timeframe text not null default '1D',
  notification_prefs jsonb not null default '{"in_app": true, "email": false, "telegram": false}',
  ui_prefs jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Reference & market data (public read, server write) ────
create table public.assets (
  id uuid primary key default gen_random_uuid(),
  market public.market_kind not null,
  symbol text not null,
  name text not null,
  asset_type public.asset_type not null,
  currency text not null check (currency ~ '^[A-Z]{3,5}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (market, symbol)
);

create table public.asset_metadata (
  asset_id uuid primary key references public.assets (id) on delete cascade,
  metadata jsonb not null default '{}',
  source text,
  updated_at timestamptz not null default now()
);

-- Latest snapshot per asset. `source` and `as_of` are mandatory so the UI can
-- always show where data came from and how fresh it is.
create table public.market_quotes (
  asset_id uuid primary key references public.assets (id) on delete cascade,
  price numeric not null,
  change_pct numeric,
  volume numeric,
  source text not null,
  is_mock boolean not null default false,
  as_of timestamptz not null,
  fetched_at timestamptz not null default now()
);

create table public.market_candles (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets (id) on delete cascade,
  timeframe text not null,
  open_time timestamptz not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume numeric,
  source text not null,
  is_mock boolean not null default false,
  unique (asset_id, timeframe, open_time, source)
);
create index market_candles_lookup_idx
  on public.market_candles (asset_id, timeframe, open_time desc);

create table public.news_items (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  title text not null,
  url text not null unique,
  summary text,
  published_at timestamptz not null,
  asset_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index news_items_published_idx on public.news_items (published_at desc);

-- ── Watchlists ─────────────────────────────────────────────
create table public.watchlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.watchlist_items (
  id uuid primary key default gen_random_uuid(),
  watchlist_id uuid not null references public.watchlists (id) on delete cascade,
  asset_id uuid not null references public.assets (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (watchlist_id, asset_id)
);
create index watchlist_items_watchlist_idx on public.watchlist_items (watchlist_id);

-- ── Alerts & notifications ─────────────────────────────────
create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  asset_id uuid references public.assets (id) on delete cascade,
  alert_type text not null,
  params jsonb not null default '{}',
  status public.alert_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index alerts_user_idx on public.alerts (user_id, status);

create table public.alert_events (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.alerts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  triggered_at timestamptz not null default now(),
  payload jsonb not null default '{}'
);
create index alert_events_alert_idx on public.alert_events (alert_id, triggered_at desc);

create table public.notification_channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind public.notification_channel_kind not null,
  destination text,            -- e.g. telegram chat id; never a secret
  is_verified boolean not null default false,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, kind)
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

-- ── Predictions (append-only; see migration 3 for enforcement) ──
-- `user_id` is the author: the member for USER origin, the publishing admin
-- for PLATFORM origin. Account deletion is RESTRICTed on purpose: it must not
-- be able to erase history. See README "Unresolved decisions".
create table public.predictions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete restrict,
  origin public.prediction_origin not null default 'USER',
  asset_id uuid not null references public.assets (id) on delete restrict,
  direction public.prediction_direction not null,
  target_price numeric not null check (target_price > 0),
  invalidation_price numeric not null check (invalidation_price > 0),
  horizon_hours integer not null check (horizon_hours between 1 and 8760),
  timeframe text,
  strategy_tag text,
  rationale text check (char_length(rationale) <= 4000),
  entry_reference_price numeric check (entry_reference_price > 0),
  -- Server-controlled (set by trigger, client values are ignored):
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now(),
  content_hash text not null default '',
  check (
    (direction = 'BULLISH' and target_price > invalidation_price) or
    (direction = 'BEARISH' and target_price < invalidation_price)
  )
);
create index predictions_user_idx on public.predictions (user_id, created_at desc);
create index predictions_asset_idx on public.predictions (asset_id, created_at desc);
create index predictions_origin_idx on public.predictions (origin, created_at desc);

create table public.prediction_updates (
  id uuid primary key default gen_random_uuid(),
  prediction_id uuid not null references public.predictions (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  version integer not null default 0,       -- assigned by trigger
  kind public.prediction_update_kind not null,
  new_target_price numeric check (new_target_price > 0),
  new_invalidation_price numeric check (new_invalidation_price > 0),
  note text not null check (char_length(note) between 1 and 4000),
  created_at timestamptz not null default now(),
  unique (prediction_id, version)
);
create index prediction_updates_prediction_idx on public.prediction_updates (prediction_id, version);

-- One final outcome per prediction. A prediction with no row here is OPEN.
-- Written only by the server-side evaluator (service role).
create table public.prediction_results (
  id uuid primary key default gen_random_uuid(),
  prediction_id uuid not null unique references public.predictions (id) on delete restrict,
  status public.prediction_result_status not null check (status <> 'OPEN'),
  closed_at timestamptz not null,
  exit_price numeric check (exit_price > 0),
  return_pct numeric,
  evaluation_meta jsonb not null default '{}',   -- candle range/source used
  created_at timestamptz not null default now()
);

-- ── Paper trading (NO REAL MONEY) ──────────────────────────
create table public.paper_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  asset_id uuid not null references public.assets (id) on delete restrict,
  side public.paper_trade_side not null,
  entry_price numeric not null check (entry_price > 0),
  quantity numeric not null check (quantity > 0),
  stop_loss numeric check (stop_loss > 0),
  take_profit numeric check (take_profit > 0),
  fees numeric not null default 0 check (fees >= 0),
  strategy_tag text,
  status public.paper_trade_status not null default 'OPEN',
  opened_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index paper_trades_user_idx on public.paper_trades (user_id, opened_at desc);

create table public.paper_trade_results (
  id uuid primary key default gen_random_uuid(),
  paper_trade_id uuid not null unique references public.paper_trades (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  exit_price numeric not null check (exit_price > 0),
  fees numeric not null default 0,
  pnl numeric not null,
  closed_at timestamptz not null default now()
);

-- ── Analysis ───────────────────────────────────────────────
-- Deterministic output of the technical/structure engines (no AI).
create table public.market_analysis (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets (id) on delete cascade,
  timeframe text not null,
  result jsonb not null,
  data_as_of timestamptz not null,
  created_at timestamptz not null default now()
);
create index market_analysis_lookup_idx on public.market_analysis (asset_id, timeframe, created_at desc);

-- AI output, with enough provenance to cache and audit it.
create table public.ai_analysis (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references public.assets (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete cascade,
  visibility public.analysis_visibility not null default 'PRIVATE',
  kind text not null,
  result jsonb not null,
  provider text not null,
  model text not null,
  prompt_version text not null,
  input_hash text not null,
  data_as_of timestamptz not null,
  created_at timestamptz not null default now(),
  check (visibility = 'PUBLIC' or user_id is not null)
);
create index ai_analysis_lookup_idx on public.ai_analysis (asset_id, kind, created_at desc);
create index ai_analysis_input_hash_idx on public.ai_analysis (input_hash);

-- ── Commercial & operations ────────────────────────────────
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  plan public.subscription_plan not null default 'free',
  status public.subscription_status not null default 'active',
  provider text,
  provider_subscription_id text,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions (id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);

-- Postgres-backed rate limiting (Upstash can replace this later).
create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

-- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','user_preferences','assets','asset_metadata','watchlists','alerts',
    'notification_channels','paper_trades','subscriptions'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I
       for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
