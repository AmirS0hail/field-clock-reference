-- Field clock reference checks. Run this in the Supabase SQL editor after the migration.
-- Not a migration. It raises if a check fails.
--
-- Create these Authentication users first, with email confirmation turned off:
--   demo-a@fieldclock.test
--   demo-b@fieldclock.test
--
-- If a run stops halfway, run: reset role;

reset role;

do $setup$
declare
  user_a uuid;
  user_b uuid;
begin
  select id into user_a from auth.users where email = 'demo-a@fieldclock.test';
  select id into user_b from auth.users where email = 'demo-b@fieldclock.test';

  if user_a is null or user_b is null then
    raise exception
      'Create demo-a@fieldclock.test and demo-b@fieldclock.test in Authentication, with email confirmation off, then run this script again.';
  end if;

  perform set_config('fieldclock.user_a', user_a::text, false);
  perform set_config('fieldclock.user_b', user_b::text, false);

  delete from public.clock_events
  where event_id in (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555'
  );
end
$setup$;

select set_config('request.jwt.claim.sub', current_setting('fieldclock.user_a'), false);
select set_config(
  'request.jwt.claims',
  json_build_object('sub', current_setting('fieldclock.user_a')::uuid, 'role', 'authenticated')::text,
  false
);
set role authenticated;

do $user_a$
declare
  user_a uuid := current_setting('fieldclock.user_a')::uuid;
  event_in uuid := '11111111-1111-4111-8111-111111111111';
  event_second uuid := '22222222-2222-4222-8222-222222222222';
  result jsonb;
  again jsonb;
  row_id bigint;
  received timestamptz;
  cnt int;
begin
  if current_user <> 'authenticated' then
    raise exception 'expected role authenticated, got %', current_user;
  end if;

  if auth.uid() is distinct from user_a then
    raise exception 'auth.uid() did not match demo A';
  end if;

  result := public.record_clock_event(event_in, 'clock_in', timestamptz '2001-01-01 00:00:00+00');
  if result->>'ok' is distinct from 'true' or (result->>'duplicate')::boolean is true then
    raise exception 'expected a new clock-in, got %', result;
  end if;

  if (result->'row'->>'device_time')::timestamptz is distinct from timestamptz '2001-01-01 00:00:00+00' then
    raise exception 'device time was not stored as the claimed time';
  end if;

  if (result->'row'->>'received_at')::timestamptz < clock_timestamp() - interval '5 minutes' then
    raise exception 'received_at did not come from the database clock';
  end if;

  row_id := (result->'row'->>'id')::bigint;
  received := (result->'row'->>'received_at')::timestamptz;

  again := public.record_clock_event(event_in, 'clock_in', clock_timestamp());
  if again->>'ok' is distinct from 'true' or (again->>'duplicate')::boolean is not true then
    raise exception 'expected the original row on duplicate event_id, got %', again;
  end if;

  if (again->'row'->>'id')::bigint is distinct from row_id
     or (again->'row'->>'received_at')::timestamptz is distinct from received then
    raise exception 'duplicate event_id did not return the original row';
  end if;

  select count(*) into cnt
  from public.clock_events
  where user_id = user_a
    and event_id = event_in;
  if cnt <> 1 then
    raise exception 'duplicate event_id wrote another row (count %)', cnt;
  end if;

  result := public.record_clock_event(event_second, 'clock_in', clock_timestamp());
  if result->>'reason' is distinct from 'already_clocked_in' then
    raise exception 'expected already_clocked_in, got %', result;
  end if;

  select count(*) into cnt
  from public.clock_events
  where event_id = event_second;
  if cnt <> 0 then
    raise exception 'invalid clock-in wrote a row';
  end if;
end
$user_a$;

select set_config('request.jwt.claim.sub', current_setting('fieldclock.user_b'), false);
select set_config(
  'request.jwt.claims',
  json_build_object('sub', current_setting('fieldclock.user_b')::uuid, 'role', 'authenticated')::text,
  false
);

do $user_b$
declare
  user_a uuid := current_setting('fieldclock.user_a')::uuid;
  user_b uuid := current_setting('fieldclock.user_b')::uuid;
  event_future uuid := '33333333-3333-4333-8333-333333333333';
  event_out uuid := '44444444-4444-4444-8444-444444444444';
  result jsonb;
  cnt int;
begin
  if auth.uid() is distinct from user_b then
    raise exception 'auth.uid() did not match demo B';
  end if;

  result := public.record_clock_event(event_out, 'clock_out', clock_timestamp());
  if result->>'reason' is distinct from 'already_clocked_out' then
    raise exception 'expected already_clocked_out, got %', result;
  end if;

  result := public.record_clock_event(event_future, 'clock_in', clock_timestamp() + interval '6 minutes');
  if result->>'reason' is distinct from 'device_time_in_future' then
    raise exception 'expected device_time_in_future, got %', result;
  end if;

  select count(*) into cnt
  from public.clock_events
  where event_id in (event_out, event_future);
  if cnt <> 0 then
    raise exception 'rejected events wrote % rows', cnt;
  end if;

  select count(*) into cnt
  from public.clock_events
  where user_id = user_a;
  if cnt <> 0 then
    raise exception 'user B can read % of user A rows', cnt;
  end if;
end
$user_b$;

select set_config('request.jwt.claim.sub', current_setting('fieldclock.user_a'), false);
select set_config(
  'request.jwt.claims',
  json_build_object('sub', current_setting('fieldclock.user_a')::uuid, 'role', 'authenticated')::text,
  false
);

do $read_and_insert$
declare
  user_a uuid := current_setting('fieldclock.user_a')::uuid;
  event_in uuid := '11111111-1111-4111-8111-111111111111';
  cnt int;
begin
  select count(*) into cnt
  from public.clock_events
  where user_id = user_a
    and event_id = event_in;
  if cnt <> 1 then
    raise exception 'user A should see their own clock-in, saw %', cnt;
  end if;

  begin
    insert into public.clock_events (user_id, event_id, kind, device_time)
    values (
      user_a,
      '55555555-5555-4555-8555-555555555555',
      'clock_in',
      clock_timestamp()
    );
    raise exception 'direct insert was allowed';
  exception
    when insufficient_privilege then
      null;
  end;
end
$read_and_insert$;

reset role;

delete from public.clock_events
where event_id in (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555'
);

do $done$
begin
  raise notice 'field clock checks passed';
end
$done$;
