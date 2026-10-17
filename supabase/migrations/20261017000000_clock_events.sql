-- Field clock reference.
-- The browser may select its own rows. Inserts go through record_clock_event only.

create table public.clock_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id),
  event_id uuid not null,
  kind text not null check (kind in ('clock_in', 'clock_out')),
  device_time timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  unique (user_id, event_id)
);

create index clock_events_user_received_idx
  on public.clock_events (user_id, received_at desc);

alter table public.clock_events enable row level security;
alter table public.clock_events force row level security;

revoke all on table public.clock_events from public, anon, authenticated, service_role;
grant select on table public.clock_events to authenticated;

create policy clock_events_select_own
  on public.clock_events
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.record_clock_event(
  p_event_id uuid,
  p_kind text,
  p_device_time timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.clock_events;
  v_latest public.clock_events;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;

  -- One clock write at a time for this user, so two different ids cannot both pass the state check.
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  -- Lost response: the row is already committed. Return it before any state check.
  select *
    into v_row
  from public.clock_events
  where user_id = v_uid
    and event_id = p_event_id;

  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'row', to_jsonb(v_row));
  end if;

  if p_kind is null or p_kind not in ('clock_in', 'clock_out') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_kind');
  end if;

  if p_device_time > clock_timestamp() + interval '5 minutes' then
    return jsonb_build_object('ok', false, 'reason', 'device_time_in_future');
  end if;

  select *
    into v_latest
  from public.clock_events
  where user_id = v_uid
  order by received_at desc, id desc
  limit 1;

  if p_kind = 'clock_in' and v_latest.kind = 'clock_in' then
    return jsonb_build_object('ok', false, 'reason', 'already_clocked_in');
  end if;

  if p_kind = 'clock_out' and (v_latest.id is null or v_latest.kind = 'clock_out') then
    return jsonb_build_object('ok', false, 'reason', 'already_clocked_out');
  end if;

  begin
    insert into public.clock_events (user_id, event_id, kind, device_time, received_at)
    values (v_uid, p_event_id, p_kind, p_device_time, clock_timestamp())
    returning * into v_row;
  exception
    when unique_violation then
      select *
        into v_row
      from public.clock_events
      where user_id = v_uid
        and event_id = p_event_id;

      return jsonb_build_object('ok', true, 'duplicate', true, 'row', to_jsonb(v_row));
  end;

  return jsonb_build_object('ok', true, 'duplicate', false, 'row', to_jsonb(v_row));
end;
$$;

revoke all on function public.record_clock_event(uuid, text, timestamptz) from public, anon, service_role;
grant execute on function public.record_clock_event(uuid, text, timestamptz) to authenticated;

comment on function public.record_clock_event(uuid, text, timestamptz) is
  'Inserts one clock event for auth.uid(). A repeated event_id returns the original row and writes nothing.';
