-- Phase 1 / migration 4: least-privilege grants + Row Level Security.
-- Two layers: table/column GRANTs decide what a role may attempt; RLS decides which rows.

-- Start from zero for the API roles, including future tables.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

revoke execute on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.purge_rate_limits(interval) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;
grant execute on function public.purge_rate_limits(interval) to service_role;
grant execute on function public.is_admin() to anon, authenticated;

-- Enable RLS on every table. No exceptions.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- ── Public reference & market data: read-only for everyone ──
grant select on public.assets, public.asset_metadata, public.market_quotes,
  public.market_candles, public.news_items, public.market_analysis to anon, authenticated;

create policy assets_read on public.assets for select to anon, authenticated using (true);
create policy asset_metadata_read on public.asset_metadata for select to anon, authenticated using (true);
create policy market_quotes_read on public.market_quotes for select to anon, authenticated using (true);
create policy market_candles_read on public.market_candles for select to anon, authenticated using (true);
create policy news_items_read on public.news_items for select to anon, authenticated using (true);
create policy market_analysis_read on public.market_analysis for select to anon, authenticated using (true);
-- Writes: service_role only (it bypasses RLS; API roles hold no write grants).

-- ── Profiles & preferences ──
grant select on public.profiles to authenticated;
grant update (name, avatar_url, timezone, preferred_currency, preferred_markets)
  on public.profiles to authenticated;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

grant select on public.user_preferences to authenticated;
grant update (default_timeframe, notification_prefs, ui_prefs) on public.user_preferences to authenticated;
create policy user_preferences_select on public.user_preferences for select to authenticated
  using (user_id = auth.uid());
create policy user_preferences_update on public.user_preferences for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Watchlists ──
grant select, delete on public.watchlists to authenticated;
grant insert (user_id, name) on public.watchlists to authenticated;
grant update (name) on public.watchlists to authenticated;
create policy watchlists_select on public.watchlists for select to authenticated using (user_id = auth.uid());
create policy watchlists_insert on public.watchlists for insert to authenticated with check (user_id = auth.uid());
create policy watchlists_update on public.watchlists for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy watchlists_delete on public.watchlists for delete to authenticated using (user_id = auth.uid());

grant select, delete on public.watchlist_items to authenticated;
grant insert (watchlist_id, asset_id) on public.watchlist_items to authenticated;
create policy watchlist_items_select on public.watchlist_items for select to authenticated
  using (exists (select 1 from public.watchlists w where w.id = watchlist_id and w.user_id = auth.uid()));
create policy watchlist_items_insert on public.watchlist_items for insert to authenticated
  with check (exists (select 1 from public.watchlists w where w.id = watchlist_id and w.user_id = auth.uid()));
create policy watchlist_items_delete on public.watchlist_items for delete to authenticated
  using (exists (select 1 from public.watchlists w where w.id = watchlist_id and w.user_id = auth.uid()));

-- ── Alerts & notifications ──
grant select, delete on public.alerts to authenticated;
grant insert (user_id, asset_id, alert_type, params) on public.alerts to authenticated;
grant update (params, status) on public.alerts to authenticated;
create policy alerts_select on public.alerts for select to authenticated using (user_id = auth.uid());
create policy alerts_insert on public.alerts for insert to authenticated with check (user_id = auth.uid());
create policy alerts_update on public.alerts for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy alerts_delete on public.alerts for delete to authenticated using (user_id = auth.uid());

grant select on public.alert_events to authenticated;         -- inserted by the server only
create policy alert_events_select on public.alert_events for select to authenticated using (user_id = auth.uid());

grant select on public.notification_channels to authenticated; -- linking is server-side (verification)
create policy notification_channels_select on public.notification_channels for select to authenticated
  using (user_id = auth.uid());

grant select, delete on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
create policy notifications_select on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_delete on public.notifications for delete to authenticated using (user_id = auth.uid());

-- ── Predictions: insert + select only. No UPDATE/DELETE grants exist at all. ──
grant select on public.predictions to authenticated;
grant insert (user_id, origin, asset_id, direction, target_price, invalidation_price,
              horizon_hours, timeframe, strategy_tag, rationale)
  on public.predictions to authenticated;
create policy predictions_select on public.predictions for select to authenticated
  using (user_id = auth.uid() or origin = 'PLATFORM' or public.is_admin());
create policy predictions_insert on public.predictions for insert to authenticated
  with check (
    user_id = auth.uid()
    and (origin = 'USER' or (origin = 'PLATFORM' and public.is_admin()))
  );

grant select on public.prediction_updates to authenticated;
grant insert (prediction_id, user_id, kind, new_target_price, new_invalidation_price, note)
  on public.prediction_updates to authenticated;
-- The sub-select is itself subject to predictions RLS, so visibility follows the parent.
create policy prediction_updates_select on public.prediction_updates for select to authenticated
  using (exists (select 1 from public.predictions p where p.id = prediction_id));
create policy prediction_updates_insert on public.prediction_updates for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.predictions p where p.id = prediction_id and p.user_id = auth.uid())
  );

grant select on public.prediction_results to authenticated;    -- written by the evaluator only
create policy prediction_results_select on public.prediction_results for select to authenticated
  using (exists (select 1 from public.predictions p where p.id = prediction_id));

-- ── Paper trading (NO REAL MONEY). Entry prices are server-set, so no client INSERT. ──
grant select on public.paper_trades to authenticated;
grant update (stop_loss, take_profit) on public.paper_trades to authenticated;
create policy paper_trades_select on public.paper_trades for select to authenticated using (user_id = auth.uid());
create policy paper_trades_update on public.paper_trades for update to authenticated
  using (user_id = auth.uid() and status = 'OPEN') with check (user_id = auth.uid());

grant select on public.paper_trade_results to authenticated;
create policy paper_trade_results_select on public.paper_trade_results for select to authenticated
  using (user_id = auth.uid());

-- ── AI analysis: PUBLIC rows for signed-in users, PRIVATE rows for the owner ──
grant select on public.ai_analysis to authenticated;
create policy ai_analysis_select on public.ai_analysis for select to authenticated
  using (visibility = 'PUBLIC' or user_id = auth.uid());

-- ── Subscriptions: read-only for users; a user must never grant themselves Pro ──
grant select on public.subscriptions to authenticated;
create policy subscriptions_select on public.subscriptions for select to authenticated using (user_id = auth.uid());
grant select on public.subscription_events to authenticated;
create policy subscription_events_select on public.subscription_events for select to authenticated
  using (exists (select 1 from public.subscriptions s where s.id = subscription_id and s.user_id = auth.uid()));

-- ── Audit logs: admins read; only the server writes ──
grant select on public.audit_logs to authenticated;
create policy audit_logs_select on public.audit_logs for select to authenticated using (public.is_admin());

-- rate_limits: RLS on, no policies, no grants => reachable only via check_rate_limit().
