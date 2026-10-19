-- =====================================================================
-- 003 — Tarifa fundador
--   * Cada cliente es "fundador" o "general" (lo decide un administrador).
--   * Cada servicio puede tener una tarifa fundador (menor que el precio de lista).
--   * Al cobrar a un fundador, el servidor aplica la diferencia como descuento
--     y la deja registrada aparte (tier_discount), para medir cuánto cuesta la medida.
--   * Las ventas guardan el tipo de tarifa del momento (client_tier).
-- =====================================================================

alter table public.clients  add column tier text not null default 'general' check (tier in ('fundador','general'));
alter table public.services add column founder_price integer check (founder_price is null or founder_price > 0);
alter table public.sales    add column client_tier text not null default 'general' check (client_tier in ('fundador','general'));
alter table public.sales    add column tier_discount integer not null default 0 check (tier_discount >= 0);
alter table public.sales    add constraint sales_tier_discount_ok check (tier_discount <= discount);

-- ---------- Cambiar el tipo de tarifa de un cliente (solo administradores) ----------
create function public.set_client_tier(p_client uuid, p_tier text) returns public.clients
language plpgsql security definer set search_path = public as $$
declare r public.clients; v_old text;
begin
  if p_tier is null or p_tier not in ('fundador','general') then
    raise exception 'El tipo de cliente debe ser fundador o general.' using errcode = '22023';
  end if;
  select * into r from public.clients where id = p_client;
  if not found then raise exception 'Cliente no encontrado.' using errcode = 'P0002'; end if;
  perform public._require(r.business_id, true);
  v_old := r.tier;
  if v_old = p_tier then return r; end if;
  update public.clients set tier = p_tier, updated_at = now() where id = p_client returning * into r;
  perform public._audit(r.business_id, 'cliente_tarifa', 'cliente', r.id::text,
    jsonb_build_object('tier', v_old), jsonb_build_object('tier', r.tier), '');
  return r;
end $$;

-- ---------- Servicios: ahora con tarifa fundador opcional ----------
drop function public.save_service(uuid, uuid, text, text, integer, integer, boolean);
create function public.save_service(
  p_business uuid, p_id uuid, p_name text, p_description text, p_price integer, p_duration integer, p_active boolean,
  p_founder_price integer default null
) returns public.services
language plpgsql security definer set search_path = public as $$
declare r public.services; v_before jsonb; v_founder integer := nullif(p_founder_price, 0);
begin
  perform public._require(p_business, true);
  if coalesce(trim(p_name), '') = '' then raise exception 'El servicio necesita un nombre.' using errcode = '22023'; end if;
  if p_price is null or p_price <= 0 then raise exception 'El precio debe ser mayor que cero.' using errcode = '22023'; end if;
  if v_founder is not null and (v_founder <= 0 or v_founder >= p_price) then
    raise exception 'La tarifa fundador debe ser menor que el precio de lista.' using errcode = '22023';
  end if;
  begin
    if p_id is null then
      insert into public.services (business_id, name, description, price, duration_min, active, founder_price)
      values (p_business, trim(p_name), coalesce(trim(p_description), ''), p_price, nullif(p_duration, 0), coalesce(p_active, true), v_founder)
      returning * into r;
      perform public._audit(p_business, 'servicio_creado', 'servicio', r.id::text, null,
        jsonb_build_object('name', r.name, 'price', r.price, 'founder_price', r.founder_price), '');
    else
      select to_jsonb(x) - 'business_id' into v_before from public.services x where id = p_id and business_id = p_business;
      if v_before is null then raise exception 'Servicio no encontrado.' using errcode = 'P0002'; end if;
      update public.services
        set name = trim(p_name), description = coalesce(trim(p_description), ''), price = p_price,
            duration_min = nullif(p_duration, 0), active = coalesce(p_active, active), founder_price = v_founder, updated_at = now()
      where id = p_id and business_id = p_business returning * into r;
      perform public._audit(p_business, 'servicio_editado', 'servicio', r.id::text, v_before,
        jsonb_build_object('name', r.name, 'price', r.price, 'duration_min', r.duration_min, 'active', r.active, 'founder_price', r.founder_price), '');
    end if;
  exception when unique_violation then
    raise exception 'Ya existe un servicio con ese nombre.' using errcode = '23505';
  end;
  return r;
end $$;

-- ---------- Cobro: aplica la tarifa fundador (misma firma, sigue siendo idempotente) ----------
create or replace function public.checkout(
  p_turn uuid, p_service uuid, p_custom_name text, p_custom_price integer,
  p_discount integer, p_tip integer, p_method text
) returns public.sales
language plpgsql security definer set search_path = public as $$
declare
  t public.turns; s public.sales; v_svc public.services;
  v_list integer; v_name text; v_tz text; v_now timestamptz := now(); v_local timestamp; v_type text;
  v_discount integer := coalesce(p_discount, 0); v_tip integer := coalesce(p_tip, 0);
  v_tier text := 'general'; v_tier_disc integer := 0;
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

  -- Tarifa fundador: solo con cliente identificado, servicio guardado y tarifa definida.
  if t.client_id is not null then
    select tier into v_tier from public.clients where id = t.client_id;
    v_tier := coalesce(v_tier, 'general');
  end if;
  if v_tier = 'fundador' and v_svc.founder_price is not null and v_svc.founder_price < v_list then
    v_tier_disc := v_list - v_svc.founder_price;
  end if;
  if v_discount + v_tier_disc > v_list then
    raise exception 'El descuento no puede ser mayor que el precio.' using errcode = '22023';
  end if;
  v_discount := v_discount + v_tier_disc;

  v_type := case
    when t.client_id is null then 'sin_id'
    when exists (select 1 from public.sales where client_id = t.client_id and status = 'valida') then 'recurrente'
    else 'nuevo' end;
  select timezone into v_tz from public.businesses where id = t.business_id;
  v_local := v_now at time zone v_tz;

  insert into public.sales (
    business_id, turn_id, client_id, client_name, client_type, barber_id, service_id, service_name,
    list_price, discount, amount, tip, status, arrived_at, started_at, completed_at,
    local_date, local_hour, local_dow, created_by, client_tier, tier_discount
  ) values (
    t.business_id, t.id, t.client_id, t.display_name, v_type, t.barber_id, v_svc.id, v_name,
    v_list, v_discount, v_list - v_discount, v_tip, 'valida', t.arrived_at, t.started_at, v_now,
    v_local::date, extract(hour from v_local)::smallint, extract(dow from v_local)::smallint, auth.uid(),
    v_tier, v_tier_disc
  ) returning * into s;

  insert into public.sale_payments (sale_id, business_id, method, amount)
  values (s.id, t.business_id, p_method, s.amount + s.tip);

  update public.turns set status = 'finalizado', ended_at = v_now where id = t.id;
  return s;
end $$;

-- ---------- Permisos de ejecución de las funciones nuevas ----------
revoke execute on function public.set_client_tier(uuid, text) from public, anon, authenticated;
revoke execute on function public.save_service(uuid, uuid, text, text, integer, integer, boolean, integer) from public, anon, authenticated;
grant execute on function
  public.set_client_tier(uuid, text),
  public.save_service(uuid, uuid, text, text, integer, integer, boolean, integer)
to authenticated;
