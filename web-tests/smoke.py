"""Prueba de humo de la web con un Supabase simulado: carga ambas páginas en Chromium,
recorre el flujo principal del panel y falla ante cualquier error de JavaScript."""
import json, sys, threading, http.server, functools, pathlib
from playwright.sync_api import sync_playwright

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
PORT = 8765

STUB = r"""
(function(){
  var now = new Date().toISOString();
  var bog = new Date(Date.now() - 5*3600e3); var today = bog.toISOString().slice(0,10);
  var DB = {
    businesses: [{id:"b1", name:"Barbería Tierra Linda", slug:"tierra-linda", timezone:"America/Bogota"}],
    services: [{id:"s1", name:"Corte", price:25000, duration_min:35, active:true, description:"", created_at:now},
               {id:"s2", name:"Corte y barba", price:32000, duration_min:45, active:true, description:"", created_at:now}],
    turns: [{id:"t1", turn_number:1, display_name:"Julio Gómez", client_id:"c1", client_type:"recurrente", status:"atendiendo", arrived_at:now, started_at:now, barber_id:null, clients:{identifier:"3164893957"}},
            {id:"t2", turn_number:2, display_name:"<img src=x onerror=window.__xss=1>", client_id:null, client_type:"sin_id", status:"esperando", arrived_at:now, started_at:null, barber_id:null, clients:null},
            {id:"t4", turn_number:4, display_name:"Andrés Mina", client_id:"c2", client_type:"recurrente", status:"esperando", arrived_at:now, started_at:null, barber_id:null, clients:{identifier:"3005551234"}},
            {id:"t5", turn_number:5, display_name:"Brayan", client_id:null, client_type:"nuevo", status:"esperando", arrived_at:now, started_at:null, barber_id:null, clients:null}],
    sales: [{id:"v1", status:"valida", client_id:"c1", client_name:"Julio Gómez", client_type:"nuevo", service_name:"Corte", list_price:25000, discount:0, amount:25000, tip:0,
             completed_at:now, started_at:now, arrived_at:now, local_date:today, local_hour:16, local_dow:4, void_reason:null, sale_payments:[{method:"efectivo", amount:25000}]},
            {id:"v2", status:"valida", client_id:null, client_name:"Diego", client_type:"sin_id", service_name:"Corte y barba", list_price:32000, discount:2000, amount:30000, tip:3000,
             completed_at:now, started_at:null, arrived_at:now, local_date:today, local_hour:17, local_dow:4, void_reason:null, sale_payments:[{method:"transferencia", amount:33000}]}],
    clients: [{id:"c1", name:"Julio Gómez", identifier:"3164893957"},{id:"c2", name:"Andrés Mina", identifier:"3005551234"},{id:"c3", name:"Kevin Riascos", identifier:"3157778899"}],
    members: [{user_id:"u1", role:"owner", display_name:"Julio"}],
    member_invites: [{email:"socio@example.com", role:"admin", display_name:"Socio"}],
    barbers: [], sale_payments: []
  };
  (function demoMonth(){
    var y = +today.slice(0,4), m = +today.slice(5,7), d0 = +today.slice(8,10);
    var svc = [["Corte",25000],["Corte y barba",32000],["Corte",25000],["Barba",12000],["Corte",25000]];
    var cli = [["c1","Julio Gómez"],["c2","Andrés Mina"],["c3","Kevin Riascos"],[null,"Cliente"],[null,"Cliente"],["c2","Andrés Mina"]];
    var methods = ["efectivo","efectivo","transferencia","tarjeta","efectivo","transferencia"];
    var n = 0;
    for (var day = 1; day < d0; day++) {
      var dt = new Date(Date.UTC(y, m-1, day)); var dow = dt.getUTCDay(); if (dow === 1) continue;
      var count = (dow === 5 || dow === 6) ? 9 : (dow === 0 ? 4 : 5);
      for (var k = 0; k < count; k++, n++) {
        var s = svc[n % svc.length], c = cli[n % cli.length], meth = methods[n % methods.length];
        var hour = (dow >= 5 ? [10,11,14,15,16,17,17,18,19] : [9,11,15,17,18])[k % (dow >= 5 ? 9 : 5)];
        var key = y + "-" + String(m).padStart(2,"0") + "-" + String(day).padStart(2,"0");
        var at = new Date(Date.UTC(y, m-1, day, hour + 5, (k*7)%60)).toISOString();
        var tip = n % 7 === 0 ? 2000 : 0;
        DB.sales.push({id:"d"+n, status:"valida", client_id:c[0], client_name:c[1], client_type: c[0] ? (n < 6 ? "nuevo" : "recurrente") : "sin_id",
          service_name:s[0], list_price:s[1], discount:0, amount:s[1], tip:tip, completed_at:at, started_at:new Date(Date.parse(at)-35*60000).toISOString(),
          arrived_at:at, local_date:key, local_hour:hour, local_dow:dow, void_reason:null, sale_payments:[{method:meth, amount:s[1]+tip}]});
      }
    }
  })();
  window.__calls = [];
  function builder(table){
    var single = false, filters = [];
    function rows(){
      return (DB[table] || []).filter(function(r){
        return filters.every(function(f){
          var v = r[f[1]];
          if (v === undefined) return true;
          if (f[0]==="eq") return v === f[2];
          if (f[0]==="in") return f[2].indexOf(v) >= 0;
          if (f[0]==="gte") return v >= f[2];
          if (f[0]==="lte") return v <= f[2];
          if (f[0]==="ilike") return String(v).toLowerCase().indexOf(String(f[2]).replace(/%/g,"").toLowerCase()) >= 0;
          return true;
        });
      });
    }
    var b = { then: function(res, rej){ var d = rows(); return Promise.resolve({data: single ? (d[0]||null) : d, error:null}).then(res, rej); } };
    ["eq","in","gte","lte","ilike"].forEach(function(m){ b[m] = function(f, v){ filters.push([m, f, v]); return b; }; });
    ["select","order","limit"].forEach(function(m){ b[m] = function(){ return b; }; });
    b.range = function(a){ var self = b; var orig = rows; return { then: function(res, rej){ var d = a === 0 ? orig() : []; return Promise.resolve({data:d, error:null}).then(res, rej); } }; };
    b.maybeSingle = b.single = function(){ single = true; return b; };
    return b;
  }
  var RPC = {
    my_role: "owner",
    public_board: {business:"Barbería Tierra Linda", serving:[{turn:1,name:"Julio",started_at:now}], waiting:[{turn:2,name:"Ana"},{turn:3,name:"Carlos"},{turn:4,name:"Andrés"},{turn:5,name:"Brayan"}], avg_minutes:35, now:now},
    add_turn: {id:"t3", turn_number:3, display_name:"Ana"},
    checkout: {id:"v3", service_name:"Corte", amount:25000, tip:0},
    start_turn: {}, back_to_waiting: {}, retire_turn: {}, void_sale: {}, save_service: {}, invite_member: null,
    import_backup: {sales:3, clients:1, services:2, skipped:0}, update_client_name: {}
  };
  window.supabase = { createClient: function(){ return {
    auth: { getSession: function(){ return Promise.resolve({data:{session:{user:{id:"u1", email:"juhagovi@gmail.com"}}}}); },
            onAuthStateChange: function(){ return {data:{subscription:{unsubscribe:function(){}}}}; },
            signOut: function(){ return Promise.resolve({}); } },
    from: builder,
    rpc: function(name, args){ window.__calls.push([name, args]); return Promise.resolve({data: RPC[name], error:null}); },
    channel: function(){ var c = { on: function(){ return c; }, subscribe: function(cb){ cb && cb("SUBSCRIBED"); return c; } }; return c; },
    removeChannel: function(){}
  }; } };
})();
"""

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def serve():
    h = functools.partial(Quiet, directory=str(WEB))
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h).serve_forever()

threading.Thread(target=serve, daemon=True).start()
failures = []
def check(cond, msg):
    print(("PASA  " if cond else "FALLA ") + msg)
    if not cond: failures.append(msg)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    for width in (390, 1100):
        page = browser.new_page(viewport={"width": width, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route("**/supabase.js", lambda r: r.fulfill(status=200, content_type="application/javascript", body=STUB))
        page.route("**/config.js", lambda r: r.fulfill(status=200, content_type="application/javascript",
            body='window.TYC_CONFIG={supabaseUrl:"https://x.supabase.co",supabaseKey:"k",businessSlug:"tierra-linda"};'))
        page.route("https://fonts.googleapis.com/**", lambda r: r.abort())
        page.route("https://fonts.gstatic.com/**", lambda r: r.abort())

        # Pantalla pública
        page.goto(f"http://127.0.0.1:{PORT}/index.html"); page.wait_for_timeout(600)
        check(page.inner_text("#servingBlock").strip().startswith("#1"), f"[{width}px] Pantalla pública: muestra el turno en atención")
        page.fill("#myTurn", "3"); page.wait_for_timeout(100)
        res = page.inner_text("#myTurnResult")
        check("1 persona" in res and "min" in res, f"[{width}px] Pantalla pública: 'mi turno' calcula personas y minutos ({res})")
        check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), f"[{width}px] Pantalla pública: sin desplazamiento horizontal")
        page.screenshot(path=str(WEB.parent / f"web-tests/publica-{width}.png"), full_page=True)

        # Panel
        page.goto(f"http://127.0.0.1:{PORT}/panel.html"); page.wait_for_timeout(900)
        check(page.is_visible("#appView"), f"[{width}px] Panel: entra con sesión y muestra la app")
        check(page.evaluate("window.__xss") is None, f"[{width}px] Panel: un nombre con código no se ejecuta")
        check("$58.000" in page.inner_text("#statToday"), f"[{width}px] Panel: caja de hoy suma servicios + propinas ($58.000)")
        check("$33.000" in page.inner_text("#statToday"), f"[{width}px] Panel: transferencia sumada en su método")
        page.click('[data-a="openCo"]'); page.wait_for_timeout(100)
        page.fill(".co-tip", "2000"); page.wait_for_timeout(100)
        check("$27.000" in page.inner_text(".co-total-val"), f"[{width}px] Panel: total a recibir = precio + propina")
        page.click('.method-btn[data-method="transferencia"]')
        page.click('[data-a="confirmCo"]'); page.click('[data-a="confirmCo"]', timeout=500, force=True, no_wait_after=True) if page.is_visible('[data-a="confirmCo"]') else None
        page.wait_for_timeout(400)
        calls = page.evaluate("window.__calls.filter(c => c[0]==='checkout')")
        check(len(calls) == 1, f"[{width}px] Panel: doble clic en cobrar envía un solo cobro ({len(calls)})")
        check(calls and calls[0][1]["p_method"] == "transferencia" and calls[0][1]["p_tip"] == 2000 and calls[0][1]["p_service"] == "s1", f"[{width}px] Panel: el cobro lleva servicio, propina y método")
        page.fill("#nameInput", "Ana"); page.click("#addBtn"); page.wait_for_timeout(300)
        check(any(c[0] == "add_turn" for c in page.evaluate("window.__calls")), f"[{width}px] Panel: agregar a la fila llama a la base de datos")
        check(page.is_visible("#secEquipo"), f"[{width}px] Panel: el dueño ve Equipo y Respaldo")
        check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), f"[{width}px] Panel: sin desplazamiento horizontal")
        page.screenshot(path=str(WEB.parent / f"web-tests/panel-{width}.png"), full_page=True)
        check(not errors, f"[{width}px] Sin errores de JavaScript {errors}")
        page.close()
    browser.close()

print(f"\n{'TODO OK' if not failures else str(len(failures)) + ' FALLAS'}")
sys.exit(1 if failures else 0)
