-- Phase 1 / migration 3: functions and triggers.

-- Create profile, preferences and a free subscription for every new auth user.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1))
  );
  insert into public.user_preferences (user_id) values (new.id);
  insert into public.subscriptions (user_id, plan, status) values (new.id, 'free', 'active');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Admin check used by RLS policies. SECURITY DEFINER avoids policy recursion on profiles.
create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role = 'admin' from public.profiles where id = auth.uid()),
    false
  );
$$;

-- Belt and braces: even if a grant were widened later, API roles cannot change `role`.
create function public.protect_profile_role() returns trigger
language plpgsql as $$
begin
  if new.role is distinct from old.role and current_user in ('anon', 'authenticated') then
    raise exception 'profiles.role can only be changed by the server'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger protect_profile_role
  before update on public.profiles
  for each row execute function public.protect_profile_role();

-- ── Predictions: server-owned timestamp, expiry and tamper-evident hash ──
create function public.predictions_before_insert() returns trigger
language plpgsql as $$
begin
  -- Client-supplied values for these are always overwritten.
  new.created_at := now();
  new.expires_at := now() + make_interval(hours => new.horizon_hours);
  new.content_hash := encode(
    sha256(convert_to(concat_ws('|',
      new.id, new.user_id, new.origin, new.asset_id, new.direction,
      new.target_price::text, new.invalidation_price::text, new.horizon_hours::text,
      coalesce(new.rationale, ''), new.created_at::text
    ), 'UTF8')),
    'hex'
  );
  return new;
end;
$$;

create trigger predictions_before_insert
  before insert on public.predictions
  for each row execute function public.predictions_before_insert();

-- Corrections are new rows: server timestamp, per-prediction version, and no
-- corrections once a final result exists.
create function public.prediction_updates_before_insert() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from public.prediction_results r where r.prediction_id = new.prediction_id) then
    raise exception 'prediction % is already closed; it cannot be updated', new.prediction_id
      using errcode = 'restrict_violation';
  end if;
  new.created_at := now();
  select coalesce(max(version), 0) + 1 into new.version
  from public.prediction_updates where prediction_id = new.prediction_id;
  return new;
end;
$$;

create trigger prediction_updates_before_insert
  before insert on public.prediction_updates
  for each row execute function public.prediction_updates_before_insert();

-- Append-only: block UPDATE/DELETE/TRUNCATE for every role (service_role included).
do $$
declare t text;
begin
  foreach t in array array['predictions','prediction_updates','prediction_results','audit_logs'] loop
    execute format(
      'create trigger %1$s_append_only before update or delete on public.%1$I
       for each row execute function public.prevent_mutation()', t);
    execute format(
      'create trigger %1$s_no_truncate before truncate on public.%1$I
       for each statement execute function public.prevent_mutation()', t);
  end loop;
end $$;

-- ── Rate limiting (fixed window, atomic upsert) ──
-- Returns true when the call is within the limit.
create function public.check_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_window timestamptz;
  v_count integer;
begin
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'invalid rate limit parameters';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning r.count into v_count;
  return v_count <= p_limit;
end;
$$;

create function public.purge_rate_limits(p_older_than interval default interval '1 day')
returns integer
language plpgsql security definer set search_path = public as $$
declare v_deleted integer;
begin
  delete from public.rate_limits where window_start < now() - p_older_than;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
