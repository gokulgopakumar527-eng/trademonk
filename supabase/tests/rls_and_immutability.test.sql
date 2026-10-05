-- RLS, grants and immutability tests. Plain SQL: any failed assertion aborts with an error.
-- Run with: pnpm test:db

create schema t;
grant usage on schema t to public;

create function t.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end $$;

-- Runs sql as the current role; passes only if it raises an error.
create function t.fails(q text, label text) returns void language plpgsql as $$
begin
  begin
    execute q;
  exception when others then
    raise notice 'PASS: % [%]', label, sqlerrm;
    return;
  end;
  raise exception 'FAIL (statement succeeded but should have failed): %', label;
end $$;

create function t.count_is(q text, expected int, label text) returns void language plpgsql as $$
declare n int;
begin
  execute 'select count(*) from (' || q || ') s' into n;
  if n <> expected then raise exception 'FAIL: % (expected %, got %)', label, expected, n; end if;
  raise notice 'PASS: %', label;
end $$;

create function t.login(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', uid::text, true);
  execute 'set local role authenticated';
end $$;
create function t.anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
end $$;
create function t.service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role service_role';
end $$;
create function t.superuser() returns void language plpgsql as $$
begin
  execute 'reset role';
end $$;

-- ── Fixtures (as superuser) ──
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice@example.test', '{"name":"Alice"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bob@example.test', '{}'),
  ('cccccccc-0000-0000-0000-000000000003', 'admin@example.test', '{}');
update public.profiles set role = 'admin' where id = 'cccccccc-0000-0000-0000-000000000003';
insert into public.assets (id, market, symbol, name, asset_type, currency) values
  ('dddddddd-0000-0000-0000-000000000001', 'CRYPTO', 'BTC', 'Bitcoin', 'CRYPTO', 'USDT');

-- ── 1. Bootstrap & structural checks ──
do $$
begin
  perform t.ok((select count(*) from public.profiles) = 3, 'profile created for each new auth user');
  perform t.ok((select name from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'Alice', 'profile name from signup metadata');
  perform t.ok((select name from public.profiles where id = 'bbbbbbbb-0000-0000-0000-000000000002') = 'bob', 'profile name falls back to email prefix');
  perform t.ok((select count(*) from public.user_preferences) = 3, 'preferences row created');
  perform t.ok((select count(*) from public.subscriptions where plan = 'free' and status = 'active') = 3, 'free subscription created');
  perform t.ok(
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity) = 0,
    'RLS is enabled on every public table');
end $$;

-- ── 2. Anonymous access ──
do $$
begin
  perform t.anon();
  perform t.count_is('select 1 from public.assets', 1, 'anon can read assets');
  perform t.fails('select * from public.profiles', 'anon cannot read profiles');
  perform t.fails('select * from public.predictions', 'anon cannot read predictions');
  perform t.fails('select * from public.subscriptions', 'anon cannot read subscriptions');
  perform t.fails($q$insert into public.assets (market, symbol, name, asset_type, currency) values ('CRYPTO','ETH','Ether','CRYPTO','USDT')$q$, 'anon cannot write assets');
  perform t.fails('select * from public.rate_limits', 'anon cannot read rate_limits');
  perform t.superuser();
end $$;

-- ── 3. Profiles ──
do $$
begin
  perform t.login('aaaaaaaa-0000-0000-0000-000000000001');
  perform t.count_is('select 1 from public.profiles', 1, 'user sees only own profile');
  perform t.fails($q$update public.profiles set role = 'admin' where id = 'aaaaaaaa-0000-0000-0000-000000000001'$q$, 'user cannot promote self to admin');
  update public.profiles set name = 'Alice A' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  perform t.ok((select name from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'Alice A', 'user can update own name');
  update public.profiles set name = 'Hacked' where id = 'bbbbbbbb-0000-0000-0000-000000000002';
  perform t.superuser();
  perform t.ok((select name from public.profiles where id = 'bbbbbbbb-0000-0000-0000-000000000002') = 'bob', 'user cannot update another profile');
  perform t.ok((select role from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'user', 'role unchanged');
  perform t.login('cccccccc-0000-0000-0000-000000000003');
  perform t.count_is('select 1 from public.profiles', 3, 'admin can read all profiles');
  perform t.superuser();
end $$;

-- ── 4. Watchlists ──
do $$
declare wl uuid;
begin
  perform t.login('aaaaaaaa-0000-0000-0000-000000000001');
  insert into public.watchlists (user_id, name) values ('aaaaaaaa-0000-0000-0000-000000000001', 'Crypto') returning id into wl;
  insert into public.watchlist_items (watchlist_id, asset_id) values (wl, 'dddddddd-0000-0000-0000-000000000001');
  perform t.count_is('select 1 from public.watchlists', 1, 'owner sees own watchlist');

  perform t.login('bbbbbbbb-0000-0000-0000-000000000002');
  perform t.count_is('select 1 from public.watchlists', 0, 'other user cannot see watchlist');
  perform t.count_is('select 1 from public.watchlist_items', 0, 'other user cannot see watchlist items');
  perform t.fails(format($q$insert into public.watchlists (user_id, name) values ('aaaaaaaa-0000-0000-0000-000000000001', 'Spoof')$q$), 'cannot create watchlist for another user');
  perform t.fails(format($q$insert into public.watchlist_items (watchlist_id, asset_id) values (%L, 'dddddddd-0000-0000-0000-000000000001')$q$, wl), 'cannot add items to another user''s watchlist');
  delete from public.watchlists where id = wl;
  perform t.superuser();
  perform t.ok((select count(*) from public.watchlists where id = wl) = 1, 'other user cannot delete watchlist');
end $$;

-- ── 5. Predictions: creation, server timestamp, isolation ──
do $$
declare pid uuid; pid_platform uuid;
begin
  perform t.login('aaaaaaaa-0000-0000-0000-000000000001');
  insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours, rationale)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24, 'test')
  returning id into pid;

  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours, created_at)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24, '2020-01-01')$q$,
    'client cannot supply created_at');
  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 100, 200, 24)$q$,
    'bullish target must be above invalidation');
  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BEARISH', 200, 100, 24)$q$,
    'bearish target must be below invalidation');
  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours)
    values ('bbbbbbbb-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24)$q$,
    'cannot create prediction as another user');
  perform t.fails($q$insert into public.predictions (user_id, origin, asset_id, direction, target_price, invalidation_price, horizon_hours)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'PLATFORM', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24)$q$,
    'non-admin cannot publish PLATFORM prediction');

  perform t.login('cccccccc-0000-0000-0000-000000000003');
  insert into public.predictions (user_id, origin, asset_id, direction, target_price, invalidation_price, horizon_hours)
  values ('cccccccc-0000-0000-0000-000000000003', 'PLATFORM', 'dddddddd-0000-0000-0000-000000000001', 'BEARISH', 50, 80, 48)
  returning id into pid_platform;

  perform t.login('bbbbbbbb-0000-0000-0000-000000000002');
  perform t.count_is(format('select 1 from public.predictions where id = %L', pid), 0, 'other user cannot see private prediction');
  perform t.count_is(format('select 1 from public.predictions where id = %L', pid_platform), 1, 'signed-in user can see PLATFORM prediction');

  perform t.superuser();
  -- Server-generated fields, even when a privileged role tries to backdate.
  insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours, created_at)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24, '2020-01-01');
  perform t.ok((select min(created_at) from public.predictions) > now() - interval '1 minute', 'created_at is server-generated (backdating ignored)');
  perform t.ok((select bool_and(expires_at = created_at + make_interval(hours => horizon_hours)) from public.predictions), 'expires_at derived from server time + horizon');
  perform t.ok((select bool_and(char_length(content_hash) = 64) from public.predictions), 'content_hash populated (sha256)');
end $$;

-- ── 6. Predictions: immutability (every role) ──
do $$
declare pid uuid;
begin
  select id into pid from public.predictions where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' order by created_at limit 1;

  perform t.login('aaaaaaaa-0000-0000-0000-000000000001');
  perform t.fails(format('update public.predictions set target_price = 999 where id = %L', pid), 'owner cannot edit prediction');
  perform t.fails(format('delete from public.predictions where id = %L', pid), 'owner cannot delete prediction');

  perform t.service();
  perform t.fails(format('update public.predictions set target_price = 999 where id = %L', pid), 'service_role cannot edit prediction');
  perform t.fails(format('delete from public.predictions where id = %L', pid), 'service_role cannot delete prediction');
  perform t.fails('truncate public.predictions', 'service_role cannot truncate predictions');

  perform t.superuser();
  perform t.fails(format('update public.predictions set target_price = 999 where id = %L', pid), 'superuser cannot edit prediction (trigger)');
  perform t.fails(format('delete from public.predictions where id = %L', pid), 'superuser cannot delete prediction (trigger)');
  perform t.fails('delete from public.profiles where id = ''aaaaaaaa-0000-0000-0000-000000000001''', 'account deletion cannot cascade into prediction history');
end $$;

-- ── 7. Prediction updates (versioned corrections) & results ──
do $$
declare pid uuid; hash_before text; uid uuid;
begin
  select id, content_hash into pid, hash_before from public.predictions
    where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' order by created_at limit 1;

  perform t.login('aaaaaaaa-0000-0000-0000-000000000001');
  insert into public.prediction_updates (prediction_id, user_id, kind, new_target_price, note)
    values (pid, 'aaaaaaaa-0000-0000-0000-000000000001', 'REVISION', 210, 'raised target');
  insert into public.prediction_updates (prediction_id, user_id, kind, note)
    values (pid, 'aaaaaaaa-0000-0000-0000-000000000001', 'NOTE', 'second note');
  perform t.ok((select array_agg(version order by version) from public.prediction_updates where prediction_id = pid) = array[1,2], 'updates get server-assigned versions 1,2');
  perform t.fails(format($q$update public.prediction_updates set note = 'rewrite' where prediction_id = %L$q$, pid), 'update rows are immutable');
  perform t.fails(format($q$delete from public.prediction_updates where prediction_id = %L$q$, pid), 'update rows cannot be deleted');

  perform t.login('bbbbbbbb-0000-0000-0000-000000000002');
  perform t.count_is(format('select 1 from public.prediction_updates where prediction_id = %L', pid), 0, 'other user cannot see updates of private prediction');
  perform t.fails(format($q$insert into public.prediction_updates (prediction_id, user_id, kind, note) values (%L, 'bbbbbbbb-0000-0000-0000-000000000002', 'NOTE', 'x')$q$, pid), 'other user cannot add updates to my prediction');

  perform t.superuser();
  perform t.ok((select content_hash from public.predictions where id = pid) = hash_before, 'original prediction snapshot unchanged by updates');

  -- Results: server only, final statuses only, one per prediction, immutable.
  perform t.login('aaaaaaaa-0000-0000-0000-000000000001');
  perform t.fails(format($q$insert into public.prediction_results (prediction_id, status, closed_at) values (%L, 'WIN', now())$q$, pid), 'user cannot write results');
  perform t.service();
  perform t.fails(format($q$insert into public.prediction_results (prediction_id, status, closed_at) values (%L, 'OPEN', now())$q$, pid), 'result status cannot be OPEN');
  -- Phase 5B (migration 6): even the server cannot hand-write a result for a manual or unexpired
  -- prediction. Result immutability, uniqueness, RLS and the updates lock are covered in section 9.
  perform t.fails(format($q$insert into public.prediction_results (prediction_id, status, closed_at, exit_price, return_pct) values (%L, 'WIN', now(), 205, 5)$q$, pid), 'hand-written result for a manual, unexpired prediction is rejected');
  perform t.superuser();
end $$;

-- ── 8. Paper trading, subscriptions, notifications, AI, audit, market writes, rate limit ──
do $$
declare tid uuid; nid uuid; ai_id uuid; ok boolean;
begin
  insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'LONG', 100, 1) returning id into tid;

  perform t.login('aaaaaaaa-0000-0000-0000-000000000001');
  perform t.count_is('select 1 from public.paper_trades', 1, 'owner sees own paper trade');
  update public.paper_trades set stop_loss = 90 where id = tid;
  perform t.fails(format('update public.paper_trades set entry_price = 1 where id = %L', tid), 'user cannot edit paper trade entry price');
  perform t.fails($q$insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity) values ('aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','LONG',1,1)$q$, 'paper trade entry is server-set (no client insert)');
  perform t.login('bbbbbbbb-0000-0000-0000-000000000002');
  perform t.count_is('select 1 from public.paper_trades', 0, 'other user cannot see paper trade');

  perform t.login('aaaaaaaa-0000-0000-0000-000000000001');
  perform t.count_is('select 1 from public.subscriptions', 1, 'user sees only own subscription');
  perform t.fails($q$update public.subscriptions set plan = 'pro'$q$, 'user cannot grant themselves Pro');
  perform t.fails($q$insert into public.subscriptions (user_id, plan) values ('aaaaaaaa-0000-0000-0000-000000000001','pro')$q$, 'user cannot insert subscription');

  perform t.superuser();
  insert into public.notifications (user_id, title) values ('aaaaaaaa-0000-0000-0000-000000000001', 'hello') returning id into nid;
  perform t.login('aaaaaaaa-0000-0000-0000-000000000001');
  update public.notifications set read_at = now() where id = nid;
  perform t.fails(format($q$update public.notifications set title = 'x' where id = %L$q$, nid), 'user can only change read_at on notifications');
  perform t.login('bbbbbbbb-0000-0000-0000-000000000002');
  perform t.count_is('select 1 from public.notifications', 0, 'other user cannot see notifications');

  perform t.superuser();
  insert into public.ai_analysis (asset_id, visibility, kind, result, provider, model, prompt_version, input_hash, data_as_of)
    values ('dddddddd-0000-0000-0000-000000000001', 'PUBLIC', 'asset', '{}', 'test', 'test', 'v0', 'h1', now());
  insert into public.ai_analysis (asset_id, user_id, visibility, kind, result, provider, model, prompt_version, input_hash, data_as_of)
    values ('dddddddd-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'PRIVATE', 'asset', '{}', 'test', 'test', 'v0', 'h2', now());
  perform t.fails($q$insert into public.ai_analysis (kind, result, provider, model, prompt_version, input_hash, data_as_of, visibility) values ('x','{}','t','t','v','h',now(),'PRIVATE')$q$, 'private analysis requires an owner');
  perform t.login('aaaaaaaa-0000-0000-0000-000000000001');
  perform t.count_is('select 1 from public.ai_analysis', 1, 'user sees PUBLIC analysis but not others'' PRIVATE analysis');
  perform t.fails($q$insert into public.ai_analysis (kind, result, provider, model, prompt_version, input_hash, data_as_of, visibility, user_id) values ('x','{}','t','t','v','h',now(),'PUBLIC','aaaaaaaa-0000-0000-0000-000000000001')$q$, 'users cannot write AI analysis');

  perform t.superuser();
  insert into public.audit_logs (actor_id, action) values (null, 'test.event');
  perform t.login('aaaaaaaa-0000-0000-0000-000000000001');
  perform t.count_is('select 1 from public.audit_logs', 0, 'non-admin cannot read audit logs');
  perform t.login('cccccccc-0000-0000-0000-000000000003');
  perform t.count_is('select 1 from public.audit_logs', 1, 'admin can read audit logs');
  perform t.fails($q$insert into public.audit_logs (action) values ('forged')$q$, 'admin cannot write audit logs via API');
  perform t.service();
  perform t.fails($q$delete from public.audit_logs$q$, 'audit logs are append-only even for service_role');

  perform t.login('aaaaaaaa-0000-0000-0000-000000000001');
  perform t.fails($q$insert into public.market_quotes (asset_id, price, source, as_of) values ('dddddddd-0000-0000-0000-000000000001', 1, 'x', now())$q$, 'users cannot write market quotes');
  perform t.fails($q$select public.check_rate_limit('k', 1, 60)$q$, 'users cannot call check_rate_limit');

  perform t.service();
  perform t.ok(public.check_rate_limit('test-key', 2, 3600), 'rate limit: call 1 allowed');
  perform t.ok(public.check_rate_limit('test-key', 2, 3600), 'rate limit: call 2 allowed');
  perform t.ok(not public.check_rate_limit('test-key', 2, 3600), 'rate limit: call 3 blocked');
  perform t.ok(public.check_rate_limit('other-key', 2, 3600), 'rate limit: keys are independent');
  perform t.superuser();
end $$;

-- ── 8. Phase 5A: engine-generated predictions ──
do $$
declare
  alice constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  bob   constant uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  btc   constant uuid := 'dddddddd-0000-0000-0000-000000000001';
  eid uuid; r public.predictions%rowtype; expected text; manual_id uuid; hash_before text;
  col text;
begin
  -- Privileges: API roles hold no INSERT on engine/server-owned columns and no UPDATE anywhere.
  foreach col in array array['entry_reference_price','engine_version','signal_agreement','signal_total',
      'entry_quote_source','entry_quote_as_of','entry_quote_fetched_at','entry_quote_is_mock',
      'engine_snapshot','hash_version','created_at','expires_at','content_hash'] loop
    perform t.ok(not has_column_privilege('authenticated', 'public.predictions', col, 'INSERT'), 'authenticated has no INSERT on ' || col);
    perform t.ok(not has_column_privilege('anon', 'public.predictions', col, 'INSERT'), 'anon has no INSERT on ' || col);
  end loop;
  foreach col in array array['target_price','invalidation_price','entry_reference_price','direction','engine_snapshot','created_at'] loop
    perform t.ok(not has_column_privilege('authenticated', 'public.predictions', col, 'UPDATE'), 'authenticated has no UPDATE on ' || col);
  end loop;

  -- A signed-in client cannot forge an engine prediction through the API.
  perform t.login(alice);
  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours, entry_reference_price)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24, 150)$q$,
    'client cannot supply entry_reference_price');
  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours, engine_version)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24, 'rules-1.0.0')$q$,
    'client cannot claim an engine version');
  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours, engine_snapshot)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24, '{}')$q$,
    'client cannot supply an engine snapshot');
  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours, entry_quote_source)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24, 'binance-public')$q$,
    'client cannot supply quote provenance');
  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours, hash_version)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24, 1)$q$,
    'client cannot choose the hash version');

  -- The server (service role) creates a complete engine prediction.
  perform t.service();
  insert into public.predictions (user_id, origin, asset_id, direction, target_price, invalidation_price, horizon_hours,
      timeframe, strategy_tag, rationale, entry_reference_price, engine_version, signal_agreement, signal_total,
      entry_quote_source, entry_quote_as_of, entry_quote_fetched_at, entry_quote_is_mock, engine_snapshot, created_at)
  values (alice, 'USER', btc, 'BULLISH', 215, 205, 24, '1h', 'trademonk-rules', '4 of 5 signals agree', 210.5,
      'rules-1.0.0', 4, 5, 'binance-public', now() - interval '5 seconds', now() - interval '4 seconds', false,
      '{"votes":{"bullish":4,"bearish":0,"total":5}}', '2020-01-01')
  returning id into eid;
  perform t.superuser();
  select * into r from public.predictions where id = eid;
  perform t.ok(r.created_at > now() - interval '1 minute', 'engine prediction: created_at is server-set (backdating ignored)');
  perform t.ok(r.expires_at = r.created_at + interval '24 hours', 'engine prediction: expires_at = server time + horizon');
  perform t.ok(r.hash_version = 2 and char_length(r.content_hash) = 64, 'engine prediction: hash recipe v2, sha256');
  perform t.ok(r.entry_reference_price = 210.5, 'engine prediction: entry price stored as written by the server');

  -- Independent recomputation of the documented v2 recipe (what an auditor would do).
  expected := encode(sha256(convert_to(concat_ws('|',
      r.id, r.user_id, r.origin, r.asset_id, r.direction, r.target_price::text, r.invalidation_price::text, r.horizon_hours::text,
      coalesce(r.rationale, ''), r.created_at::text, coalesce(r.timeframe, ''), coalesce(r.entry_reference_price::text, ''),
      coalesce(r.engine_version, ''), coalesce(r.signal_agreement::text, ''), coalesce(r.entry_quote_source, ''),
      coalesce(r.entry_quote_as_of::text, ''), coalesce(r.entry_quote_fetched_at::text, ''),
      coalesce(r.entry_quote_is_mock::text, ''), coalesce(r.engine_snapshot::text, '')), 'UTF8')), 'hex');
  perform t.ok(expected = r.content_hash, 'engine prediction: content_hash matches independent recomputation');
  perform t.ok(encode(sha256(convert_to(concat_ws('|',
      r.id, r.user_id, r.origin, r.asset_id, r.direction, r.target_price::text, r.invalidation_price::text, r.horizon_hours::text,
      coalesce(r.rationale, ''), r.created_at::text, coalesce(r.timeframe, ''), '999',
      coalesce(r.engine_version, ''), coalesce(r.signal_agreement::text, ''), coalesce(r.entry_quote_source, ''),
      coalesce(r.entry_quote_as_of::text, ''), coalesce(r.entry_quote_fetched_at::text, ''),
      coalesce(r.entry_quote_is_mock::text, ''), coalesce(r.engine_snapshot::text, '')), 'UTF8')), 'hex') <> r.content_hash,
    'engine prediction: a different entry price would change the hash');

  -- Completeness: no half-forged rows, even for the service role.
  perform t.service();
  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours, engine_version)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24, 'rules-1.0.0')$q$,
    'engine_version without the other engine fields is rejected');
  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours, entry_reference_price, entry_quote_source)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24, 150, 'binance-public')$q$,
    'engine fields without engine_version are rejected');
  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours, timeframe, entry_reference_price, engine_version, signal_agreement, signal_total, entry_quote_source, entry_quote_as_of, entry_quote_fetched_at, entry_quote_is_mock, engine_snapshot)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24, '1h', 150, 'v', 6, 5, 's', now(), now(), false, '{}')$q$,
    'signal_agreement above 5 is rejected');
  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours, timeframe, entry_reference_price, engine_version, signal_agreement, signal_total, entry_quote_source, entry_quote_as_of, entry_quote_fetched_at, entry_quote_is_mock, engine_snapshot)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24, '1h', 150, 'v', 4, 4, 's', now(), now(), false, '{}')$q$,
    'signal_total other than 5 is rejected');
  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours, timeframe, entry_reference_price, engine_version, signal_agreement, signal_total, entry_quote_source, entry_quote_as_of, entry_quote_fetched_at, entry_quote_is_mock, engine_snapshot)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 200, 100, 24, '1h', -1, 'v', 4, 5, 's', now(), now(), false, '{}')$q$,
    'non-positive entry price is rejected');
  perform t.fails($q$insert into public.predictions (user_id, asset_id, direction, target_price, invalidation_price, horizon_hours, timeframe, entry_reference_price, engine_version, signal_agreement, signal_total, entry_quote_source, entry_quote_as_of, entry_quote_fetched_at, entry_quote_is_mock, engine_snapshot)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'BULLISH', 100, 200, 24, '1h', 150, 'v', 4, 5, 's', now(), now(), false, '{}')$q$,
    'engine prediction still needs target/invalidation ordered for its direction');

  -- Visibility follows the existing RLS.
  perform t.login(alice);
  perform t.count_is(format('select 1 from public.predictions where id = %L and entry_reference_price = 210.5', eid), 1, 'owner sees own engine prediction with its entry price');
  perform t.login(bob);
  perform t.count_is(format('select 1 from public.predictions where id = %L', eid), 0, 'other user cannot see an engine prediction');

  -- Immutability for every role, on every new field.
  perform t.login(alice);
  perform t.fails(format('update public.predictions set entry_reference_price = 1 where id = %L', eid), 'owner cannot change the entry price');
  perform t.fails(format('update public.predictions set created_at = now() - interval ''1 year'' where id = %L', eid), 'owner cannot change created_at');
  perform t.fails(format('delete from public.predictions where id = %L', eid), 'owner cannot delete an engine prediction');
  perform t.service();
  perform t.fails(format('update public.predictions set entry_reference_price = 1 where id = %L', eid), 'service_role cannot change the entry price');
  perform t.fails(format('update public.predictions set engine_snapshot = ''{}'' where id = %L', eid), 'service_role cannot change the snapshot');
  perform t.fails(format('update public.predictions set entry_quote_as_of = now() where id = %L', eid), 'service_role cannot change quote provenance');
  perform t.fails(format('update public.predictions set content_hash = repeat(''0'', 64) where id = %L', eid), 'service_role cannot change the hash');
  perform t.fails(format('delete from public.predictions where id = %L', eid), 'service_role cannot delete an engine prediction');
  perform t.superuser();
  perform t.fails(format('update public.predictions set entry_reference_price = 1 where id = %L', eid), 'superuser cannot change the entry price (trigger)');
  perform t.fails(format('delete from public.predictions where id = %L', eid), 'superuser cannot delete an engine prediction (trigger)');

  -- Versioned corrections still work and leave the original snapshot untouched.
  select content_hash into hash_before from public.predictions where id = eid;
  perform t.login(alice);
  insert into public.prediction_updates (prediction_id, user_id, kind, note) values (eid, alice, 'NOTE', 'context added later');
  perform t.superuser();
  perform t.ok((select content_hash from public.predictions where id = eid) = hash_before, 'corrections do not alter the engine prediction hash');

  -- Manual client predictions remain valid, carry no engine fields and no entry price.
  select id into manual_id from public.predictions where user_id = alice and engine_version is null order by created_at limit 1;
  perform t.ok(manual_id is not null, 'manual predictions still exist');
  perform t.ok((select entry_reference_price is null and engine_snapshot is null and hash_version = 2 from public.predictions where id = manual_id),
    'manual prediction has no entry price or engine fields');
end $$;

-- ── 9. Phase 5B: prediction evaluator (results, eligibility, idempotency, RLS) ──
-- Runs as the invoker, so it inherits whichever role the test has switched to.
create function t.mk_engine(p_user uuid, p_origin public.prediction_origin, p_dir public.prediction_direction)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.predictions (user_id, origin, asset_id, direction, target_price, invalidation_price, horizon_hours,
      timeframe, strategy_tag, rationale, entry_reference_price, engine_version, signal_agreement, signal_total,
      entry_quote_source, entry_quote_as_of, entry_quote_fetched_at, entry_quote_is_mock, engine_snapshot)
  values (p_user, p_origin, 'dddddddd-0000-0000-0000-000000000001', p_dir,
      case when p_dir = 'BULLISH' then 110 else 90 end, case when p_dir = 'BULLISH' then 95 else 105 end, 24,
      '1h', 'trademonk-rules', 'fixture', 100, 'rules-1.0.0', 4, 5, 'binance-public', now(), now(), false, '{}')
  returning id into v_id;
  return v_id;
end $$;

do $$
declare
  alice constant uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  bob   constant uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  adm   constant uuid := 'cccccccc-0000-0000-0000-000000000003';
  meta  constant text := '{"rule":"TOUCH_WITHIN_HORIZON_V1","quote":{"source":"binance-public","isMock":false},"candles":{"count":22}}';
  p_due uuid; p_due2 uuid; p_active uuid; p_platform uuid; p_manual uuid; rid uuid;
  r public.prediction_results%rowtype; expected text; parent_hash text; n int; col text;
begin
  -- Privileges: API roles can read results but never write them, and cannot list due predictions.
  perform t.ok(has_table_privilege('authenticated', 'public.prediction_results', 'SELECT'), 'authenticated can SELECT results (RLS scopes rows)');
  perform t.ok(not has_table_privilege('anon', 'public.prediction_results', 'SELECT'), 'anon cannot SELECT results');
  foreach col in array array['INSERT','UPDATE','DELETE','TRUNCATE'] loop
    perform t.ok(not has_table_privilege('authenticated', 'public.prediction_results', col), 'authenticated has no ' || col || ' on results');
    perform t.ok(not has_table_privilege('anon', 'public.prediction_results', col), 'anon has no ' || col || ' on results');
  end loop;
  perform t.ok(not has_function_privilege('authenticated', 'public.predictions_due_for_evaluation(integer,integer)', 'EXECUTE'), 'authenticated cannot list due predictions');
  perform t.ok(not has_function_privilege('anon', 'public.predictions_due_for_evaluation(integer,integer)', 'EXECUTE'), 'anon cannot list due predictions');
  perform t.ok(has_function_privilege('service_role', 'public.predictions_due_for_evaluation(integer,integer)', 'EXECUTE'), 'service_role can list due predictions');

  -- Fixtures (server-created, like the engine does).
  perform t.service();
  p_active   := t.mk_engine(alice, 'USER', 'BULLISH');
  p_due      := t.mk_engine(alice, 'USER', 'BULLISH');
  p_due2     := t.mk_engine(alice, 'USER', 'BEARISH');
  p_platform := t.mk_engine(adm, 'PLATFORM', 'BULLISH');
  perform t.superuser();
  select id into p_manual from public.predictions where user_id = alice and engine_version is null order by created_at limit 1;

  -- Horizon not reached: no result may be written, by anyone.
  perform t.service();
  perform t.fails(format($q$insert into public.prediction_results (prediction_id, status, closed_at, exit_price, evaluation_meta)
    values (%L, 'WIN', now(), 111, %L::jsonb)$q$, p_active, meta), 'result for a prediction that has not expired is rejected');

  -- Time-travel the fixtures' expiry (test-only: replica mode skips the append-only triggers).
  perform t.superuser();
  execute 'set local session_replication_role = replica';
  update public.predictions set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
    where id in (p_due, p_due2, p_platform, p_manual);
  execute 'set local session_replication_role = origin';

  -- Discovery: engine + expired + no result. Not the active one, not the manual one.
  perform t.service();
  perform t.count_is('select 1 from public.predictions_due_for_evaluation()', 3, 'discovery: exactly the three expired engine predictions');
  perform t.ok(not exists (select 1 from public.predictions_due_for_evaluation() where id in (p_active, p_manual)), 'discovery: skips active and manual predictions');
  perform t.ok((select count(*) from public.predictions_due_for_evaluation(0)) = 1, 'discovery: p_limit below 1 is clamped to 1');
  perform t.ok((select count(*) from public.predictions_due_for_evaluation(1000)) = 3, 'discovery: a large p_limit is clamped, not an error');
  perform t.login(alice);
  perform t.fails('select * from public.predictions_due_for_evaluation()', 'user cannot call the discovery function');
  perform t.anon();
  perform t.fails('select * from public.predictions_due_for_evaluation()', 'anon cannot call the discovery function');

  -- Clients cannot write results, even for their own expired prediction.
  perform t.login(alice);
  perform t.fails(format($q$insert into public.prediction_results (prediction_id, status, closed_at, exit_price, evaluation_meta)
    values (%L, 'WIN', now(), 111, %L::jsonb)$q$, p_due, meta), 'owner cannot write a result');
  perform t.login(bob);
  perform t.fails(format($q$insert into public.prediction_results (prediction_id, status, closed_at, exit_price, evaluation_meta)
    values (%L, 'LOSS', now(), 90, %L::jsonb)$q$, p_due, meta), 'other user cannot write a result');

  -- Server-side completeness and eligibility rules.
  perform t.service();
  perform t.fails(format($q$insert into public.prediction_results (prediction_id, status, closed_at, evaluation_meta)
    values (%L, 'WIN', now(), %L::jsonb)$q$, p_due, meta), 'result without an evaluation price is rejected');
  perform t.fails(format($q$insert into public.prediction_results (prediction_id, status, closed_at, exit_price)
    values (%L, 'WIN', now(), 111)$q$, p_due), 'result without quote/candle provenance is rejected');
  perform t.fails(format($q$insert into public.prediction_results (prediction_id, status, closed_at, exit_price, evaluation_meta)
    values (%L, 'WIN', now(), 111, '{"quote":{"source":"x"}}'::jsonb)$q$, p_due), 'result without candle provenance is rejected');
  perform t.fails(format($q$insert into public.prediction_results (prediction_id, status, closed_at, exit_price, evaluation_meta)
    values (%L, 'OPEN', now(), 111, %L::jsonb)$q$, p_due, meta), 'OPEN is not a result');
  perform t.fails(format($q$insert into public.prediction_results (prediction_id, status, closed_at, exit_price, evaluation_meta)
    values (%L, 'WIN', now(), 111, %L::jsonb)$q$, p_manual, meta), 'manual predictions cannot be evaluated');
  perform t.fails(format($q$insert into public.prediction_results (prediction_id, status, closed_at, exit_price, evaluation_meta)
    values (gen_random_uuid(), 'WIN', now(), 111, %L::jsonb)$q$, meta), 'result for an unknown prediction is rejected');

  -- A valid evaluation. The caller tries to backdate it; the database ignores that.
  insert into public.prediction_results (prediction_id, status, closed_at, created_at, exit_price, return_pct, evaluation_meta, content_hash)
    values (p_due, 'WIN', '2001-01-01', '2001-01-01', 111.5, null, meta::jsonb, 'forged')
    returning id into rid;
  perform t.superuser();
  select * into r from public.prediction_results where id = rid;
  select content_hash into parent_hash from public.predictions where id = p_due;
  perform t.ok(r.closed_at > now() - interval '1 minute', 'result: closed_at (evaluation time) is server-set, backdating ignored');
  perform t.ok(r.created_at > now() - interval '1 minute', 'result: created_at is server-set');
  perform t.ok(r.closed_at >= (select expires_at from public.predictions where id = p_due), 'result: evaluation time is not before the horizon');
  perform t.ok(r.exit_price = 111.5 and r.status = 'WIN', 'result: evaluation price and status stored as written by the server');
  perform t.ok(r.content_hash <> 'forged' and char_length(r.content_hash) = 64, 'result: content_hash is computed by the database (sha256)');
  expected := encode(sha256(convert_to(concat_ws('|', r.id, r.prediction_id, parent_hash, r.status,
      r.closed_at::text, r.exit_price::text, coalesce(r.return_pct::text, ''), r.evaluation_meta::text), 'UTF8')), 'hex');
  perform t.ok(expected = r.content_hash, 'result: content_hash matches independent recomputation and chains to the prediction hash');

  -- Idempotency at the database: one result per prediction, and the error is a unique violation.
  perform t.service();
  begin
    insert into public.prediction_results (prediction_id, status, closed_at, exit_price, evaluation_meta)
      values (p_due, 'INVALIDATED', now(), 94, meta::jsonb);
    raise exception 'FAIL: a second result for the same prediction was accepted';
  exception when unique_violation then
    raise notice 'PASS: second result for the same prediction is a unique violation (evaluator treats it as already evaluated)';
  end;
  perform t.ok((select count(*) from public.prediction_results where prediction_id = p_due) = 1, 'exactly one result per prediction');

  -- Immutability for every role.
  perform t.fails(format('update public.prediction_results set status = ''INVALIDATED'' where id = %L', rid), 'service_role cannot change the result status');
  perform t.fails(format('update public.prediction_results set exit_price = 1 where id = %L', rid), 'service_role cannot change the evaluation price');
  perform t.fails(format('update public.prediction_results set closed_at = now() - interval ''1 year'' where id = %L', rid), 'service_role cannot change the evaluation timestamp');
  perform t.fails(format('update public.prediction_results set evaluation_meta = ''{}'' where id = %L', rid), 'service_role cannot change the evaluation provenance');
  perform t.fails(format('update public.prediction_results set content_hash = repeat(''0'', 64) where id = %L', rid), 'service_role cannot change the result hash');
  perform t.fails(format('delete from public.prediction_results where id = %L', rid), 'service_role cannot delete a result');
  perform t.fails('truncate public.prediction_results', 'service_role cannot truncate results');
  perform t.login(alice);
  perform t.fails(format('update public.prediction_results set status = ''LOSS'' where id = %L', rid), 'owner cannot change a result');
  perform t.fails(format('delete from public.prediction_results where id = %L', rid), 'owner cannot delete a result');
  perform t.superuser();
  perform t.fails(format('update public.prediction_results set exit_price = 1 where id = %L', rid), 'superuser cannot change the evaluation price (trigger)');
  perform t.fails(format('delete from public.prediction_results where id = %L', rid), 'superuser cannot delete a result (trigger)');

  -- The evaluated prediction is closed for corrections and no longer due.
  perform t.login(alice);
  perform t.fails(format($q$insert into public.prediction_updates (prediction_id, user_id, kind, note) values (%L, %L, 'NOTE', 'late')$q$, p_due, alice), 'evaluated prediction cannot receive updates');
  perform t.service();
  perform t.count_is('select 1 from public.predictions_due_for_evaluation()', 2, 'discovery: an evaluated prediction is no longer due');

  -- RLS: results follow the visibility of their prediction.
  perform t.login(alice);
  perform t.count_is(format('select 1 from public.prediction_results where id = %L', rid), 1, 'owner sees own result');
  perform t.login(bob);
  perform t.count_is(format('select 1 from public.prediction_results where id = %L', rid), 0, 'other user cannot see a private result');
  perform t.login(adm);
  perform t.count_is(format('select 1 from public.prediction_results where id = %L', rid), 1, 'admin sees the result');
  perform t.anon();
  perform t.fails('select 1 from public.prediction_results', 'anon cannot read results');

  perform t.service();
  insert into public.prediction_results (prediction_id, status, closed_at, exit_price, evaluation_meta)
    values (p_platform, 'EXPIRED', now(), 100.2, meta::jsonb);
  perform t.login(bob);
  perform t.count_is(format('select 1 from public.prediction_results where prediction_id = %L', p_platform), 1, 'any signed-in user sees a PLATFORM prediction result');

  -- Deferral cooldown: a recent deferral hides a prediction for a while; an old one does not.
  perform t.service();
  insert into public.audit_logs (action, entity_type, entity_id, metadata, created_at)
    values ('prediction.evaluation_deferred', 'prediction', p_due2::text, '{}', now() - interval '1 hour');
  perform t.count_is('select 1 from public.predictions_due_for_evaluation()', 1, 'discovery: an old deferral does not hide the prediction');
  insert into public.audit_logs (action, entity_type, entity_id, metadata)
    values ('prediction.evaluation_deferred', 'prediction', p_due2::text, '{}');
  perform t.count_is('select 1 from public.predictions_due_for_evaluation()', 0, 'discovery: a recent deferral pauses retries');
  perform t.count_is('select 1 from public.predictions_due_for_evaluation(25, 0)', 1, 'discovery: retry window of 0 seconds disables the pause');
  perform t.superuser();
end $$;

-- ── 9. Phase 5C-1: paper-trading privilege model (PAPER TRADING, NO REAL MONEY) ──
-- Behavioural proof that users cannot create trades, change entry prices or touch other users' rows.
do $$
declare
  alice uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  bob   uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  adm   uuid := 'cccccccc-0000-0000-0000-000000000003';
  asset uuid := 'dddddddd-0000-0000-0000-000000000001';
  open_id uuid; closed_id uuid; n int;
begin
  perform t.superuser();
  delete from public.paper_trades;   -- start from a known state: only this block's fixtures
  insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity)
    values (alice, asset, 'BUY', 100, 1) returning id into open_id;
  insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity, status)
    values (alice, asset, 'SHORT', 50, 2, 'CLOSED') returning id into closed_id;
  insert into public.paper_trade_results (paper_trade_id, user_id, exit_price, fees, pnl)
    values (closed_id, alice, 45, 0, 10);

  -- anonymous callers: no access of any kind
  perform t.anon();
  perform t.fails('select 1 from public.paper_trades', 'paper: anon cannot read trades');
  perform t.fails('select 1 from public.paper_trade_results', 'paper: anon cannot read results');
  perform t.fails(format('insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity) values (%L, %L, ''BUY'', 1, 1)', alice, asset), 'paper: anon cannot insert a trade');

  -- the owner: reads own rows, cannot create or rewrite anything beyond SL/TP on an OPEN trade
  perform t.login(alice);
  perform t.count_is('select 1 from public.paper_trades', 2, 'paper: owner sees exactly own trades');
  perform t.count_is('select 1 from public.paper_trade_results', 1, 'paper: owner sees own result');
  perform t.fails(format('insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity) values (%L, %L, ''BUY'', 1, 1)', alice, asset), 'paper: owner cannot insert a trade for self');
  perform t.fails(format('insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity) values (%L, %L, ''BUY'', 1, 1)', bob, asset), 'paper: owner cannot insert a trade for another user');
  perform t.fails(format('insert into public.paper_trade_results (paper_trade_id, user_id, exit_price, pnl) values (%L, %L, 1, 1)', open_id, alice), 'paper: owner cannot fabricate a result');
  perform t.fails(format('update public.paper_trades set entry_price = 1 where id = %L', open_id), 'paper: entry_price is not user-writable');
  perform t.fails(format('update public.paper_trades set quantity = 999 where id = %L', open_id), 'paper: quantity is not user-writable');
  perform t.fails(format('update public.paper_trades set side = ''SELL'' where id = %L', open_id), 'paper: side is not user-writable');
  perform t.fails(format('update public.paper_trades set fees = 0 where id = %L', open_id), 'paper: fees are not user-writable');
  perform t.fails(format('update public.paper_trades set status = ''CLOSED'' where id = %L', open_id), 'paper: status is not user-writable (no self-close)');
  perform t.fails(format('update public.paper_trades set opened_at = now() - interval ''1 day'' where id = %L', open_id), 'paper: opened_at is not user-writable');
  perform t.fails(format('update public.paper_trades set asset_id = %L where id = %L', asset, open_id), 'paper: asset_id is not user-writable');
  perform t.fails(format('update public.paper_trades set user_id = %L where id = %L', bob, open_id), 'paper: a trade cannot be handed to another user');
  perform t.fails(format('delete from public.paper_trades where id = %L', open_id), 'paper: owner cannot delete a trade');
  perform t.fails('truncate public.paper_trades', 'paper: owner cannot truncate trades');
  perform t.fails('delete from public.paper_trade_results', 'paper: owner cannot delete results');
  perform t.fails('update public.paper_trade_results set pnl = 1000000', 'paper: owner cannot edit results');
  update public.paper_trades set stop_loss = 90, take_profit = 120 where id = open_id;
  get diagnostics n = row_count;
  perform t.ok(n = 1, 'paper: owner may set SL/TP on an OPEN trade');
  update public.paper_trades set stop_loss = 1 where id = closed_id;
  get diagnostics n = row_count;
  perform t.ok(n = 0, 'paper: owner cannot change SL/TP on a CLOSED trade');

  -- another user: total isolation
  perform t.login(bob);
  perform t.count_is('select 1 from public.paper_trades', 0, 'paper: other user sees no trades');
  perform t.count_is('select 1 from public.paper_trade_results', 0, 'paper: other user sees no results');
  update public.paper_trades set stop_loss = 1 where id = open_id;
  get diagnostics n = row_count;
  perform t.ok(n = 0, 'paper: other user cannot update someone else''s trade');
  perform t.fails(format('delete from public.paper_trades where id = %L', open_id), 'paper: other user cannot delete someone else''s trade');
  perform t.fails(format('insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity) values (%L, %L, ''BUY'', 1, 1)', alice, asset), 'paper: other user cannot insert a trade as the owner');

  -- admins have no read path into users' paper trades either (owner-only policies)
  perform t.login(adm);
  perform t.count_is('select 1 from public.paper_trades', 0, 'paper: admin role grants no read of trades');
  perform t.count_is('select 1 from public.paper_trade_results', 0, 'paper: admin role grants no read of results');

  -- the owner's data is intact after all of the above
  perform t.superuser();
  perform t.ok((select entry_price from public.paper_trades where id = open_id) = 100, 'paper: entry price unchanged after all attempts');
  perform t.ok((select count(*) from public.paper_trades) = 2 and (select count(*) from public.paper_trade_results) = 1, 'paper: no rows created or removed by the attempts');
  perform t.ok((select stop_loss from public.paper_trades where id = closed_id) is null, 'paper: closed trade untouched');
end $$;

-- ── 10. Phase 5C-2: opening a paper trade (PAPER TRADING, NO REAL MONEY) ──
-- Helpers: a fails() that also checks WHICH error was raised, and a valid-call builder that does
-- exactly what the server does (adverse slippage on the reference price, fee on the notional).
create function t.fails_with(q text, needle text, label text) returns void language plpgsql as $$
begin
  begin
    execute q;
  exception when others then
    if sqlerrm like '%' || needle || '%' then
      raise notice 'PASS: % [%]', label, sqlerrm;
      return;
    end if;
    raise exception 'FAIL (wrong error for %): expected "%", got "%"', label, needle, sqlerrm;
  end;
  raise exception 'FAIL (statement succeeded but should have failed): %', label;
end $$;

create function t.open(
  uid uuid, asset uuid, qty numeric, ref numeric,
  cash numeric default 10000, slip numeric default 5, feebps numeric default 10,
  qsource text default 'binance-public', side text default 'BUY'
) returns jsonb language plpgsql as $$
declare
  entry numeric := round(ref * (10000 + slip) / 10000, 8);
  notional numeric := round(entry * qty, 8);
  fee numeric := round(notional * feebps / 10000, 8);
begin
  return public.open_paper_trade(uid, asset, side, qty, entry, fee, cash, 'PAPER_SIM_V1', ref, slip, feebps,
    qsource, now(), now(), false);
end $$;

do $$
declare
  alice uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  bob   uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  adm   uuid := 'cccccccc-0000-0000-0000-000000000003';
  btc   uuid := 'dddddddd-0000-0000-0000-000000000001';
  rel   uuid := 'dddddddd-0000-0000-0000-000000000002';
  dead  uuid := 'dddddddd-0000-0000-0000-000000000009';
  res jsonb; tr jsonb; n int; bal numeric; tid uuid;
begin
  perform t.superuser();
  delete from public.paper_trades;
  delete from public.paper_accounts;
  insert into public.assets (id, market, symbol, name, asset_type, currency) values
    (rel, 'NSE', 'RELIANCE', 'Reliance Industries', 'EQUITY', 'INR');
  insert into public.assets (id, market, symbol, name, asset_type, currency, is_active) values
    (dead, 'CRYPTO', 'DEAD', 'Delisted', 'CRYPTO', 'USDT', false);

  -- ── API roles cannot call the function at all ──
  perform t.anon();
  perform t.fails(format('select t.open(%L, %L, 2, 100)', alice, btc), 'open: anon cannot execute open_paper_trade');
  perform t.login(alice);
  perform t.fails(format('select t.open(%L, %L, 2, 100)', alice, btc), 'open: authenticated cannot execute open_paper_trade for self');
  perform t.fails(format('select t.open(%L, %L, 2, 100)', bob, btc), 'open: authenticated cannot execute open_paper_trade for another user');
  perform t.login(adm);
  perform t.fails(format('select t.open(%L, %L, 2, 100)', adm, btc), 'open: an admin-role user cannot execute it either');
  perform t.superuser();
  perform t.ok((select count(*) from public.paper_trades) = 0 and (select count(*) from public.paper_accounts) = 0,
    'open: refused calls created no account and no trade');

  -- ── A valid open, as the server (service_role) ──
  perform t.service();
  res := t.open(alice, btc, 2, 100);
  tr := res -> 'trade';
  perform t.ok((tr ->> 'entry_price')::numeric = 100.05, 'open: entry price is the slipped reference price');
  perform t.ok((tr ->> 'reference_price')::numeric = 100 and (tr ->> 'slippage_bps')::numeric = 5 and (tr ->> 'fee_bps')::numeric = 10,
    'open: reference price and the applied slippage/fee rates are recorded');
  perform t.ok((tr ->> 'notional')::numeric = 200.1 and (tr ->> 'fees')::numeric = 0.2001 and (tr ->> 'cash_debited')::numeric = 200.3001,
    'open: notional, fee and cash debited are exact');
  perform t.ok(tr ->> 'status' = 'OPEN' and tr ->> 'side' = 'BUY' and (tr ->> 'quantity')::numeric = 2, 'open: trade is OPEN with the requested side and quantity');
  perform t.ok(tr ->> 'sim_version' = 'PAPER_SIM_V1' and tr ->> 'quote_source' = 'binance-public' and (tr ->> 'quote_is_mock')::boolean = false,
    'open: simulation version and quote provenance are recorded');
  perform t.ok((res ->> 'cash_balance_after')::numeric = 9799.6999 and res ->> 'currency' = 'USDT', 'open: returns the new balance and currency');
  perform t.ok((tr ->> 'user_id')::uuid = alice, 'open: the trade belongs to the user the server named');
  perform t.superuser();
  perform t.ok((select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = 9799.6999,
    'open: cash was debited by exactly notional + fee');
  perform t.ok((select starting_cash from public.paper_accounts where user_id = alice and currency = 'USDT') = 10000,
    'open: the account was created lazily with the server-supplied starting cash');
  perform t.ok((select opened_at from public.paper_trades where id = (tr ->> 'id')::uuid) = now(), 'open: opened_at is stamped by the database');

  -- the accounting invariant: starting cash minus cash debited by open trades = balance
  perform t.ok((select a.starting_cash - coalesce(sum(p.cash_debited), 0) from public.paper_accounts a
      left join public.paper_trades p on p.account_id = a.id and p.status = 'OPEN'
      where a.user_id = alice and a.currency = 'USDT' group by a.starting_cash) = (select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT'),
    'open: invariant: starting cash - sum(cash debited) = balance');

  -- second open draws on the reduced balance; same account (no duplicate)
  perform t.service();
  res := t.open(alice, btc, 1, 100);
  perform t.ok((res ->> 'cash_balance_after')::numeric = 9799.6999 - 100.15005, 'open: a second trade debits the already-reduced balance');
  perform t.superuser();
  perform t.count_is(format('select 1 from public.paper_accounts where user_id = %L', alice), 1, 'open: still exactly one account per user and currency');

  -- a different currency gets its own account; the USDT account is untouched
  perform t.service();
  res := t.open(alice, rel, 3, 2500.5, cash := 1000000, feebps := 5);
  perform t.ok(res ->> 'currency' = 'INR' and (res -> 'trade' ->> 'entry_price')::numeric = 2501.75025
    and (res -> 'trade' ->> 'fees')::numeric = 3.75262538, 'open: INR equity uses its own account, half-up rounding matches');
  perform t.superuser();
  perform t.count_is(format('select 1 from public.paper_accounts where user_id = %L', alice), 2, 'open: one account per currency');
  perform t.ok((select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = 9799.6999 - 100.15005,
    'open: the USDT balance is unaffected by an INR trade');

  -- ── Insufficient cash ──
  perform t.service();
  select cash_balance into bal from public.paper_accounts where user_id = alice and currency = 'USDT';
  perform t.fails_with(format('select t.open(%L, %L, 1000, 100)', alice, btc), 'PAPER_INSUFFICIENT_CASH', 'cash: unaffordable trade is rejected');
  perform t.ok((select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = bal, 'cash: a rejected trade leaves the balance unchanged');
  perform t.ok((select count(*) from public.paper_trades where user_id = alice) = 3, 'cash: a rejected trade creates no row');
  -- a brand-new user whose FIRST trade is rejected must not be left with a half-created account
  perform t.fails_with(format('select t.open(%L, %L, 1000, 100)', bob, btc), 'PAPER_INSUFFICIENT_CASH', 'cash: first-ever trade can be rejected too');
  perform t.ok((select count(*) from public.paper_accounts where user_id = bob) = 0, 'cash: the rejected first trade did not leave an account behind');
  -- the fee counts: notional fits in the balance but notional + fee does not
  perform t.fails_with(format('select t.open(%L, %L, 99.995, 100, cash := 10000, slip := 0)', bob, btc), 'PAPER_INSUFFICIENT_CASH', 'cash: notional fits but notional + fee does not');
  -- exactly the balance is allowed; one unit more is not
  res := t.open(bob, btc, 2, 100, cash := 200.3001);
  perform t.ok((res ->> 'cash_balance_after')::numeric = 0, 'cash: spending exactly the balance succeeds and leaves zero');
  perform t.fails_with(format('select t.open(%L, %L, 0.00000001, 100, cash := 200.3001)', bob, btc), 'PAPER_INSUFFICIENT_CASH', 'cash: nothing more can be spent at zero');
  -- the starting cash of an EXISTING account cannot be raised by passing a bigger one
  perform t.fails_with(format('select t.open(%L, %L, 1000, 100, cash := 1000000000)', alice, btc), 'PAPER_INSUFFICIENT_CASH', 'cash: a larger p_starting_cash does not top up an existing account');
  perform t.superuser();
  perform t.ok((select starting_cash from public.paper_accounts where user_id = alice and currency = 'USDT') = 10000, 'cash: starting cash of an existing account is unchanged');

  -- ── The function does not trust the caller's arithmetic or inputs ──
  perform t.service();
  select cash_balance into bal from public.paper_accounts where user_id = alice and currency = 'USDT';
  perform t.fails_with(format($q$select public.open_paper_trade(%L, %L, 'BUY', 2, 1, 0.0002, 10000, 'PAPER_SIM_V1', 100, 5, 10, 's', now(), now(), false)$q$, alice, btc), 'entry price does not match', 'input: a cheaper-than-derived entry price is refused');
  perform t.fails_with(format($q$select public.open_paper_trade(%L, %L, 'BUY', 2, 100.05, 0, 10000, 'PAPER_SIM_V1', 100, 5, 10, 's', now(), now(), false)$q$, alice, btc), 'fee does not match', 'input: a zero fee is refused when the rate says otherwise');
  perform t.fails_with(format($q$select public.open_paper_trade(%L, %L, 'BUY', 2, 100, 0.3, 10000, 'PAPER_SIM_V1', 100, 0, 10, 's', now(), now(), false)$q$, alice, btc), 'fee does not match', 'input: a wrong fee for a zero-slippage fill is refused');
  perform t.fails_with(format('select t.open(%L, %L, 2, 100, side := %L)', alice, btc, 'SELL'), 'side SELL is not supported', 'input: SELL is refused');
  perform t.fails_with(format('select t.open(%L, %L, 2, 100, side := %L)', alice, btc, 'SHORT'), 'side SHORT is not supported', 'input: SHORT is refused');
  perform t.fails_with(format('select t.open(%L, %L, 0, 100)', alice, btc), 'PAPER_INVALID_INPUT', 'input: zero quantity is refused');
  perform t.fails_with(format('select t.open(%L, %L, -1, 100)', alice, btc), 'PAPER_INVALID_INPUT', 'input: negative quantity is refused');
  perform t.fails_with(format('select t.open(%L, %L, %L::numeric, 100)', alice, btc, 'NaN'), 'PAPER_INVALID_INPUT', 'input: NaN quantity is refused');
  perform t.fails_with(format('select t.open(%L, %L, %L::numeric, 100)', alice, btc, 'Infinity'), 'PAPER_INVALID_INPUT', 'input: Infinity quantity is refused');
  perform t.fails_with(format('select t.open(%L, %L, 1, %L::numeric)', alice, btc, 'NaN'), 'PAPER_INVALID_INPUT', 'input: NaN reference price is refused');
  perform t.fails_with(format('select t.open(%L, %L, 1, 100, cash := %L::numeric)', alice, btc, 'Infinity'), 'PAPER_INVALID_INPUT', 'input: Infinity starting cash is refused');
  perform t.fails_with(format('select t.open(%L, %L, 1, 100, slip := -5)', alice, btc), 'PAPER_INVALID_INPUT', 'input: negative slippage (a favourable fill) is refused');
  perform t.fails_with(format('select t.open(%L, %L, 1, 100, feebps := -1)', alice, btc), 'PAPER_INVALID_INPUT', 'input: a negative fee rate is refused');
  perform t.fails_with(format('select t.open(%L, %L, 2, 100)', alice, dead), 'PAPER_ASSET_NOT_FOUND', 'input: an inactive asset is refused');
  perform t.fails_with(format('select t.open(%L, %L, 2, 100)', alice, 'eeeeeeee-0000-0000-0000-000000000099'), 'PAPER_ASSET_NOT_FOUND', 'input: an unknown asset is refused');
  perform t.fails_with(format('select t.open(%L, %L, 2, 100)', 'ffffffff-0000-0000-0000-000000000099', btc), 'unknown user', 'input: an unknown user is refused');
  perform t.fails(format($q$select public.open_paper_trade(null, %L, 'BUY', 2, 100.05, 0.2001, 10000, 'PAPER_SIM_V1', 100, 5, 10, 's', now(), now(), false)$q$, btc), 'input: a null user is refused');
  perform t.fails(format($q$select public.open_paper_trade(%L, %L, 'BUY', null, 100.05, 0.2001, 10000, 'PAPER_SIM_V1', 100, 5, 10, 's', now(), now(), false)$q$, alice, btc), 'input: a null quantity is refused');
  perform t.superuser();
  perform t.ok((select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = bal, 'input: no refused call changed the balance');
  perform t.ok((select count(*) from public.paper_trades where user_id = alice) = 3, 'input: no refused call created a trade');

  -- ── Atomicity: a failure at the very last step (the trade insert) undoes the debit ──
  perform t.service();
  perform t.fails(format('select t.open(%L, %L, 2, 100, qsource := null)', alice, btc), 'atomic: a failing trade insert aborts the whole open');
  perform t.superuser();
  perform t.ok((select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = bal, 'atomic: the debit did not survive the failed insert');
  perform t.ok((select count(*) from public.paper_trades where user_id = alice) = 3, 'atomic: and no trade was created');
  perform t.ok((select sum(cash_debited) from public.paper_trades where account_id = (select id from public.paper_accounts where user_id = alice and currency = 'USDT'))
      = (select starting_cash - cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT'),
    'atomic: cash debited across trades always equals the drop in balance');

  -- ── RLS: users see only their own accounts and trades, and can write neither ──
  perform t.anon();
  perform t.fails('select 1 from public.paper_accounts', 'rls: anon cannot read accounts');
  perform t.login(alice);
  perform t.count_is('select 1 from public.paper_accounts', 2, 'rls: alice sees exactly her two accounts');
  perform t.count_is(format('select 1 from public.paper_accounts where user_id = %L', bob), 0, 'rls: alice cannot see bob''s account');
  perform t.count_is('select 1 from public.paper_trades', 3, 'rls: alice sees exactly her three trades');
  perform t.ok((select cash_balance from public.paper_accounts where currency = 'USDT') = bal, 'rls: alice reads her own balance');
  perform t.fails('update public.paper_accounts set cash_balance = 1000000000', 'rls: owner cannot set cash');
  perform t.fails('update public.paper_accounts set starting_cash = 1000000000', 'rls: owner cannot change starting cash');
  perform t.fails(format('update public.paper_accounts set user_id = %L', bob), 'rls: owner cannot hand an account to another user');
  perform t.fails(format($q$insert into public.paper_accounts (user_id, currency, starting_cash, cash_balance) values (%L, 'INR', 1e12, 1e12)$q$, alice), 'rls: owner cannot create an account (create money)');
  perform t.fails('delete from public.paper_accounts', 'rls: owner cannot delete an account');
  perform t.fails('truncate public.paper_accounts', 'rls: owner cannot truncate accounts');
  perform t.fails('update public.paper_trades set cash_debited = 0', 'rls: owner cannot edit cash debited');
  perform t.fails('update public.paper_trades set reference_price = 1', 'rls: owner cannot edit the reference price');
  perform t.fails('update public.paper_trades set quote_source = ''x''', 'rls: owner cannot edit quote provenance');
  perform t.login(bob);
  perform t.count_is('select 1 from public.paper_accounts', 1, 'rls: bob sees only his own account');
  perform t.count_is(format('select 1 from public.paper_accounts where user_id = %L', alice), 0, 'rls: bob cannot see alice''s accounts');
  perform t.count_is('select 1 from public.paper_trades', 1, 'rls: bob sees only his own trade');
  perform t.fails(format($q$insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity) values (%L, %L, 'BUY', 1, 1)$q$, alice, btc), 'rls: bob cannot create a trade for alice');
  perform t.login(adm);
  perform t.count_is('select 1 from public.paper_accounts', 0, 'rls: an admin-role user has no read path into paper accounts');

  -- ── Server-owned and immutable, even for the service role ──
  perform t.service();
  select id into tid from public.paper_trades where user_id = alice order by created_at limit 1;
  perform t.fails(format('update public.paper_trades set entry_price = 1 where id = %L', tid), 'immutable: service cannot rewrite the entry price');
  perform t.fails(format('update public.paper_trades set quantity = 1 where id = %L', tid), 'immutable: service cannot rewrite the quantity');
  perform t.fails(format('update public.paper_trades set opened_at = now() - interval ''2 days'' where id = %L', tid), 'immutable: service cannot backdate opened_at');
  perform t.fails(format('update public.paper_trades set cash_debited = 1 where id = %L', tid), 'immutable: service cannot rewrite cash debited');
  perform t.fails(format('update public.paper_trades set user_id = %L where id = %L', bob, tid), 'immutable: service cannot move a trade to another user');
  perform t.fails(format('update public.paper_trades set quote_as_of = now() - interval ''1 hour'' where id = %L', tid), 'immutable: service cannot rewrite the quote timestamp');
  perform t.fails(format('update public.paper_accounts set starting_cash = 1 where user_id = %L', alice), 'immutable: service cannot rewrite starting cash');
  perform t.fails(format('update public.paper_accounts set currency = ''INR'' where user_id = %L and currency = ''USDT''', alice), 'immutable: service cannot change an account''s currency');
  perform t.fails(format('update public.paper_accounts set cash_balance = -1 where user_id = %L and currency = ''USDT''', alice), 'immutable: cash can never go negative');
  perform t.fails(format('update public.paper_accounts set cash_balance = %L::numeric where user_id = %L and currency = ''USDT''', 'NaN', alice), 'immutable: cash can never be NaN');
  perform t.fails(format('update public.paper_accounts set cash_balance = %L::numeric where user_id = %L and currency = ''USDT''', 'Infinity', alice), 'immutable: cash can never be infinite');
  -- the ONLY things that may change on a trade: status and SL/TP
  update public.paper_trades set stop_loss = 90 where id = tid;
  perform t.ok((select stop_loss from public.paper_trades where id = tid) = 90, 'immutable: stop loss remains settable');
  -- a direct insert cannot backdate either (the trigger overrides the supplied timestamp)
  perform t.superuser();
  insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity, opened_at, created_at)
    values (alice, btc, 'BUY', 1, 1, now() - interval '30 days', now() - interval '30 days') returning id into tid;
  perform t.ok((select opened_at = now() and created_at = now() from public.paper_trades where id = tid), 'immutable: opened_at/created_at are overwritten on insert');
  delete from public.paper_trades where id = tid;

  -- ── Execution fields are complete-or-absent and consistent ──
  perform t.fails(format($q$insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity, sim_version) values (%L, %L, 'BUY', 1, 1, 'PAPER_SIM_V1')$q$, alice, btc), 'constraint: a simulated trade missing its execution fields is refused');
  perform t.fails(format($q$insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity, reference_price) values (%L, %L, 'BUY', 1, 1, 1)$q$, alice, btc), 'constraint: execution fields without a simulation version are refused');
  perform t.fails(format($q$insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity, fees, account_id, sim_version, reference_price, slippage_bps, fee_bps, notional, cash_debited, quote_source, quote_as_of, quote_fetched_at, quote_is_mock)
    values (%L, %L, 'BUY', 1, 1, 0.1, (select id from public.paper_accounts where user_id = %L and currency = 'USDT'), 'V', 1, 0, 0, 1, 5, 's', now(), now(), false)$q$, alice, btc, alice), 'constraint: cash debited must equal notional + fees');

  -- ── Nothing in 5C-2 closes trades or records results ──
  perform t.ok((select count(*) from public.paper_trade_results) = 0, 'scope: opening trades never writes a result (no closing, no P&L)');
  perform t.ok((select count(*) from public.paper_trades where status = 'CLOSED') = 0, 'scope: opening trades never closes one');
end $$;


-- ── 11. Phase 5C-3: closing a paper trade (PAPER TRADING, NO REAL MONEY) ──
-- t.close_call(): a raw call with explicit figures and NO table reads, so privilege tests fail for the
--   right reason (EXECUTE denied), not because the helper could not read a table.
-- t.close(): does exactly what the server does (adverse slippage LOWERS the sell price; fee on gross
--   proceeds; P&L = proceeds - fee - recorded cash debited). Run it only as service_role/superuser.
create function t.close_call(
  uid uuid, tid uuid, exit_p numeric, fee numeric, pnl numeric,
  ref numeric default 110, slip numeric default 5, feebps numeric default 10,
  qsource text default 'binance-public'
) returns jsonb language plpgsql as $$
begin
  return public.close_paper_trade(uid, tid, exit_p, fee, pnl, 'PAPER_SIM_V1', ref, slip, feebps,
    qsource, now(), now(), false);
end $$;

create function t.close(uid uuid, tid uuid, ref numeric, slip numeric default 5, feebps numeric default 10)
returns jsonb language plpgsql as $$
declare
  tr public.paper_trades%rowtype;
  exit_p numeric := round(ref * (10000 - slip) / 10000, 8);
  gross numeric; fee numeric; pnl numeric;
begin
  select * into tr from public.paper_trades where id = tid;
  gross := round(exit_p * tr.quantity, 8);
  fee := round(gross * feebps / 10000, 8);
  pnl := gross - fee - tr.cash_debited;
  return t.close_call(uid, tid, exit_p, fee, pnl, ref, slip, feebps);
end $$;

create function t.boom() returns trigger language plpgsql as $$
begin raise exception 'BOOM: injected failure'; end $$;

do $$
declare
  alice uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  bob   uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  adm   uuid := 'cccccccc-0000-0000-0000-000000000003';
  btc   uuid := 'dddddddd-0000-0000-0000-000000000001';
  rel   uuid := 'dddddddd-0000-0000-0000-000000000002';
  ghost uuid := 'eeeeeeee-0000-0000-0000-00000000000f';
  r jsonb; tid1 uuid; tid2 uuid; tid3 uuid; bobtid uuid; relid uuid; legacy uuid; short_id uuid;
  bal numeric; usdt_bal numeric; n int; acct uuid; rs public.paper_trade_results%rowtype; tr public.paper_trades%rowtype;
begin
  perform t.superuser();
  delete from public.paper_trades;      -- cascades results; known state for this block
  delete from public.paper_accounts;

  -- ── Fixtures, opened through the REAL open function as the server ──
  perform t.service();
  tid1   := (t.open(alice, btc, 2, 100) -> 'trade' ->> 'id')::uuid;   -- cost 200.3001
  tid2   := (t.open(alice, btc, 1, 100) -> 'trade' ->> 'id')::uuid;   -- cost 100.15005
  tid3   := (t.open(alice, btc, 1, 100) -> 'trade' ->> 'id')::uuid;   -- cost 100.15005
  bobtid := (t.open(bob,   btc, 2, 100) -> 'trade' ->> 'id')::uuid;
  perform t.superuser();
  perform t.ok((select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = 9599.3998, 'close: fixture balance after three opens');
  perform t.ok((select count(*) from public.paper_trade_results) = 0, 'close: no result exists before any close (nothing is fabricated)');

  -- ── API roles cannot call the function at all (EXECUTE revoked) ──
  perform t.anon();
  perform t.fails_with(format('select t.close_call(%L, %L, 109.945, 0.21989, 19.37001)', alice, tid1), 'permission denied', 'close: anon cannot execute close_paper_trade');
  perform t.login(alice);
  perform t.fails_with(format('select t.close_call(%L, %L, 109.945, 0.21989, 19.37001)', alice, tid1), 'permission denied', 'close: authenticated owner cannot execute close_paper_trade for self');
  perform t.fails_with(format('select t.close_call(%L, %L, 109.945, 0.21989, 19.37001)', bob, bobtid), 'permission denied', 'close: authenticated cannot execute close_paper_trade for another user');
  perform t.login(adm);
  perform t.fails_with(format('select t.close_call(%L, %L, 109.945, 0.21989, 19.37001)', alice, tid1), 'permission denied', 'close: an admin-role user cannot execute close_paper_trade');
  -- and the direct routes around the function are shut
  perform t.login(alice);
  perform t.fails(format('update public.paper_trades set status = ''CLOSED'' where id = %L', tid1), 'close: owner cannot flip status directly');
  perform t.fails(format($q$insert into public.paper_trade_results (paper_trade_id, user_id, exit_price, fees, pnl) values (%L, %L, 1, 0, 1000000)$q$, tid1, alice), 'close: owner cannot fabricate a result');
  perform t.fails(format('update public.paper_accounts set cash_balance = 1000000 where user_id = %L', alice), 'close: owner cannot edit their own cash');
  perform t.superuser();
  perform t.ok((select status from public.paper_trades where id = tid1) = 'OPEN'
    and (select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = 9599.3998
    and (select count(*) from public.paper_trade_results) = 0, 'close: every refused attempt left the trade, balance and results untouched');

  -- ── A profitable close, as the server ──
  perform t.service();
  r := t.close(alice, tid1, 110);
  perform t.superuser();
  perform t.ok((r ->> 'pnl')::numeric = 19.37001 and (r ->> 'cash_credited')::numeric = 219.67011, 'close: P&L and cash credited are exact (219.67011 - 200.3001 = 19.37001)');
  perform t.ok((r ->> 'cash_balance_after')::numeric = 9819.06991 and r ->> 'currency' = 'USDT', 'close: returns the new balance and currency');
  perform t.ok((select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = 9819.06991, 'close: the account was credited by exactly gross proceeds - exit fee');
  select * into tr from public.paper_trades where id = tid1;
  perform t.ok(tr.status = 'CLOSED', 'close: the trade is CLOSED');
  perform t.ok(tr.entry_price = 100.05 and tr.quantity = 2 and tr.fees = 0.2001 and tr.cash_debited = 200.3001 and tr.notional = 200.1
    and tr.reference_price = 100 and tr.sim_version = 'PAPER_SIM_V1' and tr.side = 'BUY', 'close: the entry record is exactly as it was opened');
  select * into rs from public.paper_trade_results where paper_trade_id = tid1;
  perform t.ok(rs.exit_price = 109.945 and rs.fees = 0.21989 and rs.pnl = 19.37001 and rs.cash_credited = 219.67011, 'close: result stores exit price, EXIT fee, P&L and cash credited');
  perform t.ok(rs.reference_price = 110 and rs.slippage_bps = 5 and rs.fee_bps = 10 and rs.sim_version = 'PAPER_SIM_V1', 'close: exit provenance records reference price, slippage, fee rate and simulation version');
  perform t.ok(rs.quote_source = 'binance-public' and rs.quote_is_mock = false and rs.quote_as_of is not null and rs.quote_fetched_at is not null, 'close: the exit quote source/time/mock flag are recorded');
  perform t.ok(rs.account_id = tr.account_id and rs.user_id = alice, 'close: the result is tied to the trade''s own account and owner');
  perform t.ok(rs.closed_at = now(), 'close: closed_at is stamped by the database');
  perform t.ok(rs.exit_price < 110, 'close: a sell fills BELOW the quote (adverse slippage)');

  -- ── A losing close ──
  perform t.service();
  r := t.close(alice, tid2, 90);
  perform t.superuser();
  perform t.ok((r ->> 'pnl')::numeric = -10.285005 and (r ->> 'cash_credited')::numeric = 89.865045, 'close: a losing close records a negative P&L (89.865045 - 100.15005)');
  perform t.ok((select pnl from public.paper_trade_results where paper_trade_id = tid2) = -10.285005, 'close: the negative P&L is stored exactly');
  perform t.ok((select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = 9908.934955, 'close: the account was credited the (smaller) proceeds');

  -- ── The accounting identity: nothing is created or lost ──
  perform t.ok((select a.starting_cash
        + coalesce((select sum(x.pnl) from public.paper_trade_results x where x.account_id = a.id), 0)
        - coalesce((select sum(p.cash_debited) from public.paper_trades p where p.account_id = a.id and p.status = 'OPEN'), 0)
      from public.paper_accounts a where a.user_id = alice and a.currency = 'USDT')
    = (select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT'),
    'close: balance = starting cash + realized P&L - cost of still-open trades');

  -- ── Repeated close: refused, nothing changes, one result only ──
  perform t.service();
  bal := 9908.934955;
  perform t.fails_with(format('select t.close(%L, %L, 110)', alice, tid1), 'PAPER_TRADE_NOT_OPEN', 'repeat: closing an already-closed trade is refused');
  perform t.fails_with(format('select t.close(%L, %L, 50)', alice, tid1), 'PAPER_TRADE_NOT_OPEN', 'repeat: a different price does not reopen the window');
  perform t.superuser();
  perform t.ok((select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = bal, 'repeat: the balance is unchanged by refused repeats');
  perform t.ok((select count(*) from public.paper_trade_results where paper_trade_id = tid1) = 1, 'repeat: still exactly one result for the trade');
  perform t.fails_with(format($q$insert into public.paper_trade_results (paper_trade_id, user_id, exit_price, fees, pnl) values (%L, %L, 1, 0, 1)$q$, tid1, alice), 'duplicate key', 'repeat: UNIQUE(paper_trade_id) is a second line of defence against a duplicate result');

  -- ── Cross-user: a trade is found only by its owner ──
  perform t.service();
  perform t.fails_with(format('select t.close(%L, %L, 110)', bob, tid3), 'PAPER_TRADE_NOT_FOUND', 'cross-user: Bob cannot close Alice''s trade');
  perform t.fails_with(format('select t.close(%L, %L, 110)', alice, bobtid), 'PAPER_TRADE_NOT_FOUND', 'cross-user: Alice cannot close Bob''s trade');
  perform t.fails_with(format('select t.close_call(%L, %L, 109.945, 0.21989, 19.37001)', alice, ghost), 'PAPER_TRADE_NOT_FOUND', 'cross-user: an unknown trade id is the same error as someone else''s');
  perform t.superuser();
  perform t.ok((select status from public.paper_trades where id = tid3) = 'OPEN' and (select status from public.paper_trades where id = bobtid) = 'OPEN'
    and (select cash_balance from public.paper_accounts where user_id = bob and currency = 'USDT') = 9799.6999
    and (select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = bal, 'cross-user: the refused attempts changed neither trade nor either balance');

  -- ── The database re-derives every figure and refuses a disagreement (tid3: qty 1, cost 100.15005; at 110 => exit 109.945, fee 0.109945, P&L 9.685005) ──
  perform t.service();
  perform t.fails_with(format('select t.close_call(%L, %L, 200, 0.109945, 9.685005)', alice, tid3), 'exit price does not match', 'derive: a wrong exit price is refused');
  perform t.fails_with(format('select t.close_call(%L, %L, 109.945, 0, 9.685005)', alice, tid3), 'fee does not match', 'derive: a wrong (zero) fee is refused');
  perform t.fails_with(format('select t.close_call(%L, %L, 109.945, 0.109945, 1000000)', alice, tid3), 'P&L does not match', 'derive: an inflated P&L is refused');
  perform t.fails_with(format('select t.close_call(%L, %L, 109.945, 0.109945, -1)', alice, tid3), 'P&L does not match', 'derive: a deflated P&L is refused too');
  perform t.fails_with(format('select t.close_call(%L, %L, 0, 0.109945, 9.685005)', alice, tid3), 'out of range', 'derive: a zero exit price is refused');
  perform t.fails_with(format('select t.close_call(%L, %L, -1, 0.109945, 9.685005)', alice, tid3), 'out of range', 'derive: a negative exit price is refused');
  perform t.fails_with(format('select t.close_call(%L, %L, 109.945, -0.1, 9.685005)', alice, tid3), 'out of range', 'derive: a negative fee is refused');
  perform t.fails_with(format('select t.close_call(%L, %L, 109.945, 0.109945, 9.685005, 110, 10000)', alice, tid3), 'out of range', 'derive: 100% slippage is refused');
  perform t.fails_with(format($q$select t.close_call(%L, %L, 'NaN'::numeric, 0.109945, 9.685005)$q$, alice, tid3), 'must be finite', 'derive: NaN exit price is refused');
  perform t.fails_with(format($q$select t.close_call(%L, %L, 109.945, 'Infinity'::numeric, 9.685005)$q$, alice, tid3), 'must be finite', 'derive: infinite fee is refused');
  perform t.fails_with(format($q$select t.close_call(%L, %L, 109.945, 0.109945, 'NaN'::numeric)$q$, alice, tid3), 'must be finite', 'derive: NaN P&L is refused');
  perform t.fails_with(format('select t.close_call(%L, %L, null, 0.109945, 9.685005)', alice, tid3), 'numeric inputs are required', 'derive: a missing price is refused');
  perform t.fails_with(format($q$select t.close_call(%L, %L, 109.945, 0.109945, 9.685005, 110, 5, 10, '')$q$, alice, tid3), 'provenance', 'derive: a blank quote source is refused');
  perform t.fails_with($q$select public.close_paper_trade(null, null, 1, 0, 0, 'V', 1, 0, 0, 's', now(), now(), false)$q$, 'user and trade are required', 'derive: a missing user/trade is refused');
  perform t.superuser();
  perform t.ok((select status from public.paper_trades where id = tid3) = 'OPEN'
    and (select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = bal
    and (select count(*) from public.paper_trade_results) = 2, 'derive: every refused figure left trade, balance and results untouched');

  -- ── Atomicity: a failure AFTER the credit (and after the result) rolls everything back ──
  execute 'create trigger zz_boom_result before insert on public.paper_trade_results for each row execute function t.boom()';
  perform t.service();
  perform t.fails_with(format('select t.close(%L, %L, 110)', alice, tid3), 'BOOM', 'atomic: failure while inserting the result (after the credit) aborts the close');
  perform t.superuser();
  perform t.ok((select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = bal, 'atomic: the credit was rolled back with the failed result insert');
  perform t.ok((select status from public.paper_trades where id = tid3) = 'OPEN' and (select count(*) from public.paper_trade_results) = 2, 'atomic: trade still OPEN and no result row survived');
  execute 'drop trigger zz_boom_result on public.paper_trade_results';
  execute 'create trigger zz_boom_status before update on public.paper_trades for each row when (new.status = ''CLOSED'') execute function t.boom()';
  perform t.service();
  perform t.fails_with(format('select t.close(%L, %L, 110)', alice, tid3), 'BOOM', 'atomic: failure while flipping the status (after credit and result) aborts the close');
  perform t.superuser();
  perform t.ok((select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = bal, 'atomic: the credit was rolled back with the failed status change');
  perform t.ok((select count(*) from public.paper_trade_results where paper_trade_id = tid3) = 0 and (select status from public.paper_trades where id = tid3) = 'OPEN', 'atomic: no orphan result and the trade is still OPEN');
  execute 'drop trigger zz_boom_status on public.paper_trades';

  -- ── ...and once the fault is gone the same trade closes cleanly, crediting exactly once ──
  perform t.service();
  r := t.close(alice, tid3, 110);
  perform t.superuser();
  perform t.ok((r ->> 'pnl')::numeric = 9.685005 and (select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = bal + 109.835055, 'atomic: after the fault clears, the retry settles once (109.835055 credited)');
  bal := bal + 109.835055;

  -- ── Result and trade are server-owned and immutable ──
  perform t.service();
  perform t.fails_with(format('update public.paper_trade_results set pnl = 1000000 where paper_trade_id = %L', tid1), 'immutable once written', 'immutable: even service_role cannot edit a result''s P&L');
  perform t.fails_with(format('update public.paper_trade_results set exit_price = 1 where paper_trade_id = %L', tid1), 'immutable once written', 'immutable: even service_role cannot edit a result''s exit price');
  perform t.fails_with(format('update public.paper_trade_results set closed_at = now() - interval ''1 day'' where paper_trade_id = %L', tid1), 'immutable once written', 'immutable: even service_role cannot backdate a close');
  perform t.fails_with(format('update public.paper_trades set status = ''OPEN'' where id = %L', tid1), 'cannot be reopened', 'immutable: service_role cannot reopen a closed trade');
  perform t.fails_with(format('update public.paper_trades set entry_price = 1 where id = %L', tid1), 'entry record is immutable', 'immutable: a closed trade''s entry price cannot be rewritten');
  perform t.fails_with(format('update public.paper_trades set quantity = 99 where id = %L', tid1), 'entry record is immutable', 'immutable: a closed trade''s quantity cannot be rewritten');
  perform t.fails_with(format('update public.paper_trades set fees = 0 where id = %L', tid1), 'entry record is immutable', 'immutable: a closed trade''s entry fee cannot be rewritten');
  perform t.fails_with(format('update public.paper_trades set cash_debited = 1 where id = %L', tid1), 'entry record is immutable', 'immutable: a closed trade''s recorded cost cannot be rewritten');
  perform t.superuser();
  perform t.fails_with(format('update public.paper_trades set status = ''OPEN'' where id = %L', tid1), 'cannot be reopened', 'immutable: not even a superuser path reopens a closed trade');
  -- result integrity
  perform t.fails_with(format($q$insert into public.paper_trade_results (paper_trade_id, user_id, exit_price, fees, pnl) values (%L, %L, 1, 0, 1)$q$, bobtid, alice), 'must belong to its trade', 'integrity: a result cannot be filed against another user''s trade');
  perform t.fails_with(format($q$insert into public.paper_trade_results (paper_trade_id, user_id, exit_price, fees, pnl, sim_version) values (%L, %L, 1, 0, 1, 'PAPER_SIM_V1')$q$, bobtid, bob), 'execution_complete', 'integrity: a simulated result missing its execution fields is refused');
  perform t.fails_with(format($q$insert into public.paper_trade_results (paper_trade_id, user_id, exit_price, fees, pnl, reference_price) values (%L, %L, 1, 0, 1, 1)$q$, bobtid, bob), 'only_with_version', 'integrity: execution fields without a simulation version are refused');
  -- a direct insert cannot backdate the close
  insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity) values (alice, btc, 'BUY', 1, 1) returning id into legacy;
  insert into public.paper_trade_results (paper_trade_id, user_id, exit_price, fees, pnl, closed_at) values (legacy, alice, 1, 0, 0, now() - interval '30 days');
  perform t.ok((select closed_at = now() from public.paper_trade_results where paper_trade_id = legacy), 'immutable: closed_at is overwritten on insert (cannot be backdated)');

  -- ── Owners can read their own results and nothing else ──
  perform t.login(alice);
  perform t.ok((select count(*) from public.paper_trade_results where paper_trade_id = tid1) = 1, 'rls: the owner sees their own result');
  perform t.fails(format('update public.paper_trade_results set pnl = 1000000 where paper_trade_id = %L', tid1), 'rls: the owner cannot edit their result');
  perform t.fails(format('delete from public.paper_trade_results where paper_trade_id = %L', tid1), 'rls: the owner cannot delete their result');
  update public.paper_trades set stop_loss = 1 where id = tid1;
  get diagnostics n = row_count;
  perform t.ok(n = 0, 'rls: the owner cannot even touch SL/TP of a CLOSED trade');
  perform t.login(bob);
  perform t.ok((select count(*) from public.paper_trade_results where paper_trade_id = tid1) = 0, 'rls: another user cannot see Alice''s result');
  perform t.login(adm);
  perform t.ok((select count(*) from public.paper_trade_results) = 0, 'rls: an admin-role user has no read path to results either');
  perform t.superuser();

  -- ── Rows the simulator cannot settle are refused, not invented ──
  perform t.service();
  perform t.fails_with(format('select t.close_call(%L, %L, 109.945, 0.109945, 9.685005)', alice, legacy), 'PAPER_TRADE_NOT_CLOSABLE', 'scope: a pre-accounting trade (no recorded execution) cannot be closed');
  perform t.superuser();
  select account_id into acct from public.paper_trades where id = tid1;
  insert into public.paper_trades (user_id, asset_id, side, entry_price, quantity, fees, account_id, sim_version, reference_price, slippage_bps, fee_bps, notional, cash_debited, quote_source, quote_as_of, quote_fetched_at, quote_is_mock)
    values (alice, btc, 'SHORT', 1, 1, 0.001, acct, 'V', 1, 0, 0, 1, 1.001, 's', now(), now(), false) returning id into short_id;
  perform t.service();
  perform t.fails_with(format('select t.close_call(%L, %L, 109.945, 0.109945, 9.685005)', alice, short_id), 'PAPER_TRADE_NOT_CLOSABLE', 'scope: a SHORT is never settled (no short selling, margin or leverage)');
  perform t.superuser();
  perform t.ok((select status from public.paper_trades where id = short_id) = 'OPEN' and (select status from public.paper_trades where id = legacy) = 'OPEN', 'scope: refused rows stay OPEN and untouched');
  delete from public.paper_trades where id in (short_id, legacy);

  -- ── Currencies stay apart: closing an INR trade never touches USDT cash ──
  perform t.service();
  relid := (t.open(alice, rel, 3, 2500.5, 1000000, 5, 5) -> 'trade' ->> 'id')::uuid;
  r := t.close(alice, relid, 2600.5, 5, 5);
  perform t.superuser();
  perform t.ok((r ->> 'pnl')::numeric = 284.69707499 and r ->> 'currency' = 'INR', 'currency: an NSE trade settles in INR with NSE rates (P&L 284.69707499)');
  perform t.ok((select cash_balance from public.paper_accounts where user_id = alice and currency = 'INR') = 1000284.69707499, 'currency: the INR account holds starting cash + P&L');
  perform t.ok((select cash_balance from public.paper_accounts where user_id = alice and currency = 'USDT') = bal, 'currency: the USDT account was not touched');

  -- ── Whole-ledger invariants ──
  perform t.ok((select count(*) from public.paper_trades p where p.status = 'CLOSED' and p.sim_version is not null
      and not exists (select 1 from public.paper_trade_results x where x.paper_trade_id = p.id)) = 0, 'invariant: every settled CLOSED trade has exactly its result');
  perform t.ok((select count(*) from public.paper_trade_results x join public.paper_trades p on p.id = x.paper_trade_id
      where x.sim_version is not null and p.status <> 'CLOSED') = 0, 'invariant: every settled result belongs to a CLOSED trade');
  perform t.ok((select count(*) from public.paper_trades where user_id = bob and status = 'CLOSED') = 0
    and (select cash_balance from public.paper_accounts where user_id = bob and currency = 'USDT') = 9799.6999, 'invariant: Bob''s trade and cash were never touched by anyone else''s closes');
end $$;

drop schema t cascade;
