create or replace function public.get_calendar_availability(p_month date)
returns json language sql stable security definer set search_path = public as $$
  with s as (select * from public.settings where id=1),
  dates as (select d as event_date from (values ('2026-11-12'::date),('2026-11-13'::date),('2026-11-14'::date)) v(d) where date_trunc('month',d)=date_trunc('month',coalesce(p_month,'2026-11-01'::date))),
  days as (
    select coalesce(d.id,dt.event_date::text) id,
      case extract(isodow from dt.event_date) when 4 then 'الخميس' when 5 then 'الجمعة' else 'السبت' end label,
      dt.event_date,coalesce(d.is_open,true) and dt.event_date >= (now() at time zone 'Asia/Riyadh')::date is_open,
      coalesce(d.capacity_override,s.capacity_per_day) capacity,
      coalesce(d.capacity_override,s.capacity_per_day)-coalesce(b.booked,0) remaining,
      coalesce(b.booked,0) booked,coalesce(b.bookings,0) bookings,d.capacity_override
    from dates dt cross join s left join public.days d on d.event_date=dt.event_date
    left join lateral(select sum(party_size)::int booked,count(*)::int bookings from public.bookings where day_id=d.id and status<>'cancelled') b on true
  ) select json_build_object('open',(select booking_open from s),'max_party',(select max_party from s),
    'days',coalesce((select json_agg(json_build_object('id',id,'label',label,'event_date',event_date,'is_open',is_open,'capacity',capacity,'capacity_override',capacity_override,'remaining',greatest(remaining,0),'booked',booked,'bookings',bookings,'available',is_open and remaining>0) order by event_date) from days),'[]'::json),
    'slots',coalesce((select json_agg(json_build_object('id',id,'starts_at',to_char(starts_at,'HH24:MI'),'ends_at',to_char(ends_at,'HH24:MI')) order by starts_at) from public.time_slots where is_active),'[]'::json));
$$;
create or replace function public.create_booking(
  p_name text, p_day text, p_slot uuid, p_party int, p_token uuid)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  v_s     public.settings;
  v_d     public.days;
  v_slot  public.time_slots;
  v_date  date;
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

  select event_date into v_date from public.days where id = p_day;
  if not found then
    if p_day !~ '^\d{4}-\d{2}-\d{2}$' then
      return json_build_object('ok', false, 'error', 'invalid_day');
    end if;
    begin v_date := p_day::date;
    exception when datetime_field_overflow or invalid_datetime_format then
      return json_build_object('ok', false, 'error', 'invalid_day');
    end;
    if v_date not between '2026-11-12'::date and '2026-11-14'::date or v_date < (now() at time zone 'Asia/Riyadh')::date then
      return json_build_object('ok', false, 'error', 'invalid_day');
    end if;
    insert into public.days(id,label,event_date,sort)
    values(p_day,case extract(isodow from v_date) when 4 then 'الخميس' when 5 then 'الجمعة' else 'السبت' end,v_date,extract(isodow from v_date)::smallint)
    on conflict(id) do nothing;
  end if;
  if v_date < (now() at time zone 'Asia/Riyadh')::date or v_date not between '2026-11-12'::date and '2026-11-14'::date then
    return json_build_object('ok', false, 'error', 'invalid_day');
  end if;
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
insert into public.days(id,label,event_date,sort,is_open) select '2026-11-14','السبت','2026-11-14'::date,6,true where not exists(select 1 from public.days where event_date='2026-11-14'::date);
update public.days set is_open=(event_date between '2026-11-12'::date and '2026-11-14'::date);
