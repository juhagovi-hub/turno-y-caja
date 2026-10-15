"""Capturas de la aplicación con datos de ejemplo (Supabase simulado)."""
import re, threading, http.server, functools, pathlib, sys
sys.argv = ["x"]
src = open(pathlib.Path(__file__).with_name("smoke.py")).read()
STUB = re.search(r'STUB = r"""(.*?)"""', src, re.S).group(1).replace("<img src=x onerror=window.__xss=1>", "Ana Lucía")
from playwright.sync_api import sync_playwright

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
OUT = pathlib.Path("/tmp/claude-0/-home-claude/c14eaa0e-ea03-5ea1-be0d-f3b4131520e8/scratchpad/capturas")
OUT.mkdir(parents=True, exist_ok=True)
PORT = 8766
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Q, directory=str(WEB))).serve_forever(), daemon=True).start()

def prep(page, logged=True):
    stub = STUB if logged else STUB.replace('getSession: function(){ return Promise.resolve({data:{session:{user:{id:"u1", email:"juhagovi@gmail.com"}}}}); }', 'getSession: function(){ return Promise.resolve({data:{session:null}}); }')
    page.route("**/supabase.js", lambda r: r.fulfill(status=200, content_type="application/javascript", body=stub))
    page.route("**/config.js", lambda r: r.fulfill(status=200, content_type="application/javascript",
        body='window.TYC_CONFIG={supabaseUrl:"https://x.supabase.co",supabaseKey:"k",businessSlug:"tierra-linda"};'))
    page.route("https://fonts.googleapis.com/**", lambda r: r.abort())
    page.route("https://fonts.gstatic.com/**", lambda r: r.abort())

with sync_playwright() as p:
    br = p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    # 1. Pantalla pública en celular
    pg = br.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2); prep(pg)
    pg.goto(f"http://127.0.0.1:{PORT}/index.html"); pg.wait_for_timeout(500)
    pg.fill("#myTurn", "4"); pg.wait_for_timeout(200)
    pg.screenshot(path=str(OUT / "1-cliente-celular.png"), full_page=True); pg.close()
    # 2. Inicio de sesión
    pg = br.new_page(viewport={"width": 390, "height": 760}, device_scale_factor=2); prep(pg, logged=False)
    pg.goto(f"http://127.0.0.1:{PORT}/panel.html"); pg.wait_for_timeout(500)
    pg.screenshot(path=str(OUT / "2-inicio-sesion.png")); pg.close()
    # 3-5. Panel en computador
    pg = br.new_page(viewport={"width": 1280, "height": 900}); prep(pg)
    pg.goto(f"http://127.0.0.1:{PORT}/panel.html"); pg.wait_for_timeout(800)
    pg.click('[data-a="openCo"]'); pg.wait_for_timeout(150)
    pg.select_option(".co-service", label="Corte y barba — $32.000"); pg.wait_for_timeout(150)
    pg.fill(".co-tip", "3000"); pg.click('.method-btn[data-method="transferencia"]'); pg.wait_for_timeout(150)
    pg.locator("#secFila").scroll_into_view_if_needed()
    pg.screenshot(path=str(OUT / "3-panel-fila-y-cobro.png"), clip={"x": 0, "y": 0, "width": 1280, "height": 1250}, full_page=True)
    pg.locator("#secCaja").screenshot(path=str(OUT / "4-panel-caja.png"))
    pg.locator("#secMetricas").screenshot(path=str(OUT / "5-panel-metricas.png"))
    pg.fill("#clientSearchInput", "3005551234"); pg.click("#clientSearchBtn"); pg.wait_for_timeout(500)
    pg.locator("#secClientes").screenshot(path=str(OUT / "6-panel-cliente.png"))
    br.close()
print("\n".join(sorted(str(x) for x in OUT.iterdir())))
