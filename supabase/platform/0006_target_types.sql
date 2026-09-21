-- Give back the target-type check, per app.
--
-- map-kit validates target_type against a check constraint built from
-- {{TARGET_TYPES}}. 0004 dropped it, because in a shared database that
-- constraint would have to list every app's types and adding an app would mean
-- altering something every other app depends on.
--
-- Dropping it also dropped the guarantee: an invented target type was stored
-- rather than refused, so a flag could point at a kind of thing that does not
-- exist and no reviewer would ever find it.
--
-- Each app declares its own types instead, and submit_flag checks against the
-- calling app's list. Adding an app touches one row.

set search_path = public, extensions;

alter table apps add column if not exists target_types text[] not null default '{}';

update apps set target_types = array['bathroom'] where slug = 'restroom-map';
update apps set target_types = array['card', 'place', 'leg'] where slug = 'trip-companion';

create or replace function submit_flag(
  p_app           text,
  p_target_type   text,
  p_target_id     uuid,
  p_message       text,
  p_contact_email text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_fp    text := client_fingerprint();
  v_types text[];
begin
  select target_types into v_types from apps where slug = p_app;
  if v_types is null then
    raise exception 'unknown app: %', p_app using errcode = '22023';
  end if;
  -- An empty list means the app has not declared any yet; refuse rather than
  -- wave everything through, which is the failure this check exists to stop.
  if not (p_target_type = any(v_types)) then
    raise exception 'unknown target type for %: %', p_app, p_target_type using errcode = '22023';
  end if;
  if coalesce(length(trim(p_message)), 0) = 0 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  if not rl_take(p_app || ':flag:' || v_fp, interval '1 day', 10) then
    raise exception 'too many reports, try later' using errcode = '53400';
  end if;

  insert into flags (app, target_type, target_id, reporter_id, message, contact_email)
  values (p_app, p_target_type, p_target_id, auth.uid(),
          left(trim(p_message), 2000), nullif(trim(p_contact_email), ''));

  return jsonb_build_object('ok', true);
end $$;

grant execute on function submit_flag(text, text, uuid, text, text) to anon, authenticated;
