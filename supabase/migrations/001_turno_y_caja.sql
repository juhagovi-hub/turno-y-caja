-- =====================================================================
-- Turno y Caja — esquema v1 para Supabase (Postgres)
-- Principios:
--   * Toda escritura pasa por funciones (RPC) que validan permisos y
--     estados dentro de una transacción. Nadie escribe tablas directo.
--   * Lectura protegida por RLS: solo miembros del negocio.
--   * La pantalla pública solo ve public_board(): turno + primer nombre.
--   * Las ventas guardan copia del servicio y el precio del momento.
--   * Nada se borra: retiros y anulaciones quedan con motivo y rastro.
-- =====================================================================

-- ---------- Tablas ----------
create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  name text not null,
  timezone text not null default 'America/Bogota',
  created_at timestamptz not null default now()
);

create table public.members (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','barber')),
  display_name text not null default '',
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);

create table public.member_invites (
  business_id uuid not null references public.businesses(id) on delete cascade,
  email text not null check (email = lower(email) and position('@' in email) > 1),
  role text not null check (role in ('owner','admin','barber')),
  display_name text not null default '',
  created_at timestamptz not null default now(),
  primary key (business_id, email)
);

create table public.barbers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  user_id uuid references auth.users(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  identifier text check (identifier is null or identifier ~ '^[0-9]{6,15}$'),
  name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, identifier)
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  description text not null default '',
  price integer not null check (price > 0),
  duration_min integer check (duration_min is null or duration_min between 1 and 600),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index services_name_uq on public.services (business_id, lower(name));

create table public.turns (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  local_date date not null,
  turn_number integer not null check (turn_number > 0),
  client_id uuid references public.clients(id) on delete set null,
  display_name text not null default '',
  client_type text not null default 'sin_id' check (client_type in ('nuevo','recurrente','sin_id')),
  status text not null default 'esperando' check (status in ('esperando','atendiendo','finalizado','retirado','ausente')),
  barber_id uuid references public.barbers(id) on delete set null,
  arrived_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  retire_reason text,
  created_by uuid,
  unique (business_id, local_date, turn_number)
);
create index turns_active_idx on public.turns (business_id, status) where status in ('esperando','atendiendo');

create table public.turn_counters (
  business_id uuid not null references public.businesses(id) on delete cascade,
  local_date date not null,
  next_number integer not null,
  primary key (business_id, local_date)
);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  turn_id uuid unique references public.turns(id),
  legacy_id text unique,
  client_id uuid references public.clients(id) on delete set null,
  client_name text not null default '',
  client_type text not null check (client_type in ('nuevo','recurrente','sin_id')),
  barber_id uuid references public.barbers(id) on delete set null,
  service_id uuid references public.services(id) on delete set null,
  service_name text not null,
  list_price integer not null check (list_price > 0),
  discount integer not null default 0,
  amount integer not null,
  tip integer not null default 0 check (tip >= 0),
  status text not null default 'valida' check (status in ('valida','anulada')),
  void_reason text,
  voided_at timestamptz,
  voided_by uuid,
  arrived_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz not null default now(),
  local_date date not null,
  local_hour smallint not null check (local_hour between 0 and 23),
  local_dow smallint not null check (local_dow between 0 and 6), -- 0 = domingo
  created_by uuid,
  constraint sales_discount_ok check (discount >= 0 and discount <= list_price),
  constraint sales_amount_ok check (amount = list_price - discount),
  constraint sales_void_ok check ((status = 'anulada') = (void_reason is not null))
);
create index sales_date_idx on public.sales (business_id, local_date);
create index sales_client_idx on public.sales (business_id, client_id);

create table public.sale_payments (
  id bigint generated always as identity primary key,
  sale_id uuid not null references public.sales(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  method text not null check (method in ('efectivo','tarjeta','transferencia')),
  amount integer not null check (amount >= 0)
);
create index sale_payments_sale_idx on public.sale_payments (sale_id);

create table public.audit_log (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  at timestamptz not null default now(),
  user_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  reason text not null default ''
);
create index audit_business_idx on public.audit_log (business_id, at desc);

-- ---------- Permisos ----------
create function public.my_role(b uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where business_id = b and user_id = auth.uid()
$$;
create function public.is_member(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role(b) is not null
$$;
create function public.is_admin(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role(b) in ('owner','admin'), false)
$$;

create function public._require(b uuid, admin_only boolean) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión.' using errcode = '28000';
  end if;
  if not public.is_member(b) then
    raise exception 'No tienes acceso a este negocio.' using errcode = '42501';
  end if;
  if admin_only and not public.is_admin(b) then
    raise exception 'Solo un administrador puede hacer esto.' using errcode = '42501';
  end if;
end $$;

create function public._audit(b uuid, p_action text, p_entity text, p_entity_id text, p_before jsonb, p_after jsonb, p_reason text)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_log (business_id, user_id, action, entity, entity_id, before, after, reason)
  values (b, auth.uid(), p_action, p_entity, p_entity_id, p_before, p_after, coalesce(p_reason, ''))
$$;

create function public._lock_business(b uuid) returns void
language sql set search_path = public as $$ select pg_advisory_xact_lock(hashtext('tyc:' || b::text)) $$;

create function public.first_name(n text) returns text
language sql immutable set search_path = public as $$
  select coalesce(nullif(initcap(split_part(trim(coalesce(n, '')), ' ', 1)), ''), 'Cliente')
$$;

-- ---------- RLS: lectura solo para miembros; sin escrituras directas ----------
alter table public.businesses enable row level security;
alter table public.members enable row level security;
alter table public.member_invites enable row level security;
alter table public.barbers enable row level security;
alter table public.clients enable row level security;
alter table public.services enable row level security;
alter table public.turns enable row level security;
alter table public.turn_counters enable row level security;
alter table public.sales enable row level security;
alter table public.sale_payments enable row level security;
alter table public.audit_log enable row level security;

create policy businesses_read on public.businesses for select to authenticated using (public.is_member(id));
create policy members_read on public.members for select to authenticated using (public.is_member(business_id));
create policy invites_read on public.member_invites for select to authenticated using (public.is_admin(business_id));
create policy barbers_read on public.barbers for select to authenticated using (public.is_member(business_id));
create policy clients_read on public.clients for select to authenticated using (public.is_member(business_id));
create policy services_read on public.services for select to authenticated using (public.is_member(business_id));
create policy turns_read on public.turns for select to authenticated using (public.is_member(business_id));
create policy sales_read on public.sales for select to authenticated using (public.is_member(business_id));
create policy payments_read on public.sale_payments for select to authenticated using (public.is_member(business_id));
create policy audit_read on public.audit_log for select to authenticated using (public.is_admin(business_id));

revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;

-- ---------- Alta de usuarios: solo correos invitados obtienen acceso ----------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.members (business_id, user_id, role, display_name)
  select i.business_id, new.id, i.role, i.display_name
  from public.member_invites i where i.email = lower(new.email)
  on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.invite_member(p_business uuid, p_email text, p_role text, p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(p_email)); v_user uuid;
begin
  perform public._require(p_business, true);
  if p_role not in ('admin','barber') then
    raise exception 'Rol no válido.' using errcode = '22023';
  end if;
  insert into public.member_invites (business_id, email, role, display_name)
  values (p_business, v_email, p_role, coalesce(trim(p_name), ''))
  on conflict (business_id, email) do update set role = excluded.role, display_name = excluded.display_name;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is not null then
    insert into public.members (business_id, user_id, role, display_name)
    values (p_business, v_user, p_role, coalesce(trim(p_name), ''))
    on conflict (business_id, user_id) do update set role = excluded.role;
  end if;
  perform public._audit(p_business, 'miembro_invitado', 'miembro', v_email, null, jsonb_build_object('role', p_role), '');
end $$;

-- ---------- Turnos ----------
create function public.add_turn(p_business uuid, p_name text, p_identifier text)
returns public.turns language plpgsql security definer set search_path = public as $$
declare
  v_name text := coalesce(trim(p_name), '');
  v_ident text := nullif(regexp_replace(coalesce(p_identifier, ''), '[^0-9]', '', 'g'), '');
  v_tz text; v_date date; v_num integer; v_max integer; v_client uuid; v_client_name text; v_type text := 'sin_id';
  r public.turns;
begin
  perform public._require(p_business, false);
  if v_name = '' and v_ident is null then
    raise exception 'Escribe al menos el nombre o el celular.' using errcode = '22023';
  end if;
  if v_ident is not null and length(v_ident) not between 6 and 15 then
    raise exception 'El celular o la cédula parece incompleto.' using errcode = '22023';
  end if;
  if length(v_name) > 80 then
    raise exception 'El nombre es demasiado largo.' using errcode = '22023';
  end if;
  select timezone into v_tz from public.businesses where id = p_business;
  v_date := (now() at time zone v_tz)::date;

  if v_ident is not null then
    insert into public.clients (business_id, identifier, name)
    values (p_business, v_ident, v_name)
    on conflict (business_id, identifier) do update
      set name = case when public.clients.name = '' then excluded.name else public.clients.name end,
          updated_at = now()
    returning id, name into v_client, v_client_name;
    if v_name = '' then v_name := v_client_name; end if;
    v_type := case when exists (select 1 from public.sales where client_id = v_client and status = 'valida')
                   then 'recurrente' else 'nuevo' end;
  end if;

  perform public._lock_business(p_business);
  insert into public.turn_counters (business_id, local_date, next_number)
  values (p_business, v_date, 2)
  on conflict (business_id, local_date) do update set next_number = public.turn_counters.next_number + 1
  returning next_number - 1 into v_num;
  -- Si hay turnos restaurados de un respaldo, nunca repetir un número del día.
  select coalesce(max(turn_number), 0) + 1 into v_max from public.turns where business_id = p_business and local_date = v_date;
  if v_num < v_max then
    v_num := v_max;
    update public.turn_counters set next_number = v_max + 1 where business_id = p_business and local_date = v_date;
  end if;

  insert into public.turns (business_id, local_date, turn_number, client_id, display_name, client_type, created_by)
  values (p_business, v_date, v_num, v_client, v_name, v_type, auth.uid())
  returning * into r;
  return r;
end $$;

create function public.start_turn(p_turn uuid) returns public.turns
language plpgsql security definer set search_path = public as $$
declare r public.turns;
begin
  select * into r from public.turns where id = p_turn;
  if not found then raise exception 'Turno no encontrado.' using errcode = 'P0002'; end if;
  perform public._require(r.business_id, false);
  perform public._lock_business(r.business_id);
  select * into r from public.turns where id = p_turn for update;
  if r.status <> 'esperando' then
    raise exception 'Ese turno ya cambió de estado. La fila se actualizó.' using errcode = '55000';
  end if;
  if exists (select 1 from public.turns t where t.business_id = r.business_id and t.status = 'atendiendo'
             and t.barber_id is not distinct from r.barber_id and t.id <> r.id) then
    raise exception 'Ya hay un turno en atención. Cóbralo o devuélvelo a la fila primero.' using errcode = '55000';
  end if;
  update public.turns set status = 'atendiendo', started_at = now() where id = p_turn returning * into r;
  return r;
end $$;

create function public.back_to_waiting(p_turn uuid) returns public.turns
language plpgsql security definer set search_path = public as $$
declare r public.turns;
begin
  select * into r from public.turns where id = p_turn;
  if not found then raise exception 'Turno no encontrado.' using errcode = 'P0002'; end if;
  perform public._require(r.business_id, false);
  perform public._lock_business(r.business_id);
  select * into r from public.turns where id = p_turn for update;
  if r.status <> 'atendiendo' then
    raise exception 'Ese turno no está en atención.' using errcode = '55000';
  end if;
  update public.turns set status = 'esperando', started_at = null where id = p_turn returning * into r;
  return r;
end $$;

create function public.retire_turn(p_turn uuid, p_kind text) returns public.turns
language plpgsql security definer set search_path = public as $$
declare r public.turns; v_reason text;
begin
  if p_kind not in ('retirado','ausente') then
    raise exception 'Motivo no válido.' using errcode = '22023';
  end if;
  select * into r from public.turns where id = p_turn;
  if not found then raise exception 'Turno no encontrado.' using errcode = 'P0002'; end if;
  perform public._require(r.business_id, false);
  perform public._lock_business(r.business_id);
  select * into r from public.turns where id = p_turn for update;
  if r.status not in ('esperando','atendiendo') then
    raise exception 'Ese turno ya fue cerrado.' using errcode = '55000';
  end if;
  v_reason := case p_kind when 'ausente' then 'No estaba presente al llamarlo' else 'Se retiró sin atenderse' end;
  update public.turns set status = p_kind, ended_at = now(), retire_reason = v_reason where id = p_turn returning * into r;
  perform public._audit(r.business_id, 'turno_' || p_kind, 'turno', r.id::text,
    jsonb_build_object('turn', r.turn_number), jsonb_build_object('status', p_kind), v_reason);
  return r;
end $$;

-- ---------- Cobro (idempotente: un turno = una venta como máximo) ----------
create function public.checkout(
  p_turn uuid, p_service uuid, p_custom_name text, p_custom_price integer,
  p_discount integer, p_tip integer, p_method text
) returns public.sales
language plpgsql security definer set search_path = public as $$
declare
  t public.turns; s public.sales; v_svc public.services;
  v_list integer; v_name text; v_tz text; v_now timestamptz := now(); v_local timestamp; v_type text;
  v_discount integer := coalesce(p_discount, 0); v_tip integer := coalesce(p_tip, 0);
begin
  select * into t from public.turns where id = p_turn;
  if not found then raise exception 'Turno no encontrado.' using errcode = 'P0002'; end if;
  perform public._require(t.business_id, false);
  perform public._lock_business(t.business_id);
  select * into t from public.turns where id = p_turn for update;

  select * into s from public.sales where turn_id = p_turn;
  if found then return s; end if; -- ya cobrado: devuelve la misma venta, no crea otra

  if t.status <> 'atendiendo' then
    raise exception 'Este turno no está en atención. La fila se actualizó.' using errcode = '55000';
  end if;
  if p_method is null or p_method not in ('efectivo','tarjeta','transferencia') then
    raise exception 'Elige cómo pagó el cliente.' using errcode = '22023';
  end if;
  if p_service is not null then
    select * into v_svc from public.services where id = p_service and business_id = t.business_id;
    if not found or not v_svc.active then
      raise exception 'Ese servicio no existe o está desactivado.' using errcode = '22023';
    end if;
    v_list := v_svc.price; v_name := v_svc.name;
  else
    v_list := p_custom_price; v_name := coalesce(nullif(trim(p_custom_name), ''), 'Otro servicio');
  end if;
  if v_list is null or v_list <= 0 then
    raise exception 'El precio debe ser mayor que cero.' using errcode = '22023';
  end if;
  if v_discount < 0 or v_tip < 0 then
    raise exception 'El descuento y la propina no pueden ser negativos.' using errcode = '22023';
  end if;
  if v_discount > v_list then
    raise exception 'El descuento no puede ser mayor que el precio.' using errcode = '22023';
  end if;

  v_type := case
    when t.client_id is null then 'sin_id'
    when exists (select 1 from public.sales where client_id = t.client_id and status = 'valida') then 'recurrente'
    else 'nuevo' end;
  select timezone into v_tz from public.businesses where id = t.business_id;
  v_local := v_now at time zone v_tz;

  insert into public.sales (
    business_id, turn_id, client_id, client_name, client_type, barber_id, service_id, service_name,
    list_price, discount, amount, tip, status, arrived_at, started_at, completed_at,
    local_date, local_hour, local_dow, created_by
  ) values (
    t.business_id, t.id, t.client_id, t.display_name, v_type, t.barber_id, v_svc.id, v_name,
    v_list, v_discount, v_list - v_discount, v_tip, 'valida', t.arrived_at, t.started_at, v_now,
    v_local::date, extract(hour from v_local)::smallint, extract(dow from v_local)::smallint, auth.uid()
  ) returning * into s;

  insert into public.sale_payments (sale_id, business_id, method, amount)
  values (s.id, t.business_id, p_method, s.amount + s.tip);

  update public.turns set status = 'finalizado', ended_at = v_now where id = t.id;
  return s;
end $$;

create function public.void_sale(p_sale uuid, p_reason text) returns public.sales
language plpgsql security definer set search_path = public as $$
declare s public.sales; v_reason text := trim(coalesce(p_reason, ''));
begin
  select * into s from public.sales where id = p_sale;
  if not found then raise exception 'Venta no encontrada.' using errcode = 'P0002'; end if;
  perform public._require(s.business_id, true);
  if length(v_reason) < 3 then
    raise exception 'Escribe el motivo de la anulación.' using errcode = '22023';
  end if;
  select * into s from public.sales where id = p_sale for update;
  if s.status = 'anulada' then return s; end if;
  update public.sales set status = 'anulada', void_reason = v_reason, voided_at = now(), voided_by = auth.uid()
  where id = p_sale returning * into s;
  perform public._audit(s.business_id, 'venta_anulada', 'venta', s.id::text,
    jsonb_build_object('status', 'valida', 'amount', s.amount, 'tip', s.tip), jsonb_build_object('status', 'anulada'), v_reason);
  return s;
end $$;

-- ---------- Servicios (solo administradores) ----------
create function public.save_service(
  p_business uuid, p_id uuid, p_name text, p_description text, p_price integer, p_duration integer, p_active boolean
) returns public.services
language plpgsql security definer set search_path = public as $$
declare r public.services; v_before jsonb;
begin
  perform public._require(p_business, true);
  if coalesce(trim(p_name), '') = '' then raise exception 'El servicio necesita un nombre.' using errcode = '22023'; end if;
  if p_price is null or p_price <= 0 then raise exception 'El precio debe ser mayor que cero.' using errcode = '22023'; end if;
  begin
    if p_id is null then
      insert into public.services (business_id, name, description, price, duration_min, active)
      values (p_business, trim(p_name), coalesce(trim(p_description), ''), p_price, nullif(p_duration, 0), coalesce(p_active, true))
      returning * into r;
      perform public._audit(p_business, 'servicio_creado', 'servicio', r.id::text, null,
        jsonb_build_object('name', r.name, 'price', r.price), '');
    else
      select to_jsonb(x) - 'business_id' into v_before from public.services x where id = p_id and business_id = p_business;
      if v_before is null then raise exception 'Servicio no encontrado.' using errcode = 'P0002'; end if;
      update public.services
        set name = trim(p_name), description = coalesce(trim(p_description), ''), price = p_price,
            duration_min = nullif(p_duration, 0), active = coalesce(p_active, active), updated_at = now()
      where id = p_id and business_id = p_business returning * into r;
      perform public._audit(p_business, 'servicio_editado', 'servicio', r.id::text, v_before,
        jsonb_build_object('name', r.name, 'price', r.price, 'duration_min', r.duration_min, 'active', r.active), '');
    end if;
  exception when unique_violation then
    raise exception 'Ya existe un servicio con ese nombre.' using errcode = '23505';
  end;
  return r;
end $$;

-- ---------- Clientes ----------
create function public.update_client_name(p_client uuid, p_name text) returns public.clients
language plpgsql security definer set search_path = public as $$
declare r public.clients; v_old text;
begin
  select * into r from public.clients where id = p_client;
  if not found then raise exception 'Cliente no encontrado.' using errcode = 'P0002'; end if;
  perform public._require(r.business_id, false);
  if coalesce(trim(p_name), '') = '' then raise exception 'El nombre no puede quedar vacío.' using errcode = '22023'; end if;
  v_old := r.name;
  update public.clients set name = trim(p_name), updated_at = now() where id = p_client returning * into r;
  perform public._audit(r.business_id, 'cliente_corregido', 'cliente', r.id::text,
    jsonb_build_object('name', v_old), jsonb_build_object('name', r.name), '');
  return r;
end $$;

-- ---------- Pantalla pública (sin datos personales) ----------
create function public.public_board(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  with b as (select id, name from public.businesses where slug = p_slug),
  dur as (
    select extract(epoch from (s.completed_at - s.started_at)) / 60.0 as m
    from public.sales s join b on s.business_id = b.id
    where s.status = 'valida' and s.started_at is not null
      and s.completed_at - s.started_at between interval '3 minutes' and interval '180 minutes'
    order by s.completed_at desc limit 20
  ),
  med as (select case when count(*) >= 3 then round(percentile_cont(0.5) within group (order by m))::int end as v from dur),
  svc as (select round(avg(duration_min))::int as v from public.services s join b on s.business_id = b.id where s.active and s.duration_min is not null)
  select case when (select id from b) is null then null else jsonb_build_object(
    'business', (select name from b),
    'serving', coalesce((select jsonb_agg(jsonb_build_object('turn', t.turn_number, 'name', public.first_name(t.display_name), 'started_at', t.started_at) order by t.arrived_at)
                         from public.turns t join b on t.business_id = b.id where t.status = 'atendiendo'), '[]'::jsonb),
    'waiting', coalesce((select jsonb_agg(jsonb_build_object('turn', t.turn_number, 'name', public.first_name(t.display_name)) order by t.arrived_at)
                         from public.turns t join b on t.business_id = b.id where t.status = 'esperando'), '[]'::jsonb),
    'avg_minutes', coalesce((select v from med), (select v from svc)),
    'estimate_source', case when (select v from med) is not null then 'real' when (select v from svc) is not null then 'configurado' else null end,
    'now', now()
  ) end
$$;

-- ---------- Importar respaldo (solo administradores; no borra ni reemplaza nada) ----------
-- Acepta el respaldo del artifact anterior (formatVersion 1) y el de esta versión (format 'supabase-v1').
create function public.import_backup(p_business uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tz text; x jsonb; d jsonb; v_client uuid; v_service uuid; v_sale uuid; v_at timestamptz; v_local timestamp;
  n_services int := 0; n_clients int := 0; n_sales int := 0; n_skipped int := 0; v_amount int; v_ident text; v_rows int;
begin
  perform public._require(p_business, true);
  select timezone into v_tz from public.businesses where id = p_business;

  if (p_data->>'app') = 'turno-y-caja' and (p_data->>'formatVersion') = '1' then
    for x in select * from jsonb_array_elements(coalesce(p_data->'collections'->'services', '[]')) loop
      d := x->'data';
      insert into public.services (business_id, name, price, duration_min, active, created_at)
      values (p_business, d->>'name', (d->>'price')::int, nullif((d->>'durationMin')::int, 0),
              coalesce((d->>'active')::boolean, true), coalesce((d->>'createdAt')::timestamptz, now()))
      on conflict (business_id, lower(name)) do nothing;
      get diagnostics v_rows = row_count; n_services := n_services + v_rows;
    end loop;
    for x in select * from jsonb_array_elements(coalesce(p_data->'collections'->'clients', '[]')) loop
      d := x->'data';
      v_ident := regexp_replace(coalesce(d->>'identifier', x->>'id'), '[^0-9]', '', 'g');
      continue when length(v_ident) not between 6 and 15;
      insert into public.clients (business_id, identifier, name, created_at)
      values (p_business, v_ident, coalesce(d->>'name', ''), coalesce((d->>'createdAt')::timestamptz, (d->>'firstVisit')::timestamptz, now()))
      on conflict (business_id, identifier) do nothing;
      get diagnostics v_rows = row_count; n_clients := n_clients + v_rows;
    end loop;
    for x in select * from jsonb_array_elements(coalesce(p_data->'collections'->'payments', '[]')) loop
      d := x->'data';
      if exists (select 1 from public.sales where legacy_id = x->>'id') then n_skipped := n_skipped + 1; continue; end if;
      v_at := coalesce((d->>'completedAt')::timestamptz, now());
      v_local := v_at at time zone v_tz;
      v_client := null;
      v_ident := nullif(regexp_replace(coalesce(d->>'clientId', ''), '[^0-9]', '', 'g'), '');
      if v_ident is not null then
        insert into public.clients (business_id, identifier, name) values (p_business, v_ident, coalesce(d->>'name', ''))
        on conflict (business_id, identifier) do nothing;
        select id into v_client from public.clients where business_id = p_business and identifier = v_ident;
      end if;
      select id into v_service from public.services where business_id = p_business and lower(name) = lower(coalesce(d->>'serviceName', d->>'service', ''));
      v_amount := coalesce((d->>'amount')::int, 0);
      insert into public.sales (business_id, legacy_id, client_id, client_name, client_type, service_id, service_name,
        list_price, discount, amount, tip, status, void_reason, voided_at, arrived_at, started_at, completed_at,
        local_date, local_hour, local_dow)
      values (p_business, x->>'id', v_client, coalesce(d->>'name', ''),
        coalesce(d->>'clientType', case when (d->>'isNew')::boolean then 'nuevo' when v_client is not null then 'recurrente' else 'sin_id' end),
        v_service, coalesce(d->>'serviceName', d->>'service', 'Sin especificar'),
        coalesce((d->>'listPrice')::int, v_amount), coalesce((d->>'discount')::int, 0), v_amount, coalesce((d->>'tip')::int, 0),
        case when d->>'status' = 'anulada' then 'anulada' else 'valida' end,
        case when d->>'status' = 'anulada' then coalesce(nullif(d->>'voidReason', ''), 'Anulada antes de la migración') end,
        (d->>'voidedAt')::timestamptz, (d->>'arrivedAt')::timestamptz, (d->>'startedAt')::timestamptz, v_at,
        v_local::date, extract(hour from v_local)::smallint, extract(dow from v_local)::smallint)
      returning id into v_sale;
      insert into public.sale_payments (sale_id, business_id, method, amount)
      select v_sale, p_business,
             case when p->>'method' in ('efectivo','tarjeta','transferencia') then p->>'method' else 'efectivo' end,
             (p->>'amount')::int
      from jsonb_array_elements(coalesce(d->'pays', jsonb_build_array(jsonb_build_object('method', coalesce(d->>'method', 'efectivo'), 'amount', v_amount + coalesce((d->>'tip')::int, 0))))) p;
      n_sales := n_sales + 1;
    end loop;

  elsif (p_data->>'format') = 'supabase-v1' then
    insert into public.services select * from jsonb_populate_recordset(null::public.services, coalesce(p_data->'services', '[]'))
      where business_id = p_business on conflict do nothing;
    get diagnostics n_services = row_count;
    insert into public.clients select * from jsonb_populate_recordset(null::public.clients, coalesce(p_data->'clients', '[]'))
      where business_id = p_business on conflict do nothing;
    get diagnostics n_clients = row_count;
    insert into public.barbers select * from jsonb_populate_recordset(null::public.barbers, coalesce(p_data->'barbers', '[]'))
      where business_id = p_business on conflict do nothing;
    insert into public.turns select * from jsonb_populate_recordset(null::public.turns, coalesce(p_data->'turns', '[]'))
      where business_id = p_business on conflict do nothing;
    insert into public.sales select * from jsonb_populate_recordset(null::public.sales, coalesce(p_data->'sales', '[]'))
      where business_id = p_business on conflict do nothing;
    get diagnostics n_sales = row_count;
    insert into public.sale_payments (sale_id, business_id, method, amount)
      select sp.sale_id, sp.business_id, sp.method, sp.amount
      from jsonb_populate_recordset(null::public.sale_payments, coalesce(p_data->'sale_payments', '[]')) sp
      where sp.business_id = p_business
        and exists (select 1 from public.sales s where s.id = sp.sale_id)
        and not exists (select 1 from public.sale_payments e where e.sale_id = sp.sale_id);
  else
    raise exception 'Este archivo no es un respaldo de Turno y Caja.' using errcode = '22023';
  end if;

  perform public._audit(p_business, 'respaldo_importado', 'sistema', null, null,
    jsonb_build_object('services', n_services, 'clients', n_clients, 'sales', n_sales, 'skipped', n_skipped), '');
  return jsonb_build_object('services', n_services, 'clients', n_clients, 'sales', n_sales, 'skipped', n_skipped);
end $$;

-- ---------- Ejecución de funciones ----------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.public_board(text) to anon, authenticated;
grant execute on function
  public.my_role(uuid), public.is_member(uuid), public.is_admin(uuid),
  public.add_turn(uuid, text, text), public.start_turn(uuid), public.back_to_waiting(uuid),
  public.retire_turn(uuid, text), public.checkout(uuid, uuid, text, integer, integer, integer, text),
  public.void_sale(uuid, text), public.save_service(uuid, uuid, text, text, integer, integer, boolean),
  public.update_client_name(uuid, text), public.invite_member(uuid, text, text, text),
  public.import_backup(uuid, jsonb), public.first_name(text)
to authenticated;

-- ---------- Tiempo real para el panel (solo si existe la publicación de Supabase) ----------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.turns, public.sales, public.services;
  end if;
end $$;
