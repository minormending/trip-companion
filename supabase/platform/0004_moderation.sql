-- Platform: flags, feedback, and one queue over all apps.
--
-- Adapted from map-kit's sql/moderation.sql. Two deliberate differences,
-- both forced by several apps sharing one database:
--
--   1. An `app` column, so the queue can be filtered and moderation rights
--      checked per app.
--   2. No cross-app check constraint on target_type. map-kit substitutes
--      {{TARGET_TYPES}} into a check, which is right for one app and wrong
--      here: it would have to list every target type of every app, so adding
--      an app would mean altering a constraint that every other app depends
--      on. Each app validates its own types in its own submit path instead.
--
-- Otherwise the reasoning is map-kit's and worth restating: flags carry NO
-- foreign key to what they describe, so a flag outlives the thing it was
-- about. That is the audit trail — deleting the evidence alongside the thing
-- is how a deletion becomes unexplainable six months later.

set search_path = public, extensions;

create table if not exists flags (
  id            uuid primary key default gen_random_uuid(),
  app           text not null references apps(slug),
  target_type   text not null,
  target_id     uuid not null,
  reporter_id   uuid references profiles(id),
  kind          text not null default 'user',
  message       text not null,
  contact_email text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

create index if not exists flags_open on flags (app, created_at desc) where resolved_at is null;

do $$ begin
  create type feedback_kind as enum ('bug', 'idea', 'complaint');
exception when duplicate_object then null;
end $$;

create table if not exists feedback (
  id            uuid primary key default gen_random_uuid(),
  app           text not null references apps(slug),
  kind          feedback_kind not null,
  message       text not null,
  contact_email text,
  user_id       uuid references profiles(id),
  build         text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

create index if not exists feedback_open on feedback (app, created_at desc) where resolved_at is null;

alter table flags    enable row level security;
alter table feedback enable row level security;

-- No grants at all, for any API role. A client cannot read these back and
-- cannot write to them directly — the refusal is `permission denied for table`
-- rather than an empty result, which is a stronger answer than a policy
-- returning zero rows, because there is no policy to get wrong.
--
-- The submit_* functions are the only door.

create or replace function submit_flag(
  p_app           text,
  p_target_type   text,
  p_target_id     uuid,
  p_message       text,
  p_contact_email text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_fp text := client_fingerprint();
begin
  if not exists (select 1 from apps where slug = p_app) then
    raise exception 'unknown app: %', p_app using errcode = '22023';
  end if;
  if coalesce(length(trim(p_message)), 0) = 0 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  -- Keys are namespaced per app so a noisy app cannot spend another's budget.
  if not rl_take(p_app || ':flag:' || v_fp, interval '1 day', 10) then
    raise exception 'too many reports, try later' using errcode = '53400';
  end if;

  insert into flags (app, target_type, target_id, reporter_id, message, contact_email)
  values (p_app, p_target_type, p_target_id, auth.uid(),
          left(trim(p_message), 2000), nullif(trim(p_contact_email), ''));

  return jsonb_build_object('ok', true);
end $$;

grant execute on function submit_flag(text, text, uuid, text, text) to anon, authenticated;

create or replace function submit_feedback(
  p_app           text,
  p_kind          text,
  p_message       text,
  p_contact_email text default null,
  p_build         text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_fp   text := client_fingerprint();
  v_kind feedback_kind;
begin
  begin
    v_kind := p_kind::feedback_kind;
  exception when invalid_text_representation then
    raise exception 'unknown feedback kind: %', p_kind using errcode = '22023';
  end;

  if coalesce(length(trim(p_message)), 0) = 0 then
    raise exception 'a message is required' using errcode = '22023';
  end if;

  if not rl_take(p_app || ':feedback:' || v_fp, interval '1 day', 5) then
    raise exception 'too many messages, try later' using errcode = '53400';
  end if;

  insert into feedback (app, kind, message, contact_email, user_id, build)
  values (p_app, v_kind, left(trim(p_message), 4000),
          nullif(trim(p_contact_email), ''), auth.uid(), left(p_build, 40));

  return jsonb_build_object('ok', true);
end $$;

grant execute on function submit_feedback(text, text, text, text, text) to anon, authenticated;

-- One queue over both, across every app. The null casts must match the other
-- branch exactly: `create or replace view` cannot change a column's type,
-- including its precision.
create or replace view moderation_queue as
  select id, app, 'flag'::text as source, kind, null::text as subject,
         message, contact_email, target_id, created_at, resolved_at
    from flags
  union all
  select id, app, 'feedback'::text as source, kind::text, null::text as subject,
         message, contact_email, null::uuid as target_id, created_at, resolved_at
    from feedback;
