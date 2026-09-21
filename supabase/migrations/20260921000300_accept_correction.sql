-- Accepting a correction is two writes that must not half-apply: the report is
-- resolved and the shared card is rewritten. Doing it in one security-definer
-- function also keeps entity_cards unwritable through the API.
create or replace function public.accept_correction(
  correction_id text,
  new_body text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.corrections%rowtype;
begin
  if not public.is_reviewer(auth.uid()) then
    raise exception 'not a reviewer';
  end if;

  select * into c from public.corrections where id = correction_id and status = 'open';
  if not found then
    raise exception 'no open report with id %', correction_id;
  end if;

  update public.corrections
     set status = 'accepted',
         corrected_body = new_body,
         reviewed_at = now(),
         reviewed_by = auth.uid()
   where id = correction_id;

  -- A traveller who was standing there outranks a recorded tag, so the card is
  -- rewritten and its confidence raised rather than merely annotated.
  update public.entity_cards
     set body = new_body,
         confidence = 0.95,
         verified_at = current_date
   where entity_key = c.entity_key and kind = c.card_kind;
end;
$$;

revoke all on function public.accept_correction(text, text) from public;
grant execute on function public.accept_correction(text, text) to authenticated;
