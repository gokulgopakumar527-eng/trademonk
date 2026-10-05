-- Phase 1 / migration 1: enums and shared trigger helpers.

create type public.market_kind as enum ('CRYPTO', 'NSE', 'BSE');
create type public.asset_type as enum ('CRYPTO', 'EQUITY', 'INDEX', 'ETF');
create type public.user_role as enum ('user', 'admin');
create type public.prediction_direction as enum ('BULLISH', 'BEARISH');
create type public.prediction_origin as enum ('USER', 'PLATFORM');
create type public.prediction_result_status as enum
  ('OPEN', 'WIN', 'LOSS', 'INVALIDATED', 'EXPIRED', 'PARTIAL');
create type public.prediction_update_kind as enum ('CORRECTION', 'REVISION', 'NOTE');
create type public.paper_trade_side as enum ('BUY', 'SELL', 'LONG', 'SHORT');
create type public.paper_trade_status as enum ('OPEN', 'CLOSED');
create type public.alert_status as enum ('ACTIVE', 'PAUSED', 'TRIGGERED', 'DISABLED');
create type public.notification_channel_kind as enum ('IN_APP', 'EMAIL', 'TELEGRAM', 'PUSH');
create type public.analysis_visibility as enum ('PUBLIC', 'PRIVATE');
create type public.subscription_plan as enum ('free', 'pro');
create type public.subscription_status as enum ('active', 'past_due', 'canceled', 'trialing');

-- Keeps updated_at honest on mutable tables.
create function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Used by append-only tables. Fires for every role, including service_role.
create function public.prevent_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% on %.% is not allowed: records are append-only',
    tg_op, tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;
