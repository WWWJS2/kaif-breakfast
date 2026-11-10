-- =====================================================================
--  KAIF · دعوات تجربة الفطور
--  Supabase schema — run once in: Supabase Dashboard → SQL Editor
--
--  Security model
--   * No table is readable or writable by anon/authenticated directly.
--   * Visitors only call two functions: get_availability, create_booking.
--   * create_booking locks the day row (SELECT … FOR UPDATE) so two
--     simultaneous requests can never push a day past its capacity.
--   * Admin functions check public.is_admin() (auth.uid() in public.admins).
-- =====================================================================

-- ---------- tables ----------------------------------------------------
create table if not exists public.settings (
  id               smallint primary key default 1 check (id = 1),
  capacity_per_day int     not null default 10 check (capacity_per_day between 1 and 1000),
  max_party        int     not null default 9  check (max_party between 1 and 20),
  booking_open     boolean not null default true,
  updated_at       timestamptz not null default now()
);

create table if not exists public.days (
  id                text primary key,
  label             text not null,
  event_date        date,
  sort              smallint not null default 0,
  is_open           boolean  not null default true,
  capacity_override int check (capacity_override is null or capacity_override >= 0)
);

create table if not exists public.time_slots (
  id        uuid primary key default gen_random_uuid(),
  starts_at time not null,
  ends_at   time not null,
  sort      smallint not null default 0,
  is_active boolean  not null default true,
  constraint slot_order check (ends_at > starts_at)
);

create table if not exists public.bookings (
  id           uuid primary key default gen_random_uuid(),
  guest_name   text not null check (char_length(btrim(guest_name)) between 2 and 80),
  day_id       text not null references public.days(id),
  slot_id      uuid references public.time_slots(id) on delete set null,
  slot_start   time not null,
  slot_end     time not null,
  party_size   int  not null check (party_size between 1 and 20),
  status       text not null default 'confirmed'
               check (status in ('confirmed','attended','cancelled')),
  client_token uuid not null unique,
  admin_note   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists bookings_day_active_idx
  on public.bookings (day_id) where status <> 'cancelled';

create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------- lock everything down -------------------------------------
alter table public.settings   enable row level security;
alter table public.days       enable row level security;
alter table public.time_slots enable row level security;
alter table public.bookings   enable row level security;
alter table public.admins     enable row level security;

revoke all on public.settings, public.days, public.time_slots,
              public.bookings, public.admins from anon, authenticated;

-- ---------- helpers ---------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

create or replace function public._assert_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
end $$;

create or replace function public._day_booked(p_day text)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(sum(party_size), 0)::int
  from public.bookings where day_id = p_day and status <> 'cancelled';
$$;

-- ---------- public: availability -------------------------------------
create or replace function public.get_availability()
returns json language sql stable security definer set search_path = public as $$
  with s as (select * from public.settings where id = 1),
  d as (
    select dy.id, dy.label, dy.event_date, dy.sort, dy.is_open,
           coalesce(dy.capacity_override, s.capacity_per_day) as capacity,
           public._day_booked(dy.id) as booked
    from public.days dy cross join s
  )
  select json_build_object(
    'open',      (select booking_open from s),
    'max_party', (select max_party from s),
    'days', coalesce((select json_agg(json_build_object(
                 'id', id, 'label', label, 'event_date', event_date,
                 'is_open', is_open, 'remaining', greatest(capacity - booked, 0),
                 'available', is_open and capacity - booked > 0
               ) order by sort) from d), '[]'::json),
    'slots', coalesce((select json_agg(json_build_object(
                 'id', id, 'starts_at', to_char(starts_at,'HH24:MI'),
                 'ends_at', to_char(ends_at,'HH24:MI')
               ) order by sort, starts_at)
               from public.time_slots where is_active), '[]'::json)
  );
$$;

-- ---------- public: booking (atomic) ---------------------------------
create or replace function public.create_booking(
  p_name text, p_day text, p_slot uuid, p_party int, p_token uuid)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  v_s     public.settings;
  v_d     public.days;
  v_slot  public.time_slots;
  v_cap   int;
  v_used  int;
  v_row   public.bookings;
  v_name  text := btrim(coalesce(p_name, ''));
begin
  if p_token is null then
    return json_build_object('ok', false, 'error', 'invalid_token');
  end if;

  -- same submission sent twice → return the first result
  select * into v_row from public.bookings where client_token = p_token;
  if found then
    return json_build_object('ok', true, 'duplicate', true, 'booking', json_build_object(
      'id', v_row.id, 'day_id', v_row.day_id, 'party_size', v_row.party_size,
      'starts_at', to_char(v_row.slot_start,'HH24:MI'), 'ends_at', to_char(v_row.slot_end,'HH24:MI')));
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    return json_build_object('ok', false, 'error', 'invalid_name');
  end if;

  select * into v_s from public.settings where id = 1;
  if not v_s.booking_open then
    return json_build_object('ok', false, 'error', 'closed');
  end if;
  if p_party is null or p_party < 1 or p_party > v_s.max_party then
    return json_build_object('ok', false, 'error', 'invalid_party');
  end if;

  -- serialize every booking for this day
  select * into v_d from public.days where id = p_day for update;
  if not found then
    return json_build_object('ok', false, 'error', 'invalid_day');
  end if;
  if not v_d.is_open then
    return json_build_object('ok', false, 'error', 'day_closed', 'remaining', 0);
  end if;

  select * into v_slot from public.time_slots where id = p_slot and is_active;
  if not found then
    return json_build_object('ok', false, 'error', 'invalid_slot');
  end if;

  v_cap  := coalesce(v_d.capacity_override, v_s.capacity_per_day);
  v_used := public._day_booked(p_day);
  if v_used + p_party > v_cap then
    return json_build_object('ok', false,
      'error', case when v_used >= v_cap then 'day_full' else 'not_enough_seats' end,
      'remaining', greatest(v_cap - v_used, 0));
  end if;

  insert into public.bookings (guest_name, day_id, slot_id, slot_start, slot_end, party_size, client_token)
  values (v_name, p_day, v_slot.id, v_slot.starts_at, v_slot.ends_at, p_party, p_token)
  on conflict (client_token) do nothing
  returning * into v_row;

  if v_row.id is null then  -- lost a race with the same token
    select * into v_row from public.bookings where client_token = p_token;
  end if;

  return json_build_object('ok', true, 'remaining', greatest(v_cap - v_used - p_party, 0),
    'booking', json_build_object(
      'id', v_row.id, 'day_id', v_row.day_id, 'party_size', v_row.party_size,
      'starts_at', to_char(v_row.slot_start,'HH24:MI'), 'ends_at', to_char(v_row.slot_end,'HH24:MI')));
end $$;

-- ---------- admin -----------------------------------------------------
create or replace function public.admin_dashboard()
returns json language plpgsql stable security definer set search_path = public as $$
declare v json;
begin
  perform public._assert_admin();
  select json_build_object(
    'settings', (select row_to_json(s) from public.settings s where id = 1),
    'days', coalesce((select json_agg(json_build_object(
        'id', d.id, 'label', d.label, 'event_date', d.event_date, 'is_open', d.is_open,
        'capacity_override', d.capacity_override,
        'capacity', coalesce(d.capacity_override, s.capacity_per_day),
        'booked', public._day_booked(d.id),
        'bookings', (select count(*) from public.bookings b where b.day_id = d.id and b.status <> 'cancelled')
      ) order by d.sort) from public.days d cross join public.settings s where s.id = 1), '[]'::json),
    'slots', coalesce((select json_agg(json_build_object(
        'id', t.id, 'starts_at', to_char(t.starts_at,'HH24:MI'), 'ends_at', to_char(t.ends_at,'HH24:MI'),
        'is_active', t.is_active, 'sort', t.sort) order by t.sort, t.starts_at)
      from public.time_slots t), '[]'::json),
    'bookings', coalesce((select json_agg(json_build_object(
        'id', b.id, 'guest_name', b.guest_name, 'day_id', b.day_id, 'party_size', b.party_size,
        'starts_at', to_char(b.slot_start,'HH24:MI'), 'ends_at', to_char(b.slot_end,'HH24:MI'),
        'status', b.status, 'admin_note', b.admin_note, 'created_at', b.created_at
      ) order by b.created_at desc) from public.bookings b), '[]'::json)
  ) into v;
  return v;
end $$;

create or replace function public.admin_update_settings(p_capacity int default null, p_max_party int default null, p_open boolean default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._assert_admin();
  update public.settings set
    capacity_per_day = coalesce(p_capacity, capacity_per_day),
    max_party        = coalesce(p_max_party, max_party),
    booking_open     = coalesce(p_open, booking_open),
    updated_at       = now()
  where id = 1;
end $$;

create or replace function public.admin_update_day(
  p_id text, p_is_open boolean default null, p_capacity_override int default null, p_clear_override boolean default false)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._assert_admin();
  update public.days set
    is_open = coalesce(p_is_open, is_open),
    capacity_override = case when p_clear_override then null
                             else coalesce(p_capacity_override, capacity_override) end
  where id = p_id;
end $$;

create or replace function public.admin_save_slot(
  p_id uuid default null, p_starts text default null, p_ends text default null, p_active boolean default null, p_sort int default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public._assert_admin();
  if p_id is null then
    insert into public.time_slots (starts_at, ends_at, is_active, sort)
    values (p_starts::time, p_ends::time, coalesce(p_active, true), coalesce(p_sort, 0))
    returning id into v_id;
  else
    update public.time_slots set
      starts_at = coalesce(p_starts::time, starts_at),
      ends_at   = coalesce(p_ends::time, ends_at),
      is_active = coalesce(p_active, is_active),
      sort      = coalesce(p_sort, sort)
    where id = p_id returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.admin_delete_slot(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._assert_admin();
  delete from public.time_slots where id = p_id;
end $$;

create or replace function public.admin_set_booking_status(p_id uuid, p_status text)
returns json language plpgsql security definer set search_path = public as $$
declare v_b public.bookings; v_cap int;
begin
  perform public._assert_admin();
  if p_status not in ('confirmed','attended','cancelled') then
    return json_build_object('ok', false, 'error', 'invalid_status');
  end if;
  select * into v_b from public.bookings where id = p_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;

  -- re-activating a cancelled booking must respect capacity too
  if v_b.status = 'cancelled' and p_status <> 'cancelled' then
    perform 1 from public.days where id = v_b.day_id for update;
    select coalesce(d.capacity_override, s.capacity_per_day) into v_cap
      from public.days d cross join public.settings s where d.id = v_b.day_id and s.id = 1;
    if public._day_booked(v_b.day_id) + v_b.party_size > v_cap then
      return json_build_object('ok', false, 'error', 'not_enough_seats');
    end if;
  end if;

  update public.bookings set status = p_status, updated_at = now() where id = p_id;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_set_note(p_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._assert_admin();
  update public.bookings set admin_note = nullif(btrim(p_note), ''), updated_at = now() where id = p_id;
end $$;

-- ---------- function permissions ------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on function public.get_availability()                       to anon, authenticated;
grant  execute on function public.create_booking(text, text, uuid, int, uuid) to anon, authenticated;
grant  execute on function public.is_admin()                               to authenticated;
grant  execute on function public.admin_dashboard()                        to authenticated;
grant  execute on function public.admin_update_settings(int, int, boolean) to authenticated;
grant  execute on function public.admin_update_day(text, boolean, int, boolean) to authenticated;
grant  execute on function public.admin_save_slot(uuid, text, text, boolean, int) to authenticated;
grant  execute on function public.admin_delete_slot(uuid)                 to authenticated;
grant  execute on function public.admin_set_booking_status(uuid, text)    to authenticated;
grant  execute on function public.admin_set_note(uuid, text)              to authenticated;

-- ---------- starting configuration (edit from the dashboard later) ---
insert into public.settings (id, capacity_per_day, max_party, booking_open)
values (1, 10, 9, true) on conflict (id) do nothing;

insert into public.days (id, label, event_date, sort) values
  ('wed', 'الأربعاء', '2026-11-11', 1),
  ('thu', 'الخميس',  '2026-11-12', 2),
  ('fri', 'الجمعة',  '2026-11-13', 3)
on conflict (id) do nothing;

insert into public.time_slots (starts_at, ends_at, sort)
select * from (values ('06:00'::time, '07:00'::time, 1),
                      ('07:00'::time, '08:00'::time, 2),
                      ('08:00'::time, '09:00'::time, 3)) v
where not exists (select 1 from public.time_slots);

-- ---------- make yourself an admin ----------------------------------
-- 1) Authentication → Users → Add user (email + password)
-- 2) Run, with that email:
--    insert into public.admins (user_id)
--    select id from auth.users where email = 'YOUR-EMAIL' on conflict do nothing;
