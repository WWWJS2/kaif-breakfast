begin;
alter table public.bookings add column if not exists guest_phone text check (guest_phone is null or guest_phone ~ '^\+?[0-9]{8,15}$');
create or replace function public.create_booking_with_phone(p_name text,p_phone text,p_day text,p_slot uuid,p_party int,p_token uuid)
returns json language plpgsql volatile security definer set search_path=public as $$
declare v_phone text; v_result json;
begin
 v_phone := regexp_replace(translate(coalesce(p_phone,''),'٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'),'[[:space:]()-]','','g');
 if v_phone !~ '^\+?[0-9]{8,15}$' then return json_build_object('ok',false,'error','invalid_phone'); end if;
 v_result := public.create_booking(p_name,p_day,p_slot,p_party,p_token);
 if (v_result->>'ok')::boolean and not coalesce((v_result->>'duplicate')::boolean,false) then
   update public.bookings set guest_phone=v_phone where id=(v_result->'booking'->>'id')::uuid;
 end if;
 return v_result;
end $$;
revoke all on function public.create_booking_with_phone(text,text,text,uuid,int,uuid) from public,anon,authenticated;
grant execute on function public.create_booking_with_phone(text,text,text,uuid,int,uuid) to anon,authenticated;

create or replace function public.get_calendar_availability(p_month date)
returns json language sql stable security definer set search_path = public as $$
  with s as (select * from public.settings where id=1),
  dates as (select g::date as event_date from generate_series(date_trunc('month',coalesce(p_month,(now() at time zone 'Asia/Riyadh')::date)), date_trunc('month',coalesce(p_month,(now() at time zone 'Asia/Riyadh')::date)) + interval '1 month - 1 day',interval '1 day') g where extract(isodow from g) in (3,4,5)),
  days as (
    select coalesce(d.id,dt.event_date::text) id,
      case extract(isodow from dt.event_date) when 3 then 'الأربعاء' when 4 then 'الخميس' else 'الجمعة' end label,
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
revoke all on function public.get_calendar_availability(date) from public,anon,authenticated;
grant execute on function public.get_calendar_availability(date) to anon,authenticated;
create or replace function public.get_availability()
returns json language sql stable security definer set search_path=public as $$
 select public.get_calendar_availability((now() at time zone 'Asia/Riyadh')::date);
$$;
create or replace function public.admin_calendar(p_month date)
returns json language plpgsql stable security definer set search_path=public as $$
begin
 perform public._assert_admin();
 return public.get_calendar_availability(p_month);
end $$;
revoke all on function public.admin_calendar(date) from public,anon,authenticated;
grant execute on function public.admin_calendar(date) to authenticated;

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
    if extract(isodow from v_date) not in (3,4,5) or v_date < (now() at time zone 'Asia/Riyadh')::date then
      return json_build_object('ok', false, 'error', 'invalid_day');
    end if;
    insert into public.days(id,label,event_date,sort)
    values(p_day,case extract(isodow from v_date) when 3 then 'الأربعاء' when 4 then 'الخميس' else 'الجمعة' end,v_date,extract(isodow from v_date)::smallint)
    on conflict(id) do nothing;
  end if;
  if v_date < (now() at time zone 'Asia/Riyadh')::date or extract(isodow from v_date) not in (3,4,5) then
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
create or replace function public.admin_update_day(
  p_id text, p_is_open boolean default null, p_capacity_override int default null, p_clear_override boolean default false)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._assert_admin();
  if not exists(select 1 from public.days where id=p_id) then
    if p_id !~ '^\d{4}-\d{2}-\d{2}$' or extract(isodow from p_id::date) not in (3,4,5) then raise exception 'invalid_day'; end if;
    insert into public.days(id,label,event_date,sort) values(p_id,case extract(isodow from p_id::date) when 3 then 'الأربعاء' when 4 then 'الخميس' else 'الجمعة' end,p_id::date,extract(isodow from p_id::date)::smallint) on conflict(id) do nothing;
  end if;
  update public.days set
    is_open = coalesce(p_is_open, is_open),
    capacity_override = case when p_clear_override then null
                             else coalesce(p_capacity_override, capacity_override) end
  where id = p_id;
end $$;
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
        'id', b.id, 'guest_name', b.guest_name, 'guest_phone', b.guest_phone, 'day_id', b.day_id, 'party_size', b.party_size,
        'starts_at', to_char(b.slot_start,'HH24:MI'), 'ends_at', to_char(b.slot_end,'HH24:MI'),
        'status', b.status, 'admin_note', b.admin_note, 'created_at', b.created_at
      ) order by b.created_at desc) from public.bookings b), '[]'::json)
  ) into v;
  return v;
end $$;
update public.time_slots set is_active=false;
insert into public.time_slots(starts_at,ends_at,sort,is_active)
select t,t+interval '30 minutes',row_number() over(order by t)::smallint,true
from (values('06:00'::time),('06:30'::time),('07:00'::time),('07:30'::time),('08:00'::time),('08:30'::time)) v(t);

notify pgrst,'reload schema';
commit;
