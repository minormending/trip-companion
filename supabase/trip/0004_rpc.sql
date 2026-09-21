-- Writes that need checking go through functions, never table grants.
--
-- This is the endpoint restroom-map arrived at over several migrations
-- (flags_rpc_only, feedback_rpc_only, writes_through_rpc). Adopting it here
-- rather than repeating the journey.

set search_path = trip, public, extensions;

-- Two reports withdraw a card, so unlimited reporting is a suppression attack:
-- two accounts, or one account twice, takes any operational card off the site.
-- The rate limit is the thing that makes the threshold safe.
create or replace function report_card(
  p_id         text,
  p_entity_key text,
  p_card_kind  text,
  p_claim      text,
  p_saw_body   text)
returns jsonb
language plpgsql security definer set search_path = trip, public, extensions as $$
declare v_fp text := public.client_fingerprint();
begin
  if auth.uid() is null then
    raise exception 'sign in to report a card' using errcode = '42501';
  end if;
  if coalesce(length(trim(p_claim)), 0) = 0 then
    raise exception 'say what was actually true' using errcode = '22023';
  end if;

  -- Banned accounts are refused here rather than filtered later, so the count
  -- that suppresses a card never includes them.
  if exists (select 1 from public.profiles p
              where p.id = auth.uid() and p.banned_at is not null) then
    raise exception 'account suspended' using errcode = '42501';
  end if;

  -- Per account and per address: one budget stops a single user, the other
  -- stops one person with several accounts.
  if not rl_take('trip-companion:report:' || auth.uid()::text, interval '1 day', 20) then
    raise exception 'too many reports, try later' using errcode = '53400';
  end if;
  if not rl_take('trip-companion:report-ip:' || v_fp, interval '1 day', 40) then
    raise exception 'too many reports, try later' using errcode = '53400';
  end if;

  -- One report per person per card. Without this, one account reporting twice
  -- reaches the suppression threshold on its own.
  if exists (select 1 from corrections c
              where c.entity_key = p_entity_key
                and c.card_kind = p_card_kind
                and c.submitted_by = auth.uid()
                and c.status = 'open') then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  insert into corrections (id, entity_key, card_kind, claim, saw_body, submitted_by)
  values (p_id, p_entity_key, p_card_kind,
          left(trim(p_claim), 2000), left(p_saw_body, 2000), auth.uid())
  on conflict (id) do nothing;

  return jsonb_build_object('ok', true);
end $$;

grant execute on function report_card(text, text, text, text, text) to authenticated;

-- Accepting is two writes that must not half-apply: the report is resolved and
-- the shared card is rewritten.
create or replace function accept_correction(p_id text, p_body text)
returns jsonb
language plpgsql security definer set search_path = trip, public, extensions as $$
declare c corrections%rowtype;
begin
  if not public.is_moderator('trip-companion') then
    raise exception 'not a moderator of this app' using errcode = '42501';
  end if;

  select * into c from corrections where id = p_id and status = 'open';
  if not found then
    raise exception 'no open report with id %', p_id using errcode = '22023';
  end if;

  update corrections
     set status = 'accepted', corrected_body = p_body,
         reviewed_at = now(), reviewed_by = auth.uid()
   where id = p_id;

  -- A traveller who was standing there outranks a recorded tag, so the card is
  -- rewritten and its confidence raised rather than merely annotated.
  update entity_cards
     set body = p_body, confidence = 0.95, verified_at = current_date
   where entity_key = c.entity_key and kind = c.card_kind;

  return jsonb_build_object('ok', true);
end $$;

grant execute on function accept_correction(text, text) to authenticated;

create or replace function reject_correction(p_id text)
returns jsonb
language plpgsql security definer set search_path = trip, public, extensions as $$
begin
  if not public.is_moderator('trip-companion') then
    raise exception 'not a moderator of this app' using errcode = '42501';
  end if;
  update corrections set status = 'rejected', reviewed_at = now(), reviewed_by = auth.uid()
   where id = p_id and status = 'open';
  if not found then
    raise exception 'no open report with id %', p_id using errcode = '22023';
  end if;
  return jsonb_build_object('ok', true);
end $$;

grant execute on function reject_correction(text) to authenticated;

-- Open reports surface into the shared moderation queue with the same column
-- names the platform view uses, so one reviewer UI covers every app.
create or replace view public.trip_moderation_queue as
  select c.id::text as id,
         'trip-companion'::text as app,
         'correction'::text as source,
         c.card_kind as kind,
         c.entity_key as subject,
         c.claim as message,
         null::text as contact_email,
         c.submitted_at as created_at,
         c.reviewed_at as resolved_at
    from trip.corrections c;
