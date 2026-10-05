-- Phase 5B / migration 6: prediction evaluator support.
--
-- `prediction_results` already exists (migration 2): one row per prediction (UNIQUE), append-only
-- (migration 3), select-only for API roles (migration 4). This migration adds what the evaluator
-- needs to make a result trustworthy, without touching predictions or any existing grant/policy:
--
--   * the evaluation timestamp (`closed_at`) and `created_at` are set by the database, so a result
--     cannot be backdated by anyone, service role included;
--   * a result can only exist for an ENGINE prediction whose horizon has passed;
--   * a result must carry an evaluation price and its quote + candle provenance;
--   * a tamper-evident `content_hash` chains the result to the prediction's own hash;
--   * a service-role-only function lists the predictions that are due for evaluation.
--
-- Outcome vocabulary (no enum change): WIN = target reached first, INVALIDATED = invalidation
-- reached first (or ambiguous within one candle), EXPIRED = neither level reached within the
-- horizon. "Data unavailable" is deliberately NOT a stored result (see the note at the bottom).

alter table public.prediction_results
  add column content_hash text not null default '';

-- Evaluation price and provenance are mandatory. `coalesce(..., false)` matters: a CHECK passes
-- on NULL, so a missing key must be turned into an explicit failure.
alter table public.prediction_results
  add constraint prediction_results_evaluation_complete check (
    exit_price is not null
    and coalesce(jsonb_typeof(evaluation_meta -> 'quote') = 'object', false)
    and coalesce(jsonb_typeof(evaluation_meta -> 'candles') = 'object', false)
  );

create function public.prediction_results_before_insert() returns trigger
language plpgsql as $$
declare
  p public.predictions%rowtype;
begin
  select * into p from public.predictions where id = new.prediction_id;
  if not found then
    raise exception 'prediction % does not exist', new.prediction_id
      using errcode = 'foreign_key_violation';
  end if;
  -- Manual (client-created) predictions have no server-observed entry price or timeframe.
  if p.engine_version is null then
    raise exception 'prediction % is not an engine prediction and cannot be evaluated', p.id
      using errcode = 'check_violation';
  end if;
  if now() < p.expires_at then
    raise exception 'prediction % has not reached its horizon (expires_at %)', p.id, p.expires_at
      using errcode = 'restrict_violation';
  end if;

  -- Server-owned: whatever the caller supplied is overwritten.
  new.created_at := now();
  new.closed_at := now();
  new.content_hash := encode(
    sha256(convert_to(concat_ws('|',
      new.id, new.prediction_id, p.content_hash, new.status,
      new.closed_at::text, new.exit_price::text, coalesce(new.return_pct::text, ''),
      new.evaluation_meta::text
    ), 'UTF8')),
    'hex'
  );
  return new;
end;
$$;

create trigger prediction_results_before_insert
  before insert on public.prediction_results
  for each row execute function public.prediction_results_before_insert();

-- Discovery: engine predictions past their horizon with no result yet. A prediction whose
-- evaluation was deferred (data unavailable) is skipped for `p_retry_after_seconds`, using the
-- append-only audit log as the record of the attempt, so one unevaluable prediction cannot
-- monopolise every run.
create index predictions_due_idx on public.predictions (expires_at) where engine_version is not null;
create index audit_logs_evaluation_deferral_idx on public.audit_logs (entity_id, created_at desc)
  where action = 'prediction.evaluation_deferred';

create function public.predictions_due_for_evaluation(
  p_limit integer default 25,
  p_retry_after_seconds integer default 900
) returns setof public.predictions
language sql stable as $$
  select p.*
  from public.predictions p
  where p.engine_version is not null
    and p.expires_at <= now()
    and not exists (select 1 from public.prediction_results r where r.prediction_id = p.id)
    and not exists (
      select 1 from public.audit_logs a
      where a.action = 'prediction.evaluation_deferred'
        and a.entity_id = p.id::text
        and a.created_at > now() - make_interval(secs => greatest(p_retry_after_seconds, 0))
    )
  order by p.expires_at asc, p.id asc
  limit least(greatest(p_limit, 1), 100)
$$;

-- The only grant in this migration: the evaluator (service role) may call the discovery function.
-- Functions are executable by PUBLIC by default, so it is revoked from every API role first.
revoke execute on function public.predictions_due_for_evaluation(integer, integer) from public, anon, authenticated;
grant execute on function public.predictions_due_for_evaluation(integer, integer) to service_role;

-- NOTE: "UNAVAILABLE" is not a stored status. prediction_results is UNIQUE per prediction and
-- append-only, so persisting an "unavailable" row would permanently block the real evaluation that
-- becomes possible once data is available. A deferral is recorded in audit_logs
-- ('prediction.evaluation_deferred') and the prediction stays due.
