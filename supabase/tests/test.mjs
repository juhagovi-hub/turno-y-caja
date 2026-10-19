// Pruebas del esquema de Turno y Caja sobre Postgres real (PGlite) con auth de Supabase simulado.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const MIG = new URL('../migrations/', import.meta.url);
// Respaldo real del artifact (opcional: si no está en esta máquina, esas pruebas se omiten).
let backup = null;
try { backup = JSON.parse(readFileSync(process.env.BACKUP_JSON || new URL('../../../../tmp/claude-0/-home-claude/c14eaa0e-ea03-5ea1-be0d-f3b4131520e8/scratchpad/backup-v4/turno-y-caja-respaldo-2026-10-15.json', 'file:///'), 'utf8')); } catch { /* sin respaldo */ }

async function makeDb() {
  const d = new PGlite();
  await d.exec(`
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role anon nologin; create role authenticated nologin;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await d.exec(readFileSync(new URL('001_turno_y_caja.sql', MIG), 'utf8'));
  await d.exec(readFileSync(new URL('002_seed.sql', MIG), 'utf8'));
  await d.exec(readFileSync(new URL('003_tarifa_fundador.sql', MIG), 'utf8'));
  return d;
}
const db = await makeDb();
async function asOn(d, uid, sql, params = []) {
  return d.transaction(async (tx) => {
    await tx.query(`set local role ${uid ? 'authenticated' : 'anon'}`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid || '']);
    return (await tx.query(sql, params)).rows;
  });
}

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push('PASA  ' + name); }
  catch (e) { results.push('FALLA ' + name + ' → ' + e.message); }
}

// Ejecuta SQL como un usuario (role authenticated + sub) o como anónimo (uid null).
async function as(uid, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${uid ? 'authenticated' : 'anon'}`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid || '']);
    return (await tx.query(sql, params)).rows;
  });
}
async function rejects(promise, re) {
  try { await promise; } catch (e) { if (re && !re.test(e.message)) throw new Error('mensaje inesperado: ' + e.message); return e.message; }
  throw new Error('debía rechazarse y no se rechazó');
}

// Usuarios: la invitación del dueño se aplica al registrarse.
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const owner = (await one(`insert into auth.users (email) values ('JUHAGOVI@gmail.com') returning id`)).id;
const biz = (await one(`select id from public.businesses where slug = 'tierra-linda'`)).id;
const friend = (await one(`insert into auth.users (email) values ('socio@example.com') returning id`)).id;
const barber = (await one(`insert into auth.users (email) values ('barbero@example.com') returning id`)).id;
const outsider = (await one(`insert into auth.users (email) values ('otro@example.com') returning id`)).id;
const other = (await one(`insert into public.businesses (slug, name) values ('otra-barberia', 'Otra') returning id`)).id;
await db.query(`insert into public.members values ($1, $2, 'owner', 'Otro dueño', now())`, [other, outsider]);

await test('El dueño invitado queda como miembro al registrarse (correo sin distinguir mayúsculas)', async () => {
  const r = await as(owner, `select public.my_role($1) as role`, [biz]);
  assert.equal(r[0].role, 'owner');
});
await test('El dueño invita al socio como administrador y a un barbero', async () => {
  await as(owner, `select public.invite_member($1, 'socio@example.com', 'admin', 'Socio')`, [biz]);
  await as(owner, `select public.invite_member($1, 'barbero@example.com', 'barber', 'Barbero')`, [biz]);
  assert.equal((await as(friend, `select public.my_role($1) r`, [biz]))[0].r, 'admin');
  assert.equal((await as(barber, `select public.my_role($1) r`, [biz]))[0].r, 'barber');
});
await test('Un barbero no puede invitar ni subir permisos', async () => {
  await rejects(as(barber, `select public.invite_member($1, 'x@example.com', 'admin', 'X')`, [biz]), /administrador/);
});

// Servicios
let corte, barba;
await test('El administrador crea servicios con precio propio', async () => {
  corte = (await as(owner, `select * from public.save_service($1, null, 'Corte', '', 25000, 35, true)`, [biz]))[0];
  barba = (await as(friend, `select * from public.save_service($1, null, 'Corte y barba', '', 32000, 45, true)`, [biz]))[0];
  assert.equal(corte.price, 25000); assert.equal(barba.price, 32000);
});
await test('No se permiten dos servicios con el mismo nombre', async () => {
  await rejects(as(owner, `select public.save_service($1, null, 'corte', '', 1000, null, true)`, [biz]), /Ya existe/);
});
await test('Un barbero no puede cambiar tarifas (rechazo en la base de datos)', async () => {
  await rejects(as(barber, `select public.save_service($1, $2, 'Corte', '', 1000, 35, true)`, [biz, corte.id]), /administrador/);
  await rejects(as(barber, `update public.services set price = 1000 where id = $1`, [corte.id]), /permission denied/);
});

// Prueba 1 y 2: registrar y la fila se actualiza
let t1, t2, t3;
await test('Registrar clientes en la fila: números 1, 2, 3 y datos persistidos', async () => {
  t1 = (await as(barber, `select * from public.add_turn($1, 'julio gómez', '316 489 3957')`, [biz]))[0];
  t2 = (await as(barber, `select * from public.add_turn($1, 'Diego', '')`, [biz]))[0];
  t3 = (await as(barber, `select * from public.add_turn($1, 'Ana', '3001112233')`, [biz]))[0];
  assert.deepEqual([t1.turn_number, t2.turn_number, t3.turn_number], [1, 2, 3]);
  const c = await as(owner, `select identifier, name from public.clients where business_id = $1 order by created_at`, [biz]);
  assert.equal(c[0].identifier, '3164893957'); assert.equal(c[0].name, 'julio gómez');
  const q = await as(owner, `select count(*)::int n from public.turns where business_id = $1 and status = 'esperando'`, [biz]);
  assert.equal(q[0].n, 3);
});
await test('Sin nombre ni celular, o con celular incompleto, se rechaza', async () => {
  await rejects(as(barber, `select public.add_turn($1, '', '')`, [biz]), /al menos/);
  await rejects(as(barber, `select public.add_turn($1, 'X', '123')`, [biz]), /incompleto/);
});

// Transiciones
await test('No se puede cobrar un turno que no está en atención', async () => {
  await rejects(as(barber, `select public.checkout($1, $2, null, null, 0, 0, 'efectivo')`, [t1.id, corte.id]), /no está en atención/);
});
await test('Solo un turno en atención a la vez', async () => {
  await as(barber, `select public.start_turn($1)`, [t1.id]);
  await rejects(as(barber, `select public.start_turn($1)`, [t2.id]), /Ya hay un turno/);
});

// Prueba 4: doble clic → una sola venta
let sale1;
await test('Cobrar dos veces el mismo turno deja una sola venta', async () => {
  const a = (await as(barber, `select * from public.checkout($1, $2, null, null, 0, 0, 'efectivo')`, [t1.id, corte.id]))[0];
  const b = (await as(barber, `select * from public.checkout($1, $2, null, null, 0, 0, 'tarjeta')`, [t1.id, corte.id]))[0];
  assert.equal(a.id, b.id);
  const n = await as(owner, `select count(*)::int n from public.sales where turn_id = $1`, [t1.id]);
  assert.equal(n[0].n, 1);
  const p = await as(owner, `select count(*)::int n, sum(amount)::int s from public.sale_payments where sale_id = $1`, [a.id]);
  assert.equal(p[0].n, 1); assert.equal(p[0].s, 25000);
  sale1 = a;
});
await test('El precio lo pone la base de datos, no el navegador', async () => {
  assert.equal(sale1.list_price, 25000); assert.equal(sale1.amount, 25000); assert.equal(sale1.service_name, 'Corte');
});
await test('El primer cobro de un cliente identificado es "nuevo"', async () => {
  assert.equal(sale1.client_type, 'nuevo');
});

// Prueba 3: retirar no genera venta
await test('Retirar un cliente no genera venta y deja motivo', async () => {
  const before = (await as(owner, `select count(*)::int n from public.sales where business_id = $1`, [biz]))[0].n;
  const r = (await as(barber, `select * from public.retire_turn($1, 'retirado')`, [t2.id]))[0];
  assert.equal(r.status, 'retirado'); assert.match(r.retire_reason, /Se retiró/);
  const after = (await as(owner, `select count(*)::int n from public.sales where business_id = $1`, [biz]))[0].n;
  assert.equal(after, before);
  await rejects(as(barber, `select public.start_turn($1)`, [t2.id]), /cambió de estado/);
});

// Prueba 8: métodos de pago, descuento, propina
let sale3;
await test('Descuento y propina quedan separados; transferencia suma en su método', async () => {
  await as(barber, `select public.start_turn($1)`, [t3.id]);
  await rejects(as(barber, `select public.checkout($1, $2, null, null, 40000, 0, 'efectivo')`, [t3.id, barba.id]), /descuento/);
  await rejects(as(barber, `select public.checkout($1, $2, null, null, 0, -1, 'efectivo')`, [t3.id, barba.id]), /negativos/);
  await rejects(as(barber, `select public.checkout($1, $2, null, null, 0, 0, 'bitcoin')`, [t3.id, barba.id]), /cómo pagó/);
  sale3 = (await as(barber, `select * from public.checkout($1, $2, null, null, 2000, 3000, 'transferencia')`, [t3.id, barba.id]))[0];
  assert.equal(sale3.list_price, 32000); assert.equal(sale3.discount, 2000); assert.equal(sale3.amount, 30000); assert.equal(sale3.tip, 3000);
  const m = await as(owner, `select method, sum(amount)::int s from public.sale_payments where business_id = $1 group by method order by method`, [biz]);
  assert.deepEqual(m.map(x => [x.method, x.s]), [['efectivo', 25000], ['transferencia', 33000]]);
});

// Prueba 5: cambiar precio no altera ventas pasadas
await test('Cambiar la tarifa no modifica las ventas anteriores', async () => {
  await as(owner, `select public.save_service($1, $2, 'Corte', '', 28000, 35, true)`, [biz, corte.id]);
  const s = await as(owner, `select list_price, amount from public.sales where id = $1`, [sale1.id]);
  assert.equal(s[0].list_price, 25000); assert.equal(s[0].amount, 25000);
  const svc = await as(owner, `select price from public.services where id = $1`, [corte.id]);
  assert.equal(svc[0].price, 28000);
});
await test('Un servicio desactivado no se puede cobrar pero sigue en el historial', async () => {
  await as(owner, `select public.save_service($1, $2, 'Corte y barba', '', 32000, 45, false)`, [biz, barba.id]);
  const t = (await as(barber, `select * from public.add_turn($1, 'Pedro', '')`, [biz]))[0];
  await as(barber, `select public.start_turn($1)`, [t.id]);
  await rejects(as(barber, `select public.checkout($1, $2, null, null, 0, 0, 'efectivo')`, [t.id, barba.id]), /desactivado/);
  const s = await as(owner, `select service_name from public.sales where id = $1`, [sale3.id]);
  assert.equal(s[0].service_name, 'Corte y barba');
  await as(barber, `select public.back_to_waiting($1)`, [t.id]);
});
await test('Servicio manual ("Otro") con precio escrito', async () => {
  const t = (await as(barber, `select * from public.turns where display_name = 'Pedro'`))[0];
  await as(barber, `select public.start_turn($1)`, [t.id]);
  const s = (await as(barber, `select * from public.checkout($1, null, 'Cejas', 8000, 0, 0, 'tarjeta')`, [t.id]))[0];
  assert.equal(s.service_name, 'Cejas'); assert.equal(s.amount, 8000); assert.equal(s.client_type, 'sin_id');
});
await test('La segunda visita del mismo cliente queda como "recurrente"', async () => {
  const t = (await as(barber, `select * from public.add_turn($1, '', '3164893957')`, [biz]))[0];
  assert.equal(t.display_name, 'julio gómez'); assert.equal(t.client_type, 'recurrente');
  await as(barber, `select public.retire_turn($1, 'ausente')`, [t.id]);
});

// Prueba 10: anulación con trazabilidad; solo administradores
await test('Un barbero no puede anular ventas', async () => {
  await rejects(as(barber, `select public.void_sale($1, 'error')`, [sale3.id]), /administrador/);
});
await test('Anular exige motivo y deja rastro; la venta sigue existiendo', async () => {
  await rejects(as(friend, `select public.void_sale($1, '')`, [sale3.id]), /motivo/);
  await as(friend, `select public.void_sale($1, 'Cobro registrado al cliente equivocado')`, [sale3.id]);
  const s = await as(owner, `select status, void_reason from public.sales where id = $1`, [sale3.id]);
  assert.equal(s[0].status, 'anulada');
  const a = await as(owner, `select action, reason, user_id from public.audit_log where entity_id = $1`, [sale3.id]);
  assert.equal(a[0].action, 'venta_anulada'); assert.equal(a[0].user_id, friend);
});
await test('Nadie puede borrar ni editar ventas directamente', async () => {
  await rejects(as(owner, `delete from public.sales where id = $1`, [sale1.id]), /permission denied/);
  await rejects(as(owner, `update public.sales set amount = 1 where id = $1`, [sale1.id]), /permission denied/);
  await rejects(as(owner, `insert into public.sale_payments (sale_id, business_id, method, amount) values ($1, $2, 'efectivo', 1)`, [sale1.id, biz]), /permission denied/);
});
await test('El registro de cambios solo lo ven los administradores', async () => {
  const b = await as(barber, `select count(*)::int n from public.audit_log`);
  const o = await as(owner, `select count(*)::int n from public.audit_log`);
  assert.equal(b[0].n, 0); assert.ok(o[0].n > 0);
});

// Prueba 13: aislamiento entre negocios y público
await test('Un usuario de otro negocio no ve ni modifica nada de esta barbería', async () => {
  const r = await as(outsider, `select (select count(*)::int from public.sales) s, (select count(*)::int from public.clients) c, (select count(*)::int from public.turns) t`);
  assert.deepEqual([r[0].s, r[0].c, r[0].t], [0, 0, 0]);
  await rejects(as(outsider, `select public.add_turn($1, 'Intruso', '')`, [biz]), /No tienes acceso/);
  await rejects(as(outsider, `select public.checkout($1, null, 'x', 1000, 0, 0, 'efectivo')`, [t3.id]), /No tienes acceso/);
});
await test('Un visitante anónimo no ve ventas, clientes ni turnos', async () => {
  await rejects(as(null, `select * from public.sales`), /permission denied/);
  await rejects(as(null, `select * from public.clients`), /permission denied/);
  await rejects(as(null, `select public.add_turn($1, 'x', '')`, [biz]), /permission denied/);
});
await test('La pantalla pública muestra turno y primer nombre, sin celulares ni dinero', async () => {
  const w = (await as(barber, `select * from public.add_turn($1, 'maría fernanda lópez', '3205556677')`, [biz]))[0];
  await as(barber, `select public.start_turn($1)`, [w.id]);
  await as(barber, `select public.add_turn($1, 'Carlos', '')`, [biz]);
  const b = (await as(null, `select public.public_board('tierra-linda') b`))[0].b;
  assert.equal(b.serving[0].name, 'María'); assert.equal(b.waiting[0].name, 'Carlos');
  const txt = JSON.stringify(b);
  assert.ok(!txt.includes('3205556677') && !txt.includes('López') && !txt.includes('amount'), txt);
  assert.equal((await as(null, `select public.public_board('no-existe') b`))[0].b, null);
});
await test('Estimación de espera: usa duración configurada mientras no hay atenciones reales', async () => {
  const b = (await as(null, `select public.public_board('tierra-linda') b`))[0].b;
  assert.equal(b.estimate_source, 'configurado'); assert.equal(b.avg_minutes, 35);
});

// Fechas en hora de Colombia
await test('Una venta a las 10:30 p. m. de Colombia queda en ese día (no en el siguiente)', async () => {
  const r = await db.query(`select (timestamptz '2026-10-16 03:30:00+00' at time zone 'America/Bogota')::date d,
    extract(hour from timestamptz '2026-10-16 03:30:00+00' at time zone 'America/Bogota')::int h`);
  assert.equal(r.rows[0].d.toISOString().slice(0, 10), '2026-10-15'); assert.equal(r.rows[0].h, 22);
});


// Tarifa fundador
await test('Tarifa fundador: debe ser menor que el precio de lista y solo la define un administrador', async () => {
  await rejects(as(owner, `select public.save_service($1, $2, 'Corte', '', 25000, 35, true, 25000)`, [biz, corte.id]), /menor que el precio/);
  await rejects(as(barber, `select public.save_service($1, $2, 'Corte', '', 25000, 35, true, 20000)`, [biz, corte.id]), /administrador/);
  const r = (await as(owner, `select * from public.save_service($1, $2, 'Corte', '', 25000, 35, true, 20000)`, [biz, corte.id]))[0];
  assert.equal(r.founder_price, 20000); assert.equal(r.price, 25000);
});
await test('Solo un administrador cambia el tipo de cliente, y queda en el rastro de auditoría', async () => {
  const cid = (await as(owner, `select id from public.clients where business_id = $1 and identifier = '3001112233'`, [biz]))[0].id;
  await rejects(as(barber, `select public.set_client_tier($1, 'fundador')`, [cid]), /administrador/);
  await rejects(as(owner, `select public.set_client_tier($1, 'vip')`, [cid]), /fundador o general/);
  const r = (await as(friend, `select * from public.set_client_tier($1, 'fundador')`, [cid]))[0];
  assert.equal(r.tier, 'fundador');
  const a = await as(owner, `select count(*)::int n from public.audit_log where business_id = $1 and action = 'cliente_tarifa'`, [biz]);
  assert.equal(a[0].n, 1);
  await as(friend, `select public.set_client_tier($1, 'general')`, [cid]);
});
// Limpia turnos pendientes de pruebas anteriores para empezar la fila vacía.
await db.query(`update public.turns set status = 'retirado', ended_at = now(), retire_reason = 'limpieza de prueba' where status in ('esperando','atendiendo')`);
async function cobrar(name, ident, svc, opts = {}) {
  const t = (await as(barber, `select * from public.add_turn($1, $2, $3)`, [biz, name, ident]))[0];
  await as(barber, `select public.start_turn($1)`, [t.id]);
  const s = (await as(barber, `select * from public.checkout($1, $2, $3, $4, $5, $6, 'efectivo')`,
    [t.id, svc ? svc.id : null, opts.customName || null, opts.customPrice || null, opts.discount || 0, opts.tip || 0]))[0];
  return s;
}
await test('Cliente general paga el precio de lista (sin descuento de tarifa)', async () => {
  const s = await cobrar('Pedro General', '3101110001', corte);
  assert.deepEqual([s.list_price, s.discount, s.tier_discount, s.amount, s.client_tier], [25000, 0, 0, 25000, 'general']);
});
await test('Cliente fundador paga la tarifa fundador; la diferencia queda registrada aparte', async () => {
  const c = (await as(owner, `select * from public.add_turn($1, 'Fabio Fundador', '3102220002')`, [biz]))[0];
  await as(owner, `select public.set_client_tier($1, 'fundador')`, [c.client_id]);
  await as(barber, `select public.start_turn($1)`, [c.id]);
  const s = (await as(barber, `select * from public.checkout($1, $2, null, null, 0, 2000, 'efectivo')`, [c.id, corte.id]))[0];
  assert.deepEqual([s.list_price, s.discount, s.tier_discount, s.amount, s.tip, s.client_tier], [25000, 5000, 5000, 20000, 2000, 'fundador']);
  const p = await as(owner, `select sum(amount)::int t from public.sale_payments where sale_id = $1`, [s.id]);
  assert.equal(p[0].t, 22000);
  // Cobrar de nuevo el mismo turno devuelve la misma venta y no duplica el descuento
  const again = (await as(barber, `select * from public.checkout($1, $2, null, null, 0, 2000, 'efectivo')`, [c.id, corte.id]))[0];
  assert.equal(again.id, s.id); assert.equal(again.discount, 5000);
});
await test('Fundador con descuento manual: se suman, y no pueden pasar del precio', async () => {
  const c = (await as(owner, `select * from public.add_turn($1, 'Fabio Fundador', '3102220002')`, [biz]))[0];
  await as(barber, `select public.start_turn($1)`, [c.id]);
  await rejects(as(barber, `select public.checkout($1, $2, null, null, 20001, 0, 'efectivo')`, [c.id, corte.id]), /descuento no puede/);
  const s = (await as(barber, `select * from public.checkout($1, $2, null, null, 1000, 0, 'efectivo')`, [c.id, corte.id]))[0];
  assert.deepEqual([s.discount, s.tier_discount, s.amount], [6000, 5000, 19000]);
});
await test('Fundador sin tarifa definida en el servicio, o con precio manual, paga precio completo', async () => {
  const cejas = (await as(owner, `select * from public.save_service($1, null, 'Cejas', '', 8000, 10, true)`, [biz]))[0];
  const s1 = await cobrar('Fabio Fundador', '3102220002', cejas);
  assert.deepEqual([s1.discount, s1.tier_discount, s1.amount, s1.client_tier], [0, 0, 8000, 'fundador']);
  const s2 = await cobrar('Fabio Fundador', '3102220002', null, { customName: 'Diseño', customPrice: 10000 });
  assert.deepEqual([s2.discount, s2.tier_discount, s2.amount], [0, 0, 10000]);
});
await test('Cambiar el tipo de cliente o la tarifa no altera las ventas ya hechas', async () => {
  const cid = (await as(owner, `select id from public.clients where business_id = $1 and identifier = '3102220002'`, [biz]))[0].id;
  await as(owner, `select public.set_client_tier($1, 'general')`, [cid]);
  await as(owner, `select public.save_service($1, $2, 'Corte', '', 26000, 35, true, 21000)`, [biz, corte.id]);
  const r = await as(owner, `select amount, list_price, client_tier from public.sales where client_id = $1 and service_name = 'Corte' order by completed_at limit 1`, [cid]);
  assert.deepEqual([r[0].amount, r[0].list_price, r[0].client_tier], [20000, 25000, 'fundador']);
  await as(owner, `select public.save_service($1, $2, 'Corte', '', 25000, 35, true, 20000)`, [biz, corte.id]);
});

// Prueba 12: importar el respaldo real del artifact (idempotente)
if (backup) await test('Importar el respaldo real: 3 ventas, $77.000, y repetirlo no duplica', async () => {
  await rejects(as(barber, `select public.import_backup($1, $2::jsonb)`, [biz, JSON.stringify(backup)]), /administrador/);
  const r1 = (await as(owner, `select public.import_backup($1, $2::jsonb) r`, [biz, JSON.stringify(backup)]))[0].r;
  assert.equal(r1.sales, 3);
  const r2 = (await as(owner, `select public.import_backup($1, $2::jsonb) r`, [biz, JSON.stringify(backup)]))[0].r;
  assert.equal(r2.sales, 0); assert.equal(r2.skipped, 3);
  const s = await as(owner, `select count(*)::int n, sum(amount)::int total from public.sales where legacy_id is not null`);
  assert.equal(s[0].n, 3); assert.equal(s[0].total, 77000);
  const p = await as(owner, `select sum(sp.amount)::int t from public.sale_payments sp join public.sales s on s.id = sp.sale_id where s.legacy_id is not null`);
  assert.equal(p[0].t, 77000);
  const d = await as(owner, `select local_date::text d, local_hour h from public.sales where legacy_id = '2kiak4ceomftcho7uv22'`);
  assert.equal(d[0].d, '2026-10-15'); assert.equal(d[0].h, 16);
});
await test('Respaldo y restauración del formato nuevo en un negocio vacío', async () => {
  // Exporta lo que el panel descargaría y lo importa en un negocio nuevo con el mismo dueño.
  const tables = ['services', 'clients', 'barbers', 'turns', 'sales', 'sale_payments'];
  const data = { format: 'supabase-v1' };
  for (const t of tables) data[t] = await as(owner, `select * from public.${t} where business_id = $1`, [biz]);
  const total = (await as(owner, `select sum(amount + tip)::int t from public.sales where business_id = $1 and status = 'valida'`, [biz]))[0].t;
  // Base de datos nueva y vacía (entorno de prueba), mismo esquema; se recrea el negocio con su id original.
  const fresh = await makeDb();
  await fresh.query(`delete from public.member_invites`);
  await fresh.query(`delete from public.businesses`);
  await fresh.query(`insert into public.businesses (id, slug, name) values ($1, 'tierra-linda', 'Barbería Tierra Linda')`, [biz]);
  await fresh.query(`insert into public.member_invites (business_id, email, role) values ($1, 'juhagovi@gmail.com', 'owner')`, [biz]);
  const owner2 = (await fresh.query(`insert into auth.users (email) values ('juhagovi@gmail.com') returning id`)).rows[0].id;
  const r = (await asOn(fresh, owner2, `select public.import_backup($1, $2::jsonb) r`, [biz, JSON.stringify(data)]))[0].r;
  assert.ok(r.sales > 0, JSON.stringify(r));
  const t2 = (await asOn(fresh, owner2, `select sum(amount + tip)::int t from public.sales where status = 'valida'`))[0].t;
  assert.equal(t2, total);
  const p1 = (await as(owner, `select sum(amount)::int t, count(*)::int n from public.sale_payments where business_id = $1`, [biz]))[0];
  const p2 = (await asOn(fresh, owner2, `select sum(amount)::int t, count(*)::int n from public.sale_payments`))[0];
  assert.deepEqual([p2.t, p2.n], [p1.t, p1.n]);
  const c1 = (await as(owner, `select count(*)::int n from public.sales where business_id = $1`, [biz]))[0].n;
  const c2 = (await asOn(fresh, owner2, `select count(*)::int n from public.sales`))[0].n;
  assert.equal(c2, c1);
  // Después de restaurar, los números de turno del día no se repiten.
  const max = (await asOn(fresh, owner2, `select coalesce(max(turn_number),0)::int m from public.turns where local_date = (now() at time zone 'America/Bogota')::date`))[0].m;
  const t = (await asOn(fresh, owner2, `select * from public.add_turn($1, 'Nuevo', '')`, [biz]))[0];
  assert.equal(t.turn_number, max + 1);
});

console.log(results.join('\n'));
console.log(`\n${passed} de ${results.length} pruebas pasaron.`);
if (passed !== results.length) process.exit(1);
