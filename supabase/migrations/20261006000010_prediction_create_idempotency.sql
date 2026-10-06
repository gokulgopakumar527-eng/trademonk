-- Phase 5D-A / migration 10: prediction creation idempotency, DATABASE FOUNDATION ONLY.
--
-- Adds the storage and the uniqueness guarantee that a later phase will use to make engine
-- prediction creation replay-safe (timeout retry, double click, concurrent duplicate).
--
--   * predictions.idempotency_key: client-generated. Nullable in the table so every row written
--     before this migration stays valid (legacy rows keep NULL). Requiring a key for NEW
--     engine-created predictions is an application-layer rule in a later phase, deliberately
--     not a table constraint here.
--   * format check: 16-128 characters from [A-Za-z0-9._-] (same recipe as paper_trades).
--   * partial unique index on (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL:
--     same user + same key = one logical prediction; different users may reuse a key; any
--     number of NULL-key rows is allowed.
--
-- Deliberately NOT changed:
--   * predictions_before_insert() and the content_hash recipe (hash_version 2 stays as is). The
--     key is not part of the hash, so existing and new hashes are unaffected.
--   * the append-only triggers from migration 3. They fire for every role on UPDATE, DELETE and
--     TRUNCATE, so the key is immutable once written without any new guard.
--   * RLS policies and grants. `authenticated` keeps its column-level INSERT list from
--     migration 4, which does not include the new column, so a client cannot set or forge a
--     key; there is still no UPDATE or DELETE grant. The table-level SELECT grant means the
--     owner can read their own key through the existing predictions_select policy.
--
-- Not in this migration: application code, UI, replay logic, paper-trading changes.

alter table public.predictions
  add column idempotency_key text;

alter table public.predictions
  add constraint predictions_idempotency_key_format check (
    idempotency_key is null
    or (char_length(idempotency_key) between 16 and 128 and idempotency_key ~ '^[A-Za-z0-9._-]+$')
  );

create unique index predictions_user_idempotency_key_uidx
  on public.predictions (user_id, idempotency_key)
  where idempotency_key is not null;
