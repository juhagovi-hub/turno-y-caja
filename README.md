# Turno y Caja — versión web con Supabase

## Qué hay aquí
- `supabase/migrations/001_turno_y_caja.sql`: tablas, permisos (RLS) y operaciones (turnos, cobro sin duplicados, retiros, anulaciones, servicios, clientes, pantalla pública, importación de respaldos).
- `supabase/migrations/002_seed.sql`: crea la barbería (`tierra-linda`) e invita al dueño (juhagovi@gmail.com).
- `supabase/tests/test.mjs`: 30 pruebas sobre Postgres real (`npm install && node test.mjs`).
- `web/index.html`: pantalla pública para los clientes (sin datos personales).
- `web/panel.html` + `panel.js`: panel con inicio de sesión.
- `web/config.js`: URL y llave pública de Supabase (se llenan al instalar).
- `web-tests/smoke.py`: prueba en navegador con Supabase simulado.

## Instalación (pendiente)
1. Supabase: pausar `parku-dev` y crear el proyecto `turno-y-caja` en la región São Paulo (sa-east-1), organización Strategos.
2. GitHub: crear el repositorio público vacío `juhagovi-hub/turno-y-caja`.
3. Aplicar `001` y `002` en el proyecto nuevo y llenar `web/config.js` con la URL y la publishable key.
4. Subir `web/` al repositorio y activar GitHub Pages (rama main, carpeta raíz).
   - Pantalla pública: https://juhagovi-hub.github.io/turno-y-caja/
   - Panel: https://juhagovi-hub.github.io/turno-y-caja/panel.html
5. En Supabase › Authentication › URL Configuration: Site URL = la dirección del panel (para que los correos de confirmación y de cambio de contraseña lleven ahí).
6. Julio crea su cuenta en el panel con juhagovi@gmail.com; luego invita al socio desde "Equipo".
7. Pasar los datos: descargar el respaldo del artifact y restaurarlo en "Respaldo". Las ventas importadas no se duplican aunque se repita.

## Cómo volver atrás
El artifact anterior sigue funcionando sin cambios hasta que se haga el paso 7; se puede seguir usando si algo falla.
