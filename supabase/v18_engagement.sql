-- GeoFS Copilot 1.8: daily challenge, streaks, weekly landing contest, airport passport, airlines

alter table public.pilots
  add column if not exists streak int not null default 0,
  add column if not exists best_streak int not null default 0,
  add column if not exists streak_day date,
  add column if not exists countries int not null default 0,
  add column if not exists airports int not null default 0;

alter table public.flights
  add column if not exists streak_bonus int not null default 0;

-- pașaport: aeroporturile vizitate
create table if not exists public.visits (
  pilot_id uuid not null references public.pilots(id) on delete cascade,
  icao text not null,
  country text,
  lat numeric,
  lon numeric,
  first_at timestamptz not null default now(),
  n int not null default 1,
  primary key (pilot_id, icao)
);
alter table public.visits enable row level security;

-- provocarea zilei
create table if not exists public.challenge_airports (
  idx int primary key,
  icao text not null,
  rwy text not null,
  light_only boolean not null default false
);
alter table public.challenge_airports enable row level security;

insert into public.challenge_airports(idx, icao, rwy, light_only) values
 (0,'LOWI','26',false),(1,'LXGB','27',false),(2,'LPMA','05',false),(3,'TNCM','10',false),(4,'LFLJ','22',true),
 (5,'VQPR','15',false),(6,'VNLK','06',true),(7,'NZQN','05',false),(8,'EGLC','27',false),(9,'LSGS','25',false),
 (10,'LGSK','01',false),(11,'TNCS','12',true),(12,'KASE','15',false),(13,'PAJN','08',false),(14,'TFFJ','10',true),
 (15,'LPHR','10',false),(16,'EKVG','30',false),(17,'LSZA','01',false),(18,'SBRJ','20R',false),(19,'KJAC','19',false),
 (20,'KDCA','19',false),(21,'KSAN','27',false),(22,'LOWS','15',false),(23,'EGPI','30',false),(24,'LDDU','11',false),
 (25,'LEMH','01',false),(26,'ENSB','27',false),(27,'NTAA','04',false),(28,'RJTT','34L',false),(29,'KSFO','28R',false),
 (30,'LIEO','23',false),(31,'SKBO','14L',false)
on conflict (idx) do update set icao = excluded.icao, rwy = excluded.rwy, light_only = excluded.light_only;

create table if not exists public.daily_results (
  day date not null,
  pilot_id uuid not null references public.pilots(id) on delete cascade,
  icao text not null,
  score int not null,
  vs int,
  g numeric,
  cl_m numeric,
  tdz_m int,
  aircraft text,
  attempts int not null default 1,
  xp int not null default 0,
  created_at timestamptz not null default now(),
  primary key (day, pilot_id)
);
alter table public.daily_results enable row level security;
create index if not exists daily_results_day_score on public.daily_results(day, score desc);
create index if not exists flights_created_score on public.flights(created_at, landing_score desc);

create or replace function public.utc_today() returns date language sql stable set search_path to '' as
$$ select (now() at time zone 'utc')::date $$;

create or replace function public.daily_for(p_day date) returns public.challenge_airports
language sql stable security definer set search_path to '' as $$
  select c.* from public.challenge_airports c
  where c.idx = ((p_day - date '2026-01-01') % (select count(*) from public.challenge_airports))::int
$$;

-- XP total = zboruri + realizări + provocări zilnice
create or replace function public.recompute_pilot(p_id uuid) returns void
language sql security definer set search_path to '' as $function$
  update public.pilots p set
    flights = s.n, hours = s.h, nm = s.nm, missions = s.m, earned = s.e,
    xp = s.xp + (select count(*) * 50 from public.pilot_achievements a where a.pilot_id = p_id)
       + (select coalesce(sum(d.xp), 0) from public.daily_results d where d.pilot_id = p_id),
    best_landing_fpm = s.bl, best_score = s.bs, butter_count = s.bc,
    achievements = (select count(*) from public.pilot_achievements a where a.pilot_id = p_id and a.code not like 'lesson_%'),
    last_flight_at = s.lf,
    countries = (select count(distinct country) from public.visits v where v.pilot_id = p_id and v.country is not null),
    airports = (select count(*) from public.visits v where v.pilot_id = p_id)
  from (select count(*) n, coalesce(sum(duration_min) / 60.0, 0) h, coalesce(sum(dist_nm), 0) nm,
          count(*) filter (where mission_result = 'ok') m, coalesce(sum(mission_pay), 0) e, coalesce(sum(xp), 0) xp,
          min(abs(landing_vs)) bl, max(landing_score) bs, count(*) filter (where abs(landing_vs) <= 150) bc, max(created_at) lf
        from public.flights where pilot_id = p_id) s
  where p.id = p_id;
$function$;

create or replace function public.add_visit(p_pilot uuid, p_icao text, p_country text, p_lat numeric, p_lon numeric) returns void
language plpgsql security definer set search_path to '' as $$
begin
  if p_icao is null or p_icao !~ '^[A-Z0-9-]{2,8}$' then return; end if;
  if p_country is not null and p_country !~ '^[A-Z]{2}$' then p_country := null; end if;
  if p_lat is not null and (abs(p_lat) > 90 or abs(coalesce(p_lon, 0)) > 180) then p_lat := null; p_lon := null; end if;
  insert into public.visits(pilot_id, icao, country, lat, lon) values (p_pilot, p_icao, p_country, round(p_lat, 4), round(p_lon, 4))
  on conflict (pilot_id, icao) do update set n = public.visits.n + 1,
    country = coalesce(public.visits.country, excluded.country), lat = coalesce(public.visits.lat, excluded.lat), lon = coalesce(public.visits.lon, excluded.lon);
end $$;

create or replace function public.submit_flight(p_key text, p_callsign text, p_flight jsonb, p_achievements text[] default '{}'::text[])
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_hash text;
  v_pilot public.pilots%rowtype;
  v_dist numeric := coalesce((p_flight->>'dist_nm')::numeric, 0);
  v_dur numeric := coalesce((p_flight->>'duration_min')::numeric, 0);
  v_vs int := (p_flight->>'landing_vs')::int;
  v_score int := (p_flight->>'landing_score')::int;
  v_pay int := coalesce((p_flight->>'mission_pay')::int, 0);
  v_result text := left(p_flight->>'mission_result', 12);
  v_xp int := 0;
  v_bonus int := 0;
  v_new_ach int := 0;
  v_today date := public.utc_today();
  v_streak int;
  v_callsign text := left(regexp_replace(coalesce(nullif(trim(p_callsign), ''), 'Pilot'), '[<>"''&]', '', 'g'), 30);
  v_allowed text[] := array['first_flight','butter','butter5','precision','explorer10','explorer25','long_haul','missions10','missions50','rich100k','hero','deadstick','school','captain','smooth10',
    'lesson_takeoff','lesson_handling','lesson_landing','lesson_engine_out','lesson_precision',
    'countries5','countries15','countries30','airports50','streak7','streak30','daily','daily_top3','airline','fleet5','bush_pilot','tour_guide','sar_hero','skydive','surveyor'];
  v_code text;
  v_week date;
begin
  if p_key is null or length(p_key) < 24 or length(p_key) > 128 then raise exception 'invalid key'; end if;
  if v_dur < 1 or v_dur > 1440 then raise exception 'invalid duration'; end if;
  if v_dist < 0 or v_dist > (v_dur / 60.0) * 700 + 30 then raise exception 'distance not plausible'; end if;
  if v_score is not null and (v_score < 0 or v_score > 100) then raise exception 'invalid score'; end if;
  if v_vs is not null and (v_vs > 500 or v_vs < -6000) then raise exception 'invalid landing rate'; end if;
  if v_pay < 0 or v_pay > 2000 + v_dist * 60 then raise exception 'pay not plausible'; end if;

  v_hash := encode(extensions.digest(p_key, 'sha256'), 'hex');
  select * into v_pilot from public.pilots where key_hash = v_hash;
  if not found then
    insert into public.pilots(key_hash, callsign) values (v_hash, v_callsign) returning * into v_pilot;
  end if;
  if v_pilot.last_flight_at is not null and now() - v_pilot.last_flight_at < make_interval(secs => greatest(45, v_dur * 60 * 0.8)) then
    raise exception 'too soon after previous flight';
  end if;

  v_xp := least(400, round(v_pay / 50.0)::int
    + case when v_score is not null then v_score / 5 else 0 end
    + case when v_pay = 0 then least(60, (v_dur / 3)::int) else 0 end);

  -- serie de zile: primul zbor al zilei (UTC) primește bonus
  v_streak := v_pilot.streak;
  if v_pilot.streak_day is distinct from v_today then
    v_streak := case when v_pilot.streak_day = v_today - 1 then v_pilot.streak + 1 else 1 end;
    v_bonus := 10 * least(v_streak, 7);
  end if;

  insert into public.flights(pilot_id, aircraft, dep, arr, dist_nm, duration_min, fuel_kg, landing_vs, landing_g, landing_score, cl_m, tdz_m,
    mission_type, mission_pay, mission_result, emergency, xp, streak_bonus)
  values (v_pilot.id, left(p_flight->>'aircraft', 40), left(upper(p_flight->>'dep'), 8), left(upper(p_flight->>'arr'), 8), v_dist, v_dur,
    (p_flight->>'fuel_kg')::int, v_vs, (p_flight->>'landing_g')::numeric, v_score, (p_flight->>'cl_m')::numeric, (p_flight->>'tdz_m')::int,
    left(p_flight->>'mission_type', 12), v_pay, v_result, left(p_flight->>'emergency', 20), v_xp + v_bonus, v_bonus);

  -- pașaport
  if p_flight->>'arr' is not null then
    perform public.add_visit(v_pilot.id, left(upper(p_flight->>'arr'), 8), upper(p_flight->>'arr_country'), (p_flight->>'arr_lat')::numeric, (p_flight->>'arr_lon')::numeric);
  end if;
  if p_flight->>'dep' is not null then
    perform public.add_visit(v_pilot.id, left(upper(p_flight->>'dep'), 8), upper(p_flight->>'dep_country'), (p_flight->>'dep_lat')::numeric, (p_flight->>'dep_lon')::numeric);
  end if;

  foreach v_code in array coalesce(p_achievements, '{}') loop
    if v_code = any(v_allowed) then
      insert into public.pilot_achievements(pilot_id, code) values (v_pilot.id, v_code) on conflict do nothing;
      if found then v_new_ach := v_new_ach + 1; end if;
    end if;
  end loop;

  -- podium la concursul de aterizare de săptămâna trecută
  v_week := date_trunc('week', now() at time zone 'utc')::date - 7;
  if exists (select 1 from (
      select f.pilot_id, row_number() over (order by max(f.landing_score) desc, min(abs(f.landing_vs))) rn
      from public.flights f where f.created_at >= v_week and f.created_at < v_week + 7 and f.landing_score is not null and f.tdz_m is not null
      group by f.pilot_id) t where t.pilot_id = v_pilot.id and t.rn <= 3) then
    insert into public.pilot_achievements(pilot_id, code) values (v_pilot.id, 'contest_podium') on conflict do nothing;
    if found then v_new_ach := v_new_ach + 1; end if;
  end if;

  update public.pilots set
    callsign = v_callsign,
    last_aircraft = left(p_flight->>'aircraft', 40),
    streak = v_streak, streak_day = v_today, best_streak = greatest(best_streak, v_streak)
  where id = v_pilot.id;
  perform public.recompute_pilot(v_pilot.id);
  select * into v_pilot from public.pilots where id = v_pilot.id;

  return jsonb_build_object('pilot_id', v_pilot.id, 'xp', v_pilot.xp, 'flight_xp', v_xp + v_bonus, 'new_achievements', v_new_ach,
    'streak', v_pilot.streak, 'best_streak', v_pilot.best_streak, 'streak_bonus', v_bonus, 'countries', v_pilot.countries, 'airports', v_pilot.airports,
    'rank_pos', (select count(*) + 1 from public.pilots p where p.xp > v_pilot.xp));
end;
$function$;

-- provocarea zilei: aeroportul + clasamentul zilei
create or replace function public.get_daily(p_day date default null, p_limit int default 20) returns jsonb
language sql stable security definer set search_path to '' as $$
  with d as (select coalesce(p_day, public.utc_today()) as day)
  select jsonb_build_object(
    'day', d.day, 'icao', c.icao, 'rwy', c.rwy, 'light_only', c.light_only,
    'tomorrow', (select jsonb_build_object('icao', t.icao, 'rwy', t.rwy) from public.daily_for(d.day + 1) t),
    'players', (select count(*) from public.daily_results r where r.day = d.day),
    'board', coalesce((select jsonb_agg(x) from (
       select row_number() over (order by r.score desc, abs(r.vs), r.created_at) pos, r.pilot_id, p.callsign, r.score, r.vs, r.g, r.cl_m, r.tdz_m, r.aircraft, r.attempts
       from public.daily_results r join public.pilots p on p.id = r.pilot_id where r.day = d.day
       order by r.score desc, abs(r.vs), r.created_at limit least(greatest(p_limit, 1), 100)) x), '[]'::jsonb))
  from d cross join lateral public.daily_for(d.day) c;
$$;

create or replace function public.submit_daily(p_key text, p_icao text, p_score int, p_vs int, p_g numeric, p_cl numeric, p_tdz int, p_aircraft text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_pilot public.pilots%rowtype;
  v_today date := public.utc_today();
  v_c public.challenge_airports%rowtype;
  v_old public.daily_results%rowtype;
  v_xp int;
  v_pos bigint;
begin
  select * into v_pilot from public.pilots where key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex');
  if not found then raise exception 'unknown pilot'; end if;
  select * into v_c from public.daily_for(v_today);
  if upper(p_icao) <> v_c.icao then raise exception 'not today''s airport'; end if;
  if p_score is null or p_score < 0 or p_score > 100 then raise exception 'invalid score'; end if;
  if p_vs is null or p_vs > 500 or p_vs < -6000 then raise exception 'invalid landing rate'; end if;
  v_xp := 30 + p_score / 4;
  select * into v_old from public.daily_results where day = v_today and pilot_id = v_pilot.id;
  if not found then
    insert into public.daily_results(day, pilot_id, icao, score, vs, g, cl_m, tdz_m, aircraft, xp)
    values (v_today, v_pilot.id, v_c.icao, p_score, p_vs, p_g, p_cl, p_tdz, left(p_aircraft, 40), v_xp);
  elsif p_score > v_old.score or (p_score = v_old.score and abs(p_vs) < abs(v_old.vs)) then
    update public.daily_results set score = p_score, vs = p_vs, g = p_g, cl_m = p_cl, tdz_m = p_tdz, aircraft = left(p_aircraft, 40),
      attempts = attempts + 1, xp = greatest(xp, v_xp), created_at = now()
    where day = v_today and pilot_id = v_pilot.id;
  else
    update public.daily_results set attempts = attempts + 1 where day = v_today and pilot_id = v_pilot.id;
  end if;
  perform public.recompute_pilot(v_pilot.id);
  select pos into v_pos from (select pilot_id, row_number() over (order by score desc, abs(vs), created_at) pos from public.daily_results where day = v_today) t where t.pilot_id = v_pilot.id;
  return jsonb_build_object('pos', v_pos, 'players', (select count(*) from public.daily_results where day = v_today),
    'best', (select to_jsonb(r) - 'pilot_id' from public.daily_results r where day = v_today and pilot_id = v_pilot.id),
    'xp', (select xp from public.pilots where id = v_pilot.id));
end $$;

-- concursul de aterizare: cea mai bună aterizare a fiecărui pilot în săptămâna (UTC, de luni)
create or replace function public.get_landing_contest(p_week_offset int default 0, p_limit int default 20) returns jsonb
language sql stable security definer set search_path to '' as $$
  with w as (select date_trunc('week', now() at time zone 'utc')::date - 7 * greatest(0, least(p_week_offset, 52)) s),
  best as (
    select distinct on (f.pilot_id) f.pilot_id, f.landing_score score, f.landing_vs vs, f.landing_g g, f.cl_m, f.tdz_m, f.arr, f.aircraft, f.created_at
    from public.flights f, w
    where f.created_at >= w.s and f.created_at < w.s + 7 and f.landing_score is not null and f.tdz_m is not null
    order by f.pilot_id, f.landing_score desc, abs(f.landing_vs), f.created_at)
  select jsonb_build_object('week_start', w.s, 'week_end', w.s + 6, 'players', (select count(*) from best),
    'board', coalesce((select jsonb_agg(x) from (
      select row_number() over (order by b.score desc, abs(b.vs), b.created_at) pos, b.pilot_id, p.callsign, b.score, b.vs, b.g, b.cl_m, b.tdz_m, b.arr, b.aircraft, b.created_at
      from best b join public.pilots p on p.id = b.pilot_id
      order by b.score desc, abs(b.vs), b.created_at limit least(greatest(p_limit, 1), 100)) x), '[]'::jsonb))
  from w;
$$;

-- clasament: + serie, țări, aeroporturi
drop function if exists public.get_leaderboard(text, integer);
create function public.get_leaderboard(p_sort text default 'xp', p_limit integer default 50)
returns table(pos bigint, id uuid, callsign text, xp integer, flights integer, hours numeric, nm numeric, missions integer, earned bigint,
  best_landing_fpm integer, best_score integer, butter_count integer, achievements integer, last_aircraft text, last_flight_at timestamptz,
  streak integer, best_streak integer, countries integer, airports integer)
language sql stable security definer set search_path to '' as $function$
  select row_number() over (order by
      case p_sort when 'earned' then p.earned::numeric when 'hours' then p.hours when 'missions' then p.missions::numeric
        when 'butter' then p.butter_count::numeric when 'nm' then p.nm when 'countries' then p.countries::numeric
        when 'airports' then p.airports::numeric when 'streak' then p.best_streak::numeric else p.xp::numeric end desc, p.created_at),
    p.id, p.callsign, p.xp, p.flights, p.hours, p.nm, p.missions, p.earned, p.best_landing_fpm, p.best_score, p.butter_count,
    p.achievements, p.last_aircraft, p.last_flight_at,
    case when p.streak_day >= public.utc_today() - 1 then p.streak else 0 end, p.best_streak, p.countries, p.airports
  from public.pilots p
  where p.flights > 0
  order by 1
  limit least(greatest(p_limit, 1), 200);
$function$;

-- compania aeriană (din progresul salvat în cloud), doar câmpurile publice, curățate
create or replace function public.airline_public(a jsonb) returns jsonb
language sql immutable set search_path to '' as $$
  select case when a is null or jsonb_typeof(a) <> 'object' or coalesce(a->>'name', '') = '' then null else jsonb_build_object(
    'name', left(regexp_replace(a->>'name', '[<>"''&]', '', 'g'), 30),
    'code', left(regexp_replace(upper(coalesce(a->>'code', '')), '[^A-Z0-9]', '', 'g'), 3),
    'hub', left(regexp_replace(upper(coalesce(a->>'hub', '')), '[^A-Z0-9-]', '', 'g'), 8),
    'fleet', case when jsonb_typeof(a->'fleet') = 'array' then jsonb_array_length(a->'fleet') else 0 end,
    'routes', case when jsonb_typeof(a->'fleet') = 'array' then (select count(*) from jsonb_array_elements(a->'fleet') e where coalesce(e->>'route', '') <> '') else 0 end,
    'value', least(coalesce((a->>'value')::numeric, 0), 1e9)::bigint,
    'earned', least(coalesce((a->>'earned')::numeric, 0), 1e10)::bigint,
    'rep', least(greatest(coalesce((a->>'rep')::numeric, 50), 0), 100)::int,
    'founded', a->>'founded') end
$$;

-- profil pilot: + pașaport, provocări, companie
create or replace function public.get_pilot(p_id uuid) returns jsonb
language sql stable security definer set search_path to '' as $function$
  select jsonb_build_object(
    'pilot', (select to_jsonb(x) - 'key_hash' - 'state' - 'state_at' - 'geofs_id'
       || jsonb_build_object('streak', case when x.streak_day >= public.utc_today() - 1 then x.streak else 0 end) from public.pilots x where x.id = p_id),
    'rank_pos', (select count(*) + 1 from public.pilots p where p.xp > (select xp from public.pilots where id = p_id)),
    'flights', coalesce((select jsonb_agg(to_jsonb(f) - 'pilot_id' order by f.created_at desc) from
       (select * from public.flights where pilot_id = p_id order by created_at desc limit 30) f), '[]'::jsonb),
    'achievements', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'at', created_at) order by created_at)
       from public.pilot_achievements where pilot_id = p_id), '[]'::jsonb),
    'visits', coalesce((select jsonb_agg(jsonb_build_object('icao', icao, 'country', country, 'lat', lat, 'lon', lon, 'n', n, 'first', first_at) order by first_at)
       from public.visits where pilot_id = p_id), '[]'::jsonb),
    'dailies', coalesce((select jsonb_agg(to_jsonb(d) - 'pilot_id' order by d.day desc) from
       (select * from public.daily_results where pilot_id = p_id order by day desc limit 14) d), '[]'::jsonb),
    'airline', (select public.airline_public(x.state->'airline') from public.pilots x where x.id = p_id));
$function$;

create or replace function public.get_airlines(p_limit int default 50) returns jsonb
language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(x order by (x->>'value')::bigint desc), '[]'::jsonb) from (
    select public.airline_public(p.state->'airline') || jsonb_build_object('pilot_id', p.id, 'callsign', p.callsign) x
    from public.pilots p where p.state ? 'airline' and public.airline_public(p.state->'airline') is not null
    order by (public.airline_public(p.state->'airline')->>'value')::bigint desc
    limit least(greatest(p_limit, 1), 200)) t;
$$;

create or replace function public.get_stats() returns jsonb
language sql stable security definer set search_path to '' as $function$
  select jsonb_build_object(
    'pilots', (select count(*) from public.pilots where flights > 0),
    'flights', (select count(*) from public.flights),
    'hours', (select coalesce(round(sum(duration_min) / 60.0, 1), 0) from public.flights),
    'nm', (select coalesce(round(sum(dist_nm)), 0) from public.flights),
    'missions', (select count(*) from public.flights where mission_result = 'ok'),
    'earned', (select coalesce(sum(mission_pay), 0) from public.flights),
    'flights_24h', (select count(*) from public.flights where created_at > now() - interval '24 hours'),
    'countries', (select count(distinct country) from public.visits),
    'airports', (select count(distinct icao) from public.visits),
    'airlines', (select count(*) from public.pilots where state ? 'airline'),
    'top_airports', coalesce((select jsonb_agg(t) from (select arr as airport, count(*) as n from public.flights where arr is not null
       group by arr order by n desc limit 8) t), '[]'::jsonb));
$function$;

-- zboruri vechi intră și ele în pașaport (fără coordonate/țară; se completează la următoarea vizită)
insert into public.visits(pilot_id, icao, first_at, n)
select pilot_id, ap, min(created_at), count(*) from (
  select pilot_id, arr ap, created_at from public.flights where arr is not null and arr ~ '^[A-Z0-9-]{2,8}$'
  union all select pilot_id, dep, created_at from public.flights where dep is not null and dep ~ '^[A-Z0-9-]{2,8}$') s
group by pilot_id, ap
on conflict do nothing;

update public.pilots set airports = (select count(*) from public.visits v where v.pilot_id = pilots.id);

-- funcțiile publice: doar prin RPC
revoke all on function public.add_visit(uuid, text, text, numeric, numeric) from public, anon, authenticated;
revoke all on function public.recompute_pilot(uuid) from public, anon, authenticated;
grant execute on function public.get_daily(date, int), public.submit_daily(text, text, int, int, numeric, numeric, int, text),
  public.get_landing_contest(int, int), public.get_leaderboard(text, integer), public.get_airlines(int), public.get_pilot(uuid), public.get_stats()
  to anon, authenticated;
