-- Phase 5A / migration 5: deterministic prediction engine columns.
--
-- Engine-generated predictions carry a server-observed entry price, the provenance of the quote
-- it came from, the engine version and a frozen snapshot of the signals used. All of these are
-- written by the server (service role) only: `authenticated` has NO column grant on any of them,
-- so a client cannot set or forge them, and the append-only triggers from migration 3 (which fire
-- for every role) make them immutable once written.
--
-- Lifecycle (CREATED -> ACTIVE -> EXPIRED) is DERIVED from created_at / expires_at at read time.
-- There is deliberately no mutable `status` column: this table is append-only.

alter table public.predictions
  add column engine_version text,
  add column signal_agreement smallint check (signal_agreement between 0 and 5),
  add column signal_total smallint check (signal_total = 5),
  add column entry_quote_source text,
  add column entry_quote_as_of timestamptz,
  add column entry_quote_fetched_at timestamptz,
  add column entry_quote_is_mock boolean,
  add column engine_snapshot jsonb,
  -- Version of the content_hash recipe. 1 = migration 3 recipe; 2 = includes engine fields.
  add column hash_version smallint not null default 1;

-- An engine prediction is only valid when every engine field is present. Client-created
-- (manual) predictions leave engine_version NULL and therefore have no entry price at all.
alter table public.predictions
  add constraint predictions_engine_fields_complete check (
    engine_version is null or (
      entry_reference_price is not null
      and signal_agreement is not null
      and signal_total is not null
      and entry_quote_source is not null
      and entry_quote_as_of is not null
      and entry_quote_fetched_at is not null
      and entry_quote_is_mock is not null
      and engine_snapshot is not null
    )
  ),
  -- Engine fields must not appear without an engine version (no half-forged rows).
  add constraint predictions_engine_fields_only_with_version check (
    engine_version is not null or (
      signal_agreement is null and signal_total is null and entry_quote_source is null
      and entry_quote_as_of is null and entry_quote_fetched_at is null
      and entry_quote_is_mock is null and engine_snapshot is null
    )
  );

-- Hash recipe v2. Covers everything an auditor needs to detect tampering, including the entry
-- price, the quote provenance and the frozen signal snapshot (jsonb::text is normalised, so the
-- same content always yields the same text). Recipe v1 rows keep their original hash.
create or replace function public.predictions_before_insert() returns trigger
language plpgsql as $$
begin
  -- Client-supplied values for these are always overwritten.
  new.created_at := now();
  new.expires_at := now() + make_interval(hours => new.horizon_hours);
  new.hash_version := 2;
  new.content_hash := encode(
    sha256(convert_to(concat_ws('|',
      new.id, new.user_id, new.origin, new.asset_id, new.direction,
      new.target_price::text, new.invalidation_price::text, new.horizon_hours::text,
      coalesce(new.rationale, ''), new.created_at::text,
      coalesce(new.timeframe, ''),
      coalesce(new.entry_reference_price::text, ''),
      coalesce(new.engine_version, ''),
      coalesce(new.signal_agreement::text, ''),
      coalesce(new.entry_quote_source, ''),
      coalesce(new.entry_quote_as_of::text, ''),
      coalesce(new.entry_quote_fetched_at::text, ''),
      coalesce(new.entry_quote_is_mock::text, ''),
      coalesce(new.engine_snapshot::text, '')
    ), 'UTF8')),
    'hex'
  );
  return new;
end;
$$;

-- NOTE: no `grant` statements here on purpose. `authenticated` keeps its existing column-level
-- INSERT grant from migration 4, which does not include entry_reference_price or any column
-- added above. Engine predictions are inserted by the server with the service role only.
