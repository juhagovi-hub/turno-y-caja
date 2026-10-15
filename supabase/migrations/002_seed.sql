-- Datos iniciales: el negocio y la invitación del dueño.
-- El nombre visible se puede cambiar luego; el slug forma parte del link público.
insert into public.businesses (slug, name, timezone)
values ('tierra-linda', 'The Ganga Barber Shop', 'America/Bogota')
on conflict (slug) do nothing;

insert into public.member_invites (business_id, email, role, display_name)
select id, 'juhagovi@gmail.com', 'owner', 'Julio' from public.businesses where slug = 'tierra-linda'
on conflict (business_id, email) do nothing;
