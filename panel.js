// Turno y Caja — panel de control (Supabase).
(function () {
  "use strict";
  var T = window.TYC, $ = function (id) { return document.getElementById(id); };
  var sb = T.makeClient();
  var CFG = window.TYC_CONFIG;

  var S = {
    user: null, biz: null, role: null, isAdmin: false,
    queue: [], services: [], today: [], monthPast: [], monthPartial: false,
    busy: {}, drafts: {}, open: {}, pending: 0, realtime: "off",
    dayKey: T.dateKey(), channel: null, lastQueueSig: "", lastSalesSig: ""
  };

  /* ---------------- Interfaz: avisos y sincronización ---------------- */
  var toastTimer;
  function toast(msg, isError) {
    var t = $("toast"); t.textContent = msg; t.className = "toast" + (isError ? " error" : ""); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 6500 : 3200);
  }
  function setSync() {
    var p = $("syncPill");
    if (!navigator.onLine) { p.className = "sync-pill off"; p.textContent = "Sin internet"; return; }
    if (S.pending > 0) { p.className = "sync-pill busy"; p.textContent = "Guardando…"; return; }
    if (S.realtime === "ok") { p.className = "sync-pill ok"; p.textContent = "En vivo"; return; }
    p.className = "sync-pill busy"; p.textContent = "Actualizando cada 20 s";
  }
  window.addEventListener("online", setSync); window.addEventListener("offline", setSync);
  async function rpc(name, args) {
    S.pending++; setSync();
    try {
      var r = await sb.rpc(name, args);
      if (r.error) throw r.error;
      return r.data;
    } finally { S.pending--; setSync(); }
  }
  async function q(builder) { var r = await builder; if (r.error) throw r.error; return r.data; }

  function show(view) {
    $("loginView").hidden = view !== "login";
    $("noAccessView").hidden = view !== "noaccess";
    $("appView").hidden = view !== "app";
  }

  /* ---------------- Autenticación ---------------- */
  var mode = "login";
  function setMode(m) {
    mode = m;
    $("tabLogin").setAttribute("aria-selected", String(m === "login"));
    $("tabSignup").setAttribute("aria-selected", String(m === "signup"));
    $("authSubmit").textContent = m === "login" ? "Entrar" : "Crear cuenta";
    $("authPassword").autocomplete = m === "login" ? "current-password" : "new-password";
    $("signupHint").hidden = m !== "signup";
    $("forgotBtn").hidden = m !== "login";
    $("authStatus").textContent = ""; $("authStatus").className = "status-line";
  }
  $("tabLogin").addEventListener("click", function () { setMode("login"); });
  $("tabSignup").addEventListener("click", function () { setMode("signup"); });
  function authMsg(text, kind) { $("authStatus").textContent = text; $("authStatus").className = "status-line" + (kind ? " " + kind : ""); }
  function panelUrl() { return location.href.split("#")[0].split("?")[0]; }

  $("authForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var email = $("authEmail").value.trim().toLowerCase(), pass = $("authPassword").value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { authMsg("Escribe un correo válido.", "error"); return; }
    if (pass.length < 8) { authMsg("La contraseña debe tener al menos 8 caracteres.", "error"); return; }
    $("authSubmit").disabled = true; authMsg(mode === "login" ? "Entrando…" : "Creando cuenta…");
    try {
      if (mode === "login") {
        var r = await sb.auth.signInWithPassword({ email: email, password: pass });
        if (r.error) throw r.error;
      } else {
        var s = await sb.auth.signUp({ email: email, password: pass, options: { emailRedirectTo: panelUrl() } });
        if (s.error) throw s.error;
        if (!s.data.session) authMsg("Listo. Revisa tu correo y abre el enlace para confirmar la cuenta; luego entra aquí.", "ok");
      }
    } catch (er) {
      var m = er.message || "";
      if (/Invalid login credentials/i.test(m)) authMsg("Correo o contraseña incorrectos.", "error");
      else if (/Email not confirmed/i.test(m)) authMsg("Aún no confirmas tu correo. Busca el mensaje de confirmación (revisa también spam).", "error");
      else if (/already registered/i.test(m)) authMsg("Ese correo ya tiene cuenta. Usa \"Entrar\".", "error");
      else if (/rate limit/i.test(m)) authMsg("Demasiados intentos. Espera unos minutos.", "error");
      else authMsg(T.errText(er), "error");
    } finally { $("authSubmit").disabled = false; }
  });
  $("forgotBtn").addEventListener("click", async function () {
    var email = $("authEmail").value.trim().toLowerCase();
    if (!email) { authMsg("Escribe tu correo arriba y vuelve a tocar \"Olvidé mi contraseña\".", "error"); return; }
    var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: panelUrl() });
    if (r.error) authMsg(T.errText(r.error), "error");
    else authMsg("Si ese correo tiene cuenta, te llegó un enlace para cambiar la contraseña.", "ok");
  });
  $("newPassForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var p = $("newPassword").value;
    if (p.length < 8) { $("newPassStatus").textContent = "Mínimo 8 caracteres."; return; }
    var r = await sb.auth.updateUser({ password: p });
    if (r.error) { $("newPassStatus").textContent = T.errText(r.error); return; }
    $("newPassForm").hidden = true; $("authForm").hidden = false;
    toast("Contraseña actualizada.");
    start();
  });
  document.addEventListener("click", async function (e) {
    if (!e.target.closest("[data-logout]")) return;
    if (S.channel) { sb.removeChannel(S.channel); S.channel = null; }
    await sb.auth.signOut();
    location.reload();
  });

  /* ---------------- Arranque ---------------- */
  async function start() {
    if (!sb) {
      show("login");
      $("authForm").hidden = true;
      authMsg("El panel aún no está conectado a la base de datos (falta configurar config.js).", "error");
      return;
    }
    var sess = (await sb.auth.getSession()).data.session;
    if (!sess) { show("login"); setMode("login"); return; }
    S.user = sess.user;
    try {
      var biz = await q(sb.from("businesses").select("id,name,slug,timezone").eq("slug", CFG.businessSlug).maybeSingle());
      if (!biz) { $("noAccessEmail").textContent = S.user.email; show("noaccess"); return; }
      S.biz = biz;
      S.role = await rpc("my_role", { b: biz.id });
      S.isAdmin = S.role === "owner" || S.role === "admin";
    } catch (er) { show("login"); authMsg(T.errText(er), "error"); return; }

    show("app");
    document.title = "Panel · " + S.biz.name;
    $("bizTitle").innerHTML = T.esc(S.biz.name) + '<small id="whoAmI">' + T.esc(S.user.email) + " · " + ({ owner: "Dueño", admin: "Administrador", barber: "Barbero" }[S.role] || S.role) + "</small>";
    document.querySelectorAll("[data-admin]").forEach(function (el) { el.hidden = !S.isAdmin; });
    $("reportDate").value = T.dateKey();
    setSync();
    await Promise.allSettled([loadServices(), loadQueue(), loadToday()]);
    loadMonth();
    if (S.isAdmin) loadTeam();
    subscribe();
    setInterval(tick, 20000);
  }
  sb && sb.auth.onAuthStateChange(function (event) {
    if (event === "PASSWORD_RECOVERY") { show("login"); $("authForm").hidden = true; $("newPassForm").hidden = false; }
  });

  function tick() {
    if (document.hidden) return;
    var k = T.dateKey();
    if (k !== S.dayKey) { S.dayKey = k; S.today = []; loadToday(); loadMonth(); }
    if (S.realtime !== "ok") { loadQueue(); loadToday(); }
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden && S.biz) { loadQueue(); loadToday(); } });

  var reloadTimers = {};
  function debounce(key, fn, ms) { clearTimeout(reloadTimers[key]); reloadTimers[key] = setTimeout(fn, ms || 300); }
  function subscribe() {
    var f = "business_id=eq." + S.biz.id;
    S.channel = sb.channel("tyc-" + S.biz.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "turns", filter: f }, function () { debounce("q", loadQueue); })
      .on("postgres_changes", { event: "*", schema: "public", table: "sales", filter: f }, function () { debounce("s", function () { loadToday(); debounce("m", loadMonth, 1500); }); })
      .on("postgres_changes", { event: "*", schema: "public", table: "services", filter: f }, function () { debounce("v", loadServices); })
      .subscribe(function (status) { S.realtime = status === "SUBSCRIBED" ? "ok" : "off"; setSync(); });
  }

  /* ---------------- Carga de datos ---------------- */
  async function loadQueue() {
    try {
      S.queue = await q(sb.from("turns").select("id,turn_number,display_name,client_id,client_type,status,arrived_at,started_at,barber_id,clients(identifier,tier,founder_until)")
        .eq("business_id", S.biz.id).in("status", ["esperando", "atendiendo"]).order("arrived_at", { ascending: true }).limit(200));
      Object.keys(S.drafts).forEach(function (k) { if (k.indexOf("void:") !== 0 && !S.queue.some(function (t) { return t.id === k; })) delete S.drafts[k]; });
      renderQueue();
    } catch (e) { console.error(e); }
  }
  async function loadServices() {
    try {
      S.services = await q(sb.from("services").select("*").eq("business_id", S.biz.id).order("active", { ascending: false }).order("created_at", { ascending: true }));
      renderServices(); renderQueue(true);
    } catch (e) { console.error(e); }
  }
  var SALE_COLS = "*,sale_payments(method,amount)";
  async function loadToday() {
    try {
      var rows = await q(sb.from("sales").select(SALE_COLS).eq("business_id", S.biz.id).eq("local_date", T.dateKey()).order("completed_at", { ascending: false }).limit(1000));
      S.today = rows.map(T.normSale);
      renderCaja(); renderMetrics(); renderQueue(true);
    } catch (e) { console.error(e); }
  }
  async function fetchSales(startKey, endKey) {
    var out = [], page = 0;
    for (; page < 60; page++) {
      var rows = await q(sb.from("sales").select(SALE_COLS).eq("business_id", S.biz.id).gte("local_date", startKey).lte("local_date", endKey)
        .order("completed_at", { ascending: true }).order("id", { ascending: true }).range(page * 1000, page * 1000 + 999));
      rows.forEach(function (r) { out.push(T.normSale(r)); });
      if (rows.length < 1000) return { sales: out, partial: false };
    }
    return { sales: out, partial: true };
  }
  var monthLoading = false;
  async function loadMonth() {
    if (monthLoading) return; monthLoading = true;
    try {
      var today = T.dateKey(), start = today.slice(0, 7) + "-01";
      if (start < today) { var r = await fetchSales(start, T.addDaysKey(today, -1)); S.monthPast = r.sales; S.monthPartial = r.partial; }
      else { S.monthPast = []; S.monthPartial = false; }
      $("metricsUpdated").textContent = "Actualizado " + T.fmtTime(Date.now());
    } catch (e) { console.error(e); S.monthPartial = true; $("metricsUpdated").textContent = "No se pudo actualizar"; }
    finally { monthLoading = false; renderCaja(); renderMetrics(); renderQueue(true); }
  }
  function monthSales() { return S.monthPast.concat(S.today); }
  function avgMinutes() {
    var d = monthSales().filter(function (s) { return s.status === "valida" && s.startedAt && s.completedAt; })
      .sort(function (a, b) { return T.toMs(b.completedAt) - T.toMs(a.completedAt); })
      .map(function (s) { return (T.toMs(s.completedAt) - T.toMs(s.startedAt)) / 60000; })
      .filter(function (m) { return m >= 3 && m <= 180; }).slice(0, 20).sort(function (a, b) { return a - b; });
    if (d.length >= 3) return Math.round(d[Math.floor(d.length / 2)]);
    var dur = S.services.filter(function (s) { return s.active && s.duration_min; });
    return dur.length ? Math.round(dur.reduce(function (a, s) { return a + s.duration_min; }, 0) / dur.length) : null;
  }

  /* ---------------- Fila ---------------- */
  function activeServices() { return S.services.filter(function (s) { return s.active; }); }
  function getDraft(id) {
    var d = S.drafts[id];
    if (!d) {
      var f = activeServices()[0];
      d = S.drafts[id] = { serviceId: f ? f.id : "otro", price: f ? f.price : "", customName: "", discount: 0, tip: 0, method: "efectivo", error: "" };
    }
    if (d.serviceId !== "otro" && !activeServices().some(function (s) { return s.id === d.serviceId; })) {
      var g = activeServices()[0]; d.serviceId = g ? g.id : "otro"; d.price = g ? g.price : "";
    }
    return d;
  }
  function totals(d, tierDisc) {
    var price = T.num(d.price), discount = T.num(d.discount), tip = T.num(d.tip), td = tierDisc || 0;
    return { price: price, discount: discount, tierDisc: td, tip: tip, amount: price - td - discount, total: price - td - discount + tip };
  }
  function queueTurn(id) { return S.queue.find(function (x) { return x.id === id; }); }
  // Fundador vigente: marcado como fundador y con vigencia (60 días desde la última visita o desde que se marcó).
  function founderActive(c) { return !!(c && c.tier === "fundador" && c.founder_until && Date.parse(c.founder_until) > Date.now()); }
  function founderExpired(c) { return !!(c && c.tier === "fundador" && !founderActive(c)); }
  function isFounder(t) { return !!(t && founderActive(t.clients)); }
  // Descuento por tarifa fundador (solo informativo en pantalla: el servidor lo calcula y lo aplica).
  function founderDisc(id, d) {
    if (!isFounder(queueTurn(id)) || d.serviceId === "otro") return 0;
    var s = S.services.find(function (x) { return x.id === d.serviceId; });
    return s && s.founder_price && s.founder_price < s.price ? s.price - s.founder_price : 0;
  }
  function renderQueue(force) {
    var sig = JSON.stringify(S.queue.map(function (t) { return [t.id, t.status, t.display_name, t.clients && t.clients.tier, t.clients && t.clients.founder_until]; })) + JSON.stringify(S.services.map(function (s) { return [s.id, s.price, s.active, s.founder_price]; })) + JSON.stringify(S.open) + JSON.stringify(S.busy);
    if (!force && sig === S.lastQueueSig) return;
    S.lastQueueSig = sig;
    var avg = avgMinutes();
    $("queueEtaHint").textContent = avg ? "Atención promedio: " + avg + " min" : "";
    var el = $("queueList");
    if (!S.queue.length) { el.innerHTML = '<p class="empty-note">No hay nadie en la fila.</p>'; return; }
    var hasServing = S.queue.some(function (t) { return t.status === "atendiendo"; });
    el.innerHTML = S.queue.map(function (t) {
      var serving = t.status === "atendiendo", b = S.busy["q:" + t.id] || S.busy["co:" + t.id], dis = b ? " disabled" : "";
      var ident = t.clients && t.clients.identifier;
      var h = '<div class="control-row' + (serving ? " serving" : "") + '" data-id="' + T.esc(t.id) + '"><div class="top">' +
        '<span class="num">#' + T.esc(t.turn_number) + '</span><span class="who">' + T.esc(t.display_name || "Cliente") +
        '<small>' + (ident ? T.esc(T.maskId(ident)) + " · " : "") + "llegó " + T.esc(T.fmtTime(t.arrived_at)) + (t.started_at ? " · empezó " + T.esc(T.fmtTime(t.started_at)) : "") + '</small></span>' +
        (isFounder(t) ? '<span class="state fundador">Fundador</span>' : founderExpired(t.clients) ? '<span class="state vencido">Fundador vencido</span>' : "") +
        (t.client_type === "nuevo" ? '<span class="state nuevo">Nuevo</span>' : t.client_type === "recurrente" ? '<span class="state">Recurrente</span>' : "") +
        '<span class="state' + (serving ? " atendiendo" : "") + '">' + (serving ? "En atención" : "Esperando") + "</span></div><div class=\"actions\">";
      if (serving) h += '<button type="button" class="btn btn-accent" data-a="openCo"' + dis + '>Cobrar</button><button type="button" class="btn btn-ghost btn-small" data-a="back"' + dis + '>Devolver a la fila</button>';
      else h += '<button type="button" class="btn btn-ghost" data-a="start"' + ((hasServing || b) ? " disabled" : "") + '>Atender</button>';
      if (S.isAdmin && t.client_id) h += '<button type="button" class="btn btn-ghost btn-small" data-a="tier" data-tier="' + (isFounder(t) ? "general" : "fundador") + '"' + dis + '>' + (isFounder(t) ? "Quitar fundador" : founderExpired(t.clients) ? "Renovar fundador" : "Marcar fundador") + "</button>";
      h += '<button type="button" class="btn btn-ghost btn-small" data-a="openRet"' + dis + '>Retirar</button></div>';
      if (S.open["ret:" + t.id]) h += '<div class="actions"><span class="hint">¿Por qué sale de la fila?</span><button type="button" class="btn btn-ghost btn-small" data-a="ret" data-kind="retirado">Se fue</button><button type="button" class="btn btn-ghost btn-small" data-a="ret" data-kind="ausente">No estaba al llamarlo</button><button type="button" class="btn btn-ghost btn-small" data-a="closeRet">Cancelar</button></div>';
      if (serving && S.open["co:" + t.id]) h += checkoutHtml(t.id);
      return h + "</div>";
    }).join("");
  }
  function checkoutHtml(id) {
    var d = getDraft(id), td = founderDisc(id, d), t = totals(d, td), b = S.busy["co:" + id], fund = isFounder(queueTurn(id));
    var chips = activeServices().map(function (s) {
      var fp = fund && s.founder_price && s.founder_price < s.price;
      return '<button type="button" class="svc-chip" data-svc="' + T.esc(s.id) + '" aria-pressed="' + (d.serviceId === s.id) + '"><span>' + T.esc(s.name) + "</span><strong>" +
        (fp ? T.money(s.founder_price) + ' <s class="hint">' + T.money(s.price) + "</s>" : T.money(s.price)) + "</strong></button>";
    }).join("") + '<button type="button" class="svc-chip otro" data-svc="otro" aria-pressed="' + (d.serviceId === "otro") + '"><span>Otro</span><strong>precio manual</strong></button>';
    return '<div class="checkout">' + (fund ? '<p class="hint fundador-note">Cliente fundador: la tarifa fundador se aplica sola' + (td > 0 ? " (−" + T.money(td) + ")" : " (este servicio no tiene tarifa fundador)") + ".</p>" : "") + '<span class="field">Servicio</span><div class="svc-chips" role="group" aria-label="Servicio">' + chips + "</div>" +
      (activeServices().length ? "" : '<p class="hint">Aún no hay servicios guardados. Créalos en "Servicios y tarifas" para elegirlos aquí con un toque.</p>') +
      '<div class="co-grid">' +
      (d.serviceId === "otro" ? '<label class="field">Nombre del servicio<input type="text" class="co-name" value="' + T.esc(d.customName) + '" placeholder="ej. Diseño"></label>' : "") +
      '<label class="field">Precio<input type="number" class="co-price" inputmode="numeric" min="0" step="1000" value="' + T.esc(d.price) + '"' + (d.serviceId !== "otro" ? " readonly" : "") + "></label>" +
      '<label class="field">Descuento<input type="number" class="co-discount" inputmode="numeric" min="0" step="1000" value="' + T.esc(d.discount) + '"></label>' +
      '<label class="field">Propina<input type="number" class="co-tip" inputmode="numeric" min="0" step="1000" value="' + T.esc(d.tip) + '"></label></div>' +
      '<div class="method-toggle" role="group" aria-label="Método de pago">' + T.METHODS.map(function (m) { return '<button type="button" class="method-btn" data-method="' + m + '" aria-pressed="' + (d.method === m) + '">' + T.METHOD_LABEL[m] + "</button>"; }).join("") + "</div>" +
      '<div class="co-total">Total a recibir:<strong class="co-total-val">' + T.money(t.total) + "</strong>" + (t.tip > 0 ? ' <span class="hint">(servicio ' + T.money(t.amount) + " + propina " + T.money(t.tip) + ")</span>" : "") + "</div>" +
      '<div class="actions"><button type="button" class="btn btn-accent btn-big" data-a="confirmCo"' + (b ? " disabled" : "") + ">" + (b ? "Guardando…" : "Confirmar cobro") + "</button>" +
      '<button type="button" class="btn btn-ghost btn-small" data-a="closeCo"' + (b ? " disabled" : "") + ">Cancelar</button></div>" +
      '<p class="form-error">' + T.esc(d.error || "") + "</p></div>";
  }
  $("queueList").addEventListener("click", function (e) {
    var btn = e.target.closest("button"); if (!btn) return;
    var row = e.target.closest(".control-row"); if (!row) return;
    var id = row.dataset.id, a = btn.dataset.a;
    if (btn.classList.contains("method-btn")) { getDraft(id).method = btn.dataset.method; renderQueue(true); return; }
    if (btn.classList.contains("svc-chip")) {
      var dr = getDraft(id), sv = S.services.find(function (x) { return x.id === btn.dataset.svc; });
      dr.serviceId = btn.dataset.svc; dr.price = sv ? sv.price : ""; dr.error = "";
      renderQueue(true); return;
    }
    if (a === "start") turnAction(id, "start_turn", null);
    else if (a === "back") turnAction(id, "back_to_waiting", "Turno devuelto a la fila.");
    else if (a === "openRet") { S.open["ret:" + id] = true; renderQueue(true); }
    else if (a === "closeRet") { delete S.open["ret:" + id]; renderQueue(true); }
    else if (a === "ret") { delete S.open["ret:" + id]; turnAction(id, "retire_turn", btn.dataset.kind === "ausente" ? "Marcado como ausente. No cuenta como venta." : "Marcado como retirado. No cuenta como venta.", { p_kind: btn.dataset.kind }); }
    else if (a === "openCo") { S.open["co:" + id] = true; renderQueue(true); }
    else if (a === "closeCo") { delete S.open["co:" + id]; renderQueue(true); }
    else if (a === "confirmCo") checkout(id);
    else if (a === "tier") { var qt = queueTurn(id); if (qt && qt.client_id) setTier(qt.client_id, btn.dataset.tier, loadQueue); }
  });
  $("queueList").addEventListener("input", function (e) {
    var row = e.target.closest(".control-row"); if (!row) return;
    var d = getDraft(row.dataset.id), c = e.target.classList;
    if (c.contains("co-price")) d.price = e.target.value;
    else if (c.contains("co-discount")) d.discount = e.target.value;
    else if (c.contains("co-tip")) d.tip = e.target.value;
    else if (c.contains("co-name")) { d.customName = e.target.value; return; }
    else return;
    var v = row.querySelector(".co-total-val"); if (v) v.textContent = T.money(totals(d, founderDisc(row.dataset.id, d)).total);
  });
  $("queueList").addEventListener("change", function (e) {
    if (!e.target.classList.contains("co-service")) return;
    var d = getDraft(e.target.closest(".control-row").dataset.id);
    d.serviceId = e.target.value;
    var s = S.services.find(function (x) { return x.id === d.serviceId; });
    d.price = s ? s.price : "";
    renderQueue(true);
  });

  async function setTier(clientId, tier, after) {
    var key = "tier:" + clientId; if (S.busy[key]) return;
    S.busy[key] = true;
    try {
      await rpc("set_client_tier", { p_client: clientId, p_tier: tier });
      toast(tier === "fundador" ? "Cliente marcado como fundador." : "Cliente marcado como general.");
      if (after) await after();
    } catch (e) { toast(T.errText(e), true); }
    finally { delete S.busy[key]; }
  }

  async function turnAction(id, fn, okMsg, extra) {
    var key = "q:" + id; if (S.busy[key]) return;
    S.busy[key] = true; renderQueue(true);
    try {
      var args = Object.assign({ p_turn: id }, extra || {});
      await rpc(fn, args);
      if (okMsg) toast(okMsg);
      await loadQueue();
    } catch (e) { toast(T.errText(e), true); loadQueue(); }
    finally { delete S.busy[key]; renderQueue(true); }
  }

  async function checkout(id) {
    var key = "co:" + id; if (S.busy[key]) return;
    var d = getDraft(id), t = totals(d, founderDisc(id, d));
    d.error = "";
    if (!(t.price > 0)) d.error = "El precio del servicio debe ser mayor que cero.";
    else if (t.discount < 0 || t.tip < 0) d.error = "El descuento y la propina no pueden ser negativos.";
    else if (t.discount > t.price - t.tierDisc) d.error = "El descuento no puede ser mayor que el precio.";
    if (d.error) { renderQueue(true); return; }
    S.busy[key] = true; renderQueue(true);
    try {
      var sale = await rpc("checkout", {
        p_turn: id, p_service: d.serviceId === "otro" ? null : d.serviceId,
        p_custom_name: d.serviceId === "otro" ? (d.customName || "Otro servicio") : null,
        p_custom_price: d.serviceId === "otro" ? Math.round(t.price) : null,
        p_discount: Math.round(t.discount), p_tip: Math.round(t.tip), p_method: d.method
      });
      delete S.drafts[id]; delete S.open[key];
      toast("Cobro guardado: " + sale.service_name + " · " + T.money(sale.amount + sale.tip) + ".");
      await Promise.allSettled([loadQueue(), loadToday()]);
    } catch (e) { d.error = T.errText(e); toast("No se guardó el cobro. " + d.error, true); }
    finally { delete S.busy[key]; renderQueue(true); }
  }

  /* ---------------- Agregar a la fila ---------------- */
  async function addTurn() {
    if (S.busy.add) return;
    var name = $("nameInput").value.trim(), ident = T.normId($("clientIdInput").value);
    if (!name && !ident) { toast("Escribe al menos el nombre o el celular.", true); $("nameInput").focus(); return; }
    S.busy.add = true; $("addBtn").disabled = true;
    try {
      var t = await rpc("add_turn", { p_business: S.biz.id, p_name: name, p_identifier: ident });
      toast("Turno #" + t.turn_number + " agregado" + (t.display_name ? " para " + t.display_name.split(" ")[0] : "") + ".");
      $("nameInput").value = ""; $("clientIdInput").value = ""; $("clientHint").textContent = ""; $("clientHint").className = "client-hint";
      $("nameInput").focus();
      loadQueue();
    } catch (e) { toast("No se agregó el turno. " + T.errText(e), true); }
    finally { S.busy.add = false; $("addBtn").disabled = false; }
  }
  $("addBtn").addEventListener("click", addTurn);
  $("nameInput").addEventListener("keydown", function (e) { if (e.key === "Enter") addTurn(); });
  $("clientIdInput").addEventListener("keydown", function (e) { if (e.key === "Enter") addTurn(); });

  async function clientSales(clientId) {
    var rows = await q(sb.from("sales").select(SALE_COLS).eq("business_id", S.biz.id).eq("client_id", clientId).order("completed_at", { ascending: true }).limit(1000));
    return rows.map(T.normSale);
  }
  $("clientIdInput").addEventListener("blur", async function () {
    var id = T.normId($("clientIdInput").value), hint = $("clientHint");
    if (!id || id.length < 6) { hint.textContent = ""; hint.className = "client-hint"; return; }
    try {
      var c = await q(sb.from("clients").select("id,name").eq("business_id", S.biz.id).eq("identifier", id).maybeSingle());
      if (!c) { hint.textContent = "Cliente nuevo: quedará registrado al agregarlo."; hint.className = "client-hint"; return; }
      if (!$("nameInput").value.trim() && c.name) $("nameInput").value = c.name;
      var hist = (await clientSales(c.id)).filter(function (s) { return s.status === "valida"; });
      if (hist.length) {
        var last = hist[hist.length - 1];
        hint.textContent = "Recurrente: " + hist.length + (hist.length === 1 ? " visita" : " visitas") + " · última " + T.fmtDateTime(last.completedAt) + " (" + last.serviceName + ")";
        hint.className = "client-hint recurrente";
      } else { hint.textContent = "Registrado, pero aún sin cortes cobrados."; hint.className = "client-hint"; }
    } catch (e) { console.error(e); }
  });
  $("nameInput").addEventListener("blur", async function () {
    if (T.normId($("clientIdInput").value)) return;
    var name = $("nameInput").value.trim(), hint = $("clientHint");
    if (name.length < 3) return;
    try {
      var rows = await q(sb.from("clients").select("id,name,identifier").eq("business_id", S.biz.id).ilike("name", name.replace(/[%_]/g, "")).limit(3));
      if (!rows.length) { hint.textContent = ""; hint.className = "client-hint"; return; }
      hint.className = "client-hint dup";
      hint.innerHTML = "Ya hay " + (rows.length === 1 ? "un cliente" : rows.length + " clientes") + " con ese nombre. " +
        rows.filter(function (r) { return r.identifier; }).map(function (r) { return '<button type="button" class="btn btn-ghost btn-small" data-use="' + T.esc(r.identifier) + '">Usar ' + T.esc(T.maskId(r.identifier)) + "</button>"; }).join(" ");
    } catch (e) { console.error(e); }
  });
  $("clientHint").addEventListener("click", function (e) {
    var b = e.target.closest("[data-use]"); if (!b) return;
    $("clientIdInput").value = b.dataset.use; $("clientIdInput").dispatchEvent(new Event("blur"));
  });

  /* ---------------- Caja ---------------- */
  function statCard(title, s, extra) {
    var total = s.recaudo;
    var bars = T.METHODS.map(function (m) { return '<span class="' + m + '" style="width:' + (total > 0 ? (s.byMethod[m] / total) * 100 : 0) + '%"></span>'; }).join("");
    var legend = T.METHODS.map(function (m) { return '<div><span><span class="dot" style="background:var(--' + (m === "efectivo" ? "cash" : m === "tarjeta" ? "card" : "transfer") + ')"></span>' + T.METHOD_LABEL[m] + "</span><span>" + T.money(s.byMethod[m]) + "</span></div>"; }).join("");
    return "<h3>" + T.esc(title) + '</h3><div class="stat-total">' + T.money(total) + '</div><div class="split-bar">' + bars + '</div><div class="split-legend">' + legend + "</div>" +
      '<div class="stat-sub">' + s.count + (s.count === 1 ? " servicio" : " servicios") + " · ticket promedio " + T.money(s.ticket) +
      (s.propinas > 0 ? " · propinas " + T.money(s.propinas) : "") + (s.descuentos > 0 ? " · descuentos " + T.money(s.descuentos) + (s.tierDescuentos > 0 ? " (tarifa fundador " + T.money(s.tierDescuentos) + ")" : "") : "") + (extra || "") +
      (s.anuladas ? " · " + s.anuladas + (s.anuladas === 1 ? " anulada" : " anuladas") : "") + "</div>";
  }
  function renderCaja() {
    $("statToday").innerHTML = statCard("Hoy", T.summarize(S.today), "");
    var sm = T.summarize(monthSales());
    $("statMonth").innerHTML = statCard("Este mes", sm, " · " + sm.nuevos + " nuevos · " + sm.recurrentes + " recurrentes") +
      (S.monthPartial ? '<div class="stat-sub" style="color:var(--warn)">Cifra parcial: no se pudo cargar todo el mes.</div>' : "");
    renderTodaySales();
  }
  function renderTodaySales(force) {
    var list = S.today.slice().sort(function (a, b) { return T.toMs(b.completedAt) - T.toMs(a.completedAt); });
    var sig = JSON.stringify(list.map(function (s) { return [s.id, s.status]; })) + JSON.stringify(S.open) + JSON.stringify(S.busy);
    if (!force && sig === S.lastSalesSig) return;
    S.lastSalesSig = sig;
    var el = $("todaySalesList");
    if (!list.length) { el.innerHTML = '<p class="empty-note">Todavía no hay ventas hoy.</p>'; return; }
    el.innerHTML = list.map(function (s) {
      var voided = s.status === "anulada";
      var h = '<div class="sale-row' + (voided ? " anulada" : "") + '" data-id="' + T.esc(s.id) + '"><div class="top"><span class="time">' + T.esc(T.fmtTime(s.completedAt)) + "</span>" +
        '<span class="desc">' + T.esc(s.name || "Cliente") + " · " + T.esc(s.serviceName) + " · " + T.esc(s.pays.map(function (p) { return T.METHOD_LABEL[p.method]; }).join(" + ")) +
        (s.discount > 0 ? " · desc. " + T.money(s.discount) : "") + (s.tip > 0 ? " · propina " + T.money(s.tip) : "") + "</span>" +
        '<span class="amt">' + T.money(s.amount + s.tip) + "</span>" +
        (voided ? '<span class="state anulada">Anulada</span>' : (S.isAdmin ? '<button type="button" class="btn btn-ghost btn-small" data-a="openVoid">Anular</button>' : "")) + "</div>";
      if (voided && s.voidReason) h += '<span class="hint">Motivo: ' + T.esc(s.voidReason) + "</span>";
      if (!voided && S.open["void:" + s.id]) h += '<div class="row"><input type="text" class="void-reason" placeholder="Motivo de la anulación (obligatorio)" value="' + T.esc(S.drafts["void:" + s.id] || "") + '">' +
        '<button type="button" class="btn btn-accent btn-small" data-a="confirmVoid"' + (S.busy["void:" + s.id] ? " disabled" : "") + ">Confirmar anulación</button>" +
        '<button type="button" class="btn btn-ghost btn-small" data-a="closeVoid">Cancelar</button></div>';
      return h + "</div>";
    }).join("");
  }
  $("todaySalesList").addEventListener("click", function (e) {
    var btn = e.target.closest("button"); if (!btn) return;
    var row = e.target.closest(".sale-row"), id = row.dataset.id, a = btn.dataset.a;
    if (a === "openVoid") { S.open["void:" + id] = true; renderTodaySales(true); }
    else if (a === "closeVoid") { delete S.open["void:" + id]; renderTodaySales(true); }
    else if (a === "confirmVoid") voidSale(id, (row.querySelector(".void-reason") || {}).value || "");
  });
  $("todaySalesList").addEventListener("input", function (e) {
    if (e.target.classList.contains("void-reason")) S.drafts["void:" + e.target.closest(".sale-row").dataset.id] = e.target.value;
  });
  async function voidSale(id, reason) {
    var key = "void:" + id; if (S.busy[key]) return;
    if (reason.trim().length < 3) { toast("Escribe el motivo de la anulación.", true); return; }
    S.busy[key] = true; renderTodaySales(true);
    try {
      await rpc("void_sale", { p_sale: id, p_reason: reason.trim() });
      delete S.open[key]; delete S.drafts[key];
      toast("Venta anulada. Queda en el historial, pero ya no suma.");
      await loadToday(); loadMonth();
    } catch (e) { toast("No se anuló. " + T.errText(e), true); }
    finally { delete S.busy[key]; renderTodaySales(true); }
  }

  /* ---------------- Servicios ---------------- */
  function renderServices() {
    var el = $("servicesList");
    if (el.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
    if (!S.services.length) { el.innerHTML = '<p class="empty-note">Aún no hay servicios.' + (S.isAdmin ? " Agrega el primero abajo." : " Un administrador debe crearlos.") + "</p>"; return; }
    var ro = S.isAdmin ? "" : " readonly";
    el.innerHTML = S.services.map(function (s) {
      return '<div class="svc-row' + (s.active ? "" : " inactivo") + '" data-id="' + T.esc(s.id) + '">' +
        '<label class="field name">Nombre' + (s.active ? "" : " (desactivado)") + '<input type="text" class="svc-name" value="' + T.esc(s.name) + '"' + ro + "></label>" +
        '<label class="field">Precio (COP)<input type="number" class="svc-price" inputmode="numeric" min="0" step="1000" value="' + T.esc(s.price) + '"' + ro + "></label>" +
        '<label class="field">Duración (min)<input type="number" class="svc-dur" inputmode="numeric" min="0" step="5" value="' + T.esc(s.duration_min || "") + '"' + ro + "></label>" +
        '<label class="field">Tarifa fundador<input type="number" class="svc-founder" inputmode="numeric" min="0" step="1000" placeholder="sin tarifa" value="' + T.esc(s.founder_price || "") + '"' + ro + "></label>" +
        (S.isAdmin ? '<div class="actions"><button type="button" class="btn btn-ghost btn-small" data-a="save">Guardar</button><button type="button" class="btn btn-ghost btn-small" data-a="toggle">' + (s.active ? "Desactivar" : "Activar") + "</button></div>" : "<div></div>") + "</div>";
    }).join("");
  }
  $("servicesList").addEventListener("click", async function (e) {
    var btn = e.target.closest("button"); if (!btn || !S.isAdmin) return;
    var row = e.target.closest(".svc-row"), s = S.services.find(function (x) { return x.id === row.dataset.id; }); if (!s) return;
    var key = "svc:" + s.id; if (S.busy[key]) return;
    var name = row.querySelector(".svc-name").value.trim(), price = T.num(row.querySelector(".svc-price").value), dur = T.num(row.querySelector(".svc-dur").value), founder = T.num(row.querySelector(".svc-founder").value);
    var active = btn.dataset.a === "toggle" ? !s.active : s.active;
    if (btn.dataset.a === "toggle") { name = s.name; price = s.price; dur = s.duration_min || 0; founder = s.founder_price || 0; }
    else if (name === s.name && price === s.price && dur === (s.duration_min || 0) && founder === (s.founder_price || 0)) { toast("No hay cambios para guardar."); return; }
    else if (founder > 0 && founder >= price) { toast("La tarifa fundador debe ser menor que el precio de lista.", true); return; }
    S.busy[key] = true; btn.disabled = true;
    try {
      await rpc("save_service", { p_business: S.biz.id, p_id: s.id, p_name: name, p_description: s.description || "", p_price: Math.round(price), p_duration: Math.round(dur) || null, p_active: active, p_founder_price: Math.round(founder) || null });
      if (document.activeElement) document.activeElement.blur();
      toast(btn.dataset.a === "toggle" ? (active ? "Servicio activado." : "Servicio desactivado.") : "Tarifa actualizada. Las ventas anteriores conservan su precio.");
      await loadServices();
    } catch (er) { toast(T.errText(er), true); }
    finally { delete S.busy[key]; btn.disabled = false; }
  });
  $("svcAddBtn").addEventListener("click", async function () {
    var name = $("svcNameInput").value.trim(), price = T.num($("svcPriceInput").value), dur = T.num($("svcDurInput").value), founder = T.num($("svcFounderInput").value);
    $("svcError").textContent = "";
    if (!name) { $("svcError").textContent = "Escribe el nombre del servicio."; return; }
    if (!(price > 0)) { $("svcError").textContent = "El precio debe ser mayor que cero."; return; }
    if (founder > 0 && founder >= price) { $("svcError").textContent = "La tarifa fundador debe ser menor que el precio de lista."; return; }
    if (S.busy.svcAdd) return; S.busy.svcAdd = true; $("svcAddBtn").disabled = true;
    try {
      await rpc("save_service", { p_business: S.biz.id, p_id: null, p_name: name, p_description: "", p_price: Math.round(price), p_duration: Math.round(dur) || null, p_active: true, p_founder_price: Math.round(founder) || null });
      $("svcNameInput").value = ""; $("svcPriceInput").value = ""; $("svcDurInput").value = ""; $("svcFounderInput").value = "";
      toast("Servicio agregado."); await loadServices();
    } catch (e) { $("svcError").textContent = T.errText(e); }
    finally { S.busy.svcAdd = false; $("svcAddBtn").disabled = false; }
  });

  /* ---------------- Métricas ---------------- */
  function barChart(el, keys, labels, counts) {
    var max = 0; keys.forEach(function (k) { max = Math.max(max, counts[k] || 0); });
    el.innerHTML = keys.map(function (k) {
      var v = counts[k] || 0, pct = max > 0 ? Math.max((v / max) * 100, v > 0 ? 6 : 2) : 2;
      return '<div class="bar-col' + (max > 0 && v === max ? " top" : "") + '"><span class="val">' + v + '</span><div class="bar" style="height:' + pct + '%"></div><span class="lbl">' + T.esc(labels[k]) + "</span></div>";
    }).join("");
  }
  function renderMetrics() {
    var s = T.summarize(monthSales());
    var ident = s.nuevos + s.recurrentes, ret = ident ? Math.round((s.recurrentes / ident) * 100) : 0;
    $("kpis").innerHTML = [["Servicios", s.count], ["Ticket promedio", T.money(s.ticket)], ["Clientes nuevos", s.nuevos], ["Visitas recurrentes", ret + "%"]]
      .map(function (k) { return '<div class="kpi"><div class="v">' + T.esc(k[1]) + '</div><div class="k">' + T.esc(k[0]) + "</div></div>"; }).join("");
    barChart($("dowChart"), T.DOW_ORDER, T.DOW_LABEL, s.byDow);
    var hours = Object.keys(s.byHour).map(Number), hMin = Math.min.apply(null, hours.concat([8])), hMax = Math.max.apply(null, hours.concat([20])), hk = [], hl = {};
    for (var h = hMin; h <= hMax; h++) { hk.push(h); hl[h] = h; }
    barChart($("hourChart"), hk, hl, s.byHour);
    var clients = Object.keys(s.byClient).map(function (id) { return Object.assign({ id: id }, s.byClient[id]); }).sort(function (a, b) { return b.visits - a.visits || b.spent - a.spent; }).slice(0, 5);
    $("topClients").innerHTML = clients.length ? clients.map(function (c, i) {
      var pd = T.topKey(c.dows);
      return '<div class="rank-row"><span class="rank">#' + (i + 1) + '</span><span class="who"><span class="nm">' + T.esc(c.name) + '</span><span class="meta">' + T.money(c.spent) + (pd != null ? " · prefiere " + T.DOW_LABEL[pd] : "") + '</span></span><span class="count">' + c.visits + "</span></div>";
    }).join("") : '<p class="empty-note">Aún no hay clientes identificados este mes.</p>';
    var svcs = Object.keys(s.byService).map(function (n) { return { name: s.byService[n].name, count: s.byService[n].count, total: s.byService[n].total }; }).sort(function (a, b) { return b.count - a.count; }).slice(0, 5);
    $("topServices").innerHTML = svcs.length ? svcs.map(function (v, i) {
      return '<div class="rank-row"><span class="rank">#' + (i + 1) + '</span><span class="who"><span class="nm">' + T.esc(v.name) + '</span><span class="meta">' + T.money(v.total) + '</span></span><span class="count">' + v.count + "</span></div>";
    }).join("") : '<p class="empty-note">Aún no hay ventas este mes.</p>';
  }
  $("metricsRefresh").addEventListener("click", function () { loadToday(); loadMonth(); });

  /* ---------------- Clientes ---------------- */
  async function showClient(clientId) {
    var out = $("clientSearchResult"); out.innerHTML = '<p class="empty-note">Buscando…</p>';
    try {
      var c = await q(sb.from("clients").select("*").eq("id", clientId).single());
      var hist = (await clientSales(clientId)).filter(function (s) { return s.status === "valida"; });
      var spent = hist.reduce(function (a, s) { return a + s.amount; }, 0), dows = {};
      hist.forEach(function (s) { dows[s.dow] = (dows[s.dow] || 0) + 1; });
      var pd = T.topKey(dows), gaps = [];
      for (var i = 1; i < hist.length; i++) gaps.push((T.toMs(hist[i].completedAt) - T.toMs(hist[i - 1].completedAt)) / 86400000);
      var avgGap = gaps.length ? Math.round(gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length) : null;
      var rows = hist.slice(-12).reverse().map(function (s) { return "<tr><td>" + T.esc(T.fmtDateTime(s.completedAt)) + "</td><td>" + T.esc(s.serviceName) + "</td><td>" + T.money(s.amount) + "</td><td>" + T.esc(T.METHOD_LABEL[s.method] || s.method) + "</td></tr>"; }).join("");
      out.innerHTML = '<div class="client-card" data-client="' + T.esc(c.id) + '"><span class="nm">' + T.esc(c.name || "Cliente") + ' <span class="hint">' + T.esc(T.maskId(c.identifier)) + "</span>" + (founderActive(c) ? ' <span class="state fundador">Fundador</span>' : founderExpired(c) ? ' <span class="state vencido">Fundador vencido</span>' : "") + "</span>" +
        (founderActive(c) ? '<span class="row2">Tarifa fundador vigente hasta el ' + T.esc(T.fmtDate(c.founder_until)) + ". Se renueva sola con cada visita (vence a los 60 días sin venir).</span>" : "") +
        '<span class="row2">' + hist.length + (hist.length === 1 ? " visita" : " visitas") + " · gasto acumulado " + T.money(spent) + " · promedio " + T.money(hist.length ? spent / hist.length : 0) +
        (pd != null ? " · prefiere " + T.DOW_LABEL[pd] : "") + (avgGap != null ? (avgGap <= 1 ? " · viene casi a diario" : " · vuelve cada ~" + avgGap + " días") : "") + "</span>" +
        '<span class="row2">Primera visita: ' + T.esc(hist.length ? T.fmtDateTime(hist[0].completedAt) : "—") + " · última: " + T.esc(hist.length ? T.fmtDateTime(hist[hist.length - 1].completedAt) : "—") + "</span>" +
        (rows ? '<div class="table-wrap"><table class="mini-table"><thead><tr><th>Fecha</th><th>Servicio</th><th>Cobrado</th><th>Método</th></tr></thead><tbody>' + rows + "</tbody></table></div>" : "") +
        '<div class="row"><input type="text" class="edit-name" value="' + T.esc(c.name) + '" aria-label="Corregir nombre"><button type="button" class="btn btn-ghost btn-small" data-a="saveName">Corregir nombre</button></div>' +
        (S.isAdmin ? '<div class="row"><button type="button" class="btn btn-ghost btn-small" data-a="tier" data-tier="' + (founderActive(c) ? "general" : "fundador") + '">' + (founderActive(c) ? "Quitar tarifa fundador" : founderExpired(c) ? "Renovar tarifa fundador" : "Marcar como cliente fundador") + "</button></div>" : "") + "</div>";
    } catch (e) { out.innerHTML = '<p class="empty-note">' + T.esc(T.errText(e)) + "</p>"; }
  }
  $("clientSearchBtn").addEventListener("click", async function () {
    var qy = $("clientSearchInput").value.trim(), out = $("clientSearchResult");
    if (!qy) { out.innerHTML = ""; return; }
    try {
      var id = T.normId(qy), rows;
      if (id.length >= 6 && /^[0-9\s+-]+$/.test(qy)) rows = await q(sb.from("clients").select("id,name,identifier").eq("business_id", S.biz.id).eq("identifier", id).limit(1));
      else rows = await q(sb.from("clients").select("id,name,identifier").eq("business_id", S.biz.id).ilike("name", "%" + qy.replace(/[%_]/g, "") + "%").order("name").limit(8));
      if (rows.length === 1) { showClient(rows[0].id); return; }
      out.innerHTML = rows.length ? rows.map(function (r) { return '<button type="button" class="match-btn" data-client-id="' + T.esc(r.id) + '">' + T.esc(r.name || "Cliente") + "<small>" + T.esc(T.maskId(r.identifier)) + "</small></button>"; }).join("")
        : '<p class="empty-note">No se encontró ningún cliente.</p>';
    } catch (e) { out.innerHTML = '<p class="empty-note">' + T.esc(T.errText(e)) + "</p>"; }
  });
  $("clientSearchInput").addEventListener("keydown", function (e) { if (e.key === "Enter") $("clientSearchBtn").click(); });
  $("clientSearchResult").addEventListener("click", async function (e) {
    var m = e.target.closest("[data-client-id]"); if (m) { showClient(m.dataset.clientId); return; }
    var tb = e.target.closest('[data-a="tier"]');
    if (tb) { var cc = tb.closest(".client-card"); setTier(cc.dataset.client, tb.dataset.tier, function () { return showClient(cc.dataset.client); }); return; }
    var b = e.target.closest('[data-a="saveName"]'); if (!b) return;
    var card = e.target.closest(".client-card"), name = card.querySelector(".edit-name").value.trim();
    if (!name) { toast("El nombre no puede quedar vacío.", true); return; }
    b.disabled = true;
    try { await rpc("update_client_name", { p_client: card.dataset.client, p_name: name }); toast("Nombre corregido. Las ventas pasadas conservan el nombre con que se registraron."); }
    catch (er) { toast(T.errText(er), true); } finally { b.disabled = false; }
  });

  /* ---------------- Reportes ---------------- */
  $("reportBtn").addEventListener("click", async function () {
    var st = $("reportStatus"); st.className = "status-line";
    var type = $("reportType").value, base = $("reportDate").value || T.dateKey(), method = $("reportMethod").value, r = T.reportRange(type, base);
    $("reportBtn").disabled = true; st.textContent = "Generando reporte…";
    try {
      var res = await fetchSales(r.start, r.end), all = res.sales;
      if (method) all = all.filter(function (s) { return s.pays.some(function (p) { return p.method === method; }); });
      var s = T.summarize(all), busiest = T.topKey(s.byDate), dowTop = T.topKey(s.byDow), hourTop = T.topKey(s.byHour), topC = null;
      Object.keys(s.byClient).forEach(function (id) { var c = s.byClient[id]; if (!topC || c.visits > topC.visits || (c.visits === topC.visits && c.spent > topC.spent)) topC = c; });
      var L = [], C = T.csvLine;
      L.push(C(["Turno y Caja — " + S.biz.name, r.label + (method ? " · solo " + T.METHOD_LABEL[method] : "")]));
      L.push(C(["Generado", T.fmtDateTime(Date.now()) + " (hora de Colombia) por " + S.user.email]));
      L.push("");
      L.push(C(["RESUMEN (solo ventas válidas)", "Valor"]));
      [["Recaudo total (servicios + propinas)", Math.round(s.recaudo)], ["Ventas de servicios", Math.round(s.ventas)], ["Propinas", Math.round(s.propinas)], ["Descuentos otorgados", Math.round(s.descuentos)], ["De ellos, por tarifa fundador", Math.round(s.tierDescuentos)], ["Servicios a clientes fundadores", s.fundadores],
       ["Efectivo", Math.round(s.byMethod.efectivo)], ["Tarjeta", Math.round(s.byMethod.tarjeta)], ["Transferencia", Math.round(s.byMethod.transferencia)],
       ["Servicios realizados", s.count], ["Ticket promedio", Math.round(s.ticket)], ["Clientes nuevos", s.nuevos], ["Visitas de clientes recurrentes", s.recurrentes],
       ["Servicios sin cliente identificado", s.sinId], ["Ventas anuladas (no suman)", s.anuladas],
       ["Fecha con más servicios", busiest ? T.fmtKey(busiest) + " (" + s.byDate[busiest] + ")" : "—"],
       ["Día de la semana con más servicios", dowTop != null ? T.DOW_LABEL[dowTop] + " (" + s.byDow[dowTop] + ")" : "—"],
       ["Hora con más servicios", hourTop != null ? T.pad(+hourTop) + ":00 (" + s.byHour[hourTop] + ")" : "—"],
       ["Cliente del periodo", topC ? topC.name + " (" + topC.visits + " visitas, " + T.money(topC.spent) + ")" : "Sin clientes identificados"]
      ].forEach(function (x) { L.push(C(x)); });
      L.push(""); L.push(C(["DETALLE"]));
      L.push(C(["ID venta", "Fecha", "Hora", "Cliente", "Tipo de cliente", "Servicio", "Precio de lista", "Descuento", "De ello: tarifa fundador", "Tarifa del cliente", "Cobrado por servicio", "Propina", "Método", "Efectivo", "Tarjeta", "Transferencia", "Llegada", "Inicio", "Estado", "Motivo de anulación"]));
      all.forEach(function (x) {
        var pm = { efectivo: 0, tarjeta: 0, transferencia: 0 }; x.pays.forEach(function (p) { if (pm[p.method] != null) pm[p.method] += p.amount; });
        L.push(C([x.id, T.fmtDate(x.completedAt), T.fmtTime(x.completedAt), x.name || "Cliente", x.clientType === "sin_id" ? "Sin identificar" : x.clientType, x.serviceName,
          x.listPrice, x.discount, x.tierDiscount, x.clientTier === "fundador" ? "Fundador" : "General", x.amount, x.tip, T.METHOD_LABEL[x.method] || x.method, pm.efectivo, pm.tarjeta, pm.transferencia,
          x.arrivedAt ? T.fmtTime(x.arrivedAt) : "", x.startedAt ? T.fmtTime(x.startedAt) : "", x.status === "anulada" ? "Anulada" : "Válida", x.voidReason]));
      });
      T.downloadFile("turno-y-caja-" + type + "-" + r.start + ".csv", "﻿" + L.join("\r\n"), "text/csv;charset=utf-8");
      st.textContent = "Reporte descargado: " + s.count + " ventas válidas, recaudo " + T.money(s.recaudo) + "." + (res.partial ? " Atención: el periodo es muy grande y puede estar incompleto." : "");
      st.className = "status-line ok";
    } catch (e) { st.textContent = "No se pudo generar el reporte. " + T.errText(e); st.className = "status-line error"; }
    finally { $("reportBtn").disabled = false; }
  });

  /* ---------------- Respaldo ---------------- */
  async function fetchAll(table) {
    var out = [];
    for (var page = 0; page < 200; page++) {
      var rows = await q(sb.from(table).select("*").eq("business_id", S.biz.id).order(table === "sale_payments" ? "id" : "id", { ascending: true }).range(page * 1000, page * 1000 + 999));
      out = out.concat(rows);
      if (rows.length < 1000) return out;
    }
    throw new Error("La tabla " + table + " es demasiado grande para un respaldo desde el navegador.");
  }
  $("backupBtn").addEventListener("click", async function () {
    var st = $("backupStatus"); st.className = "status-line"; st.textContent = "Preparando respaldo…"; $("backupBtn").disabled = true;
    try {
      var data = { app: "turno-y-caja", format: "supabase-v1", exportedAt: new Date().toISOString(), business: S.biz };
      var tables = ["services", "clients", "barbers", "turns", "sales", "sale_payments"];
      for (var i = 0; i < tables.length; i++) data[tables[i]] = await fetchAll(tables[i]);
      T.downloadFile("turno-y-caja-respaldo-" + T.dateKey() + ".json", JSON.stringify(data), "application/json");
      st.textContent = "Respaldo descargado: " + tables.map(function (t) { return t + " " + data[t].length; }).join(", ") + "."; st.className = "status-line ok";
    } catch (e) { st.textContent = "No se pudo crear el respaldo. " + T.errText(e); st.className = "status-line error"; }
    finally { $("backupBtn").disabled = false; }
  });
  var pendingRestore = null;
  $("restoreFile").addEventListener("change", function () {
    var f = this.files && this.files[0], st = $("backupStatus"), prev = $("restorePreview");
    pendingRestore = null; prev.innerHTML = ""; st.textContent = ""; st.className = "status-line";
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var d = JSON.parse(reader.result), desc;
        if (d.format === "supabase-v1") desc = (d.sales || []).length + " ventas, " + (d.clients || []).length + " clientes, " + (d.services || []).length + " servicios";
        else if (d.app === "turno-y-caja" && d.formatVersion === 1) desc = "respaldo del artifact anterior: " + ((d.collections || {}).payments || []).length + " ventas";
        else throw new Error("Este archivo no es un respaldo de Turno y Caja.");
        pendingRestore = d;
        prev.innerHTML = '<div class="client-card"><span class="nm">Respaldo del ' + T.esc(d.exportedAt ? T.fmtDateTime(d.exportedAt) : "—") + '</span><span class="row2">' + T.esc(desc) + '</span>' +
          '<div class="row"><button type="button" class="btn btn-accent btn-small" id="restoreGo">Restaurar</button><button type="button" class="btn btn-ghost btn-small" id="restoreCancel">Cancelar</button></div></div>';
      } catch (e) { st.textContent = e.message || "No se pudo leer el archivo."; st.className = "status-line error"; }
    };
    reader.readAsText(f);
  });
  $("restorePreview").addEventListener("click", async function (e) {
    if (e.target.id === "restoreCancel") { pendingRestore = null; $("restorePreview").innerHTML = ""; $("restoreFile").value = ""; return; }
    if (e.target.id !== "restoreGo" || !pendingRestore || S.busy.restore) return;
    var st = $("backupStatus"); S.busy.restore = true; e.target.disabled = true; st.textContent = "Restaurando…";
    try {
      var r = await rpc("import_backup", { p_business: S.biz.id, p_data: pendingRestore });
      st.textContent = "Restauración completa: " + r.sales + " ventas, " + r.clients + " clientes y " + r.services + " servicios agregados" + (r.skipped ? " (" + r.skipped + " ya existían)." : ".");
      st.className = "status-line ok";
      pendingRestore = null; $("restorePreview").innerHTML = ""; $("restoreFile").value = "";
      loadServices(); loadToday(); loadMonth();
    } catch (er) { st.textContent = "No se pudo restaurar. " + T.errText(er); st.className = "status-line error"; }
    finally { S.busy.restore = false; }
  });

  /* ---------------- Equipo ---------------- */
  async function loadTeam() {
    try {
      var members = await q(sb.from("members").select("user_id,role,display_name").eq("business_id", S.biz.id));
      var invites = await q(sb.from("member_invites").select("email,role,display_name").eq("business_id", S.biz.id).order("created_at"));
      var label = { owner: "Dueño", admin: "Administrador", barber: "Barbero" };
      $("teamList").innerHTML =
        "<h3>Con acceso</h3>" + members.map(function (m) { return '<div class="rank-row"><span class="who"><span class="nm">' + T.esc(m.display_name || (m.user_id === S.user.id ? S.user.email : "Miembro")) + "</span></span><span class=\"state\">" + T.esc(label[m.role]) + "</span></div>"; }).join("") +
        "<h3>Correos invitados</h3>" + (invites.length ? invites.map(function (i) { return '<div class="rank-row"><span class="who"><span class="nm">' + T.esc(i.email) + '</span><span class="meta">' + T.esc(i.display_name) + '</span></span><span class="state">' + T.esc(label[i.role]) + "</span></div>"; }).join("") : '<p class="empty-note">Ninguno.</p>');
    } catch (e) { console.error(e); }
  }
  $("inviteBtn").addEventListener("click", async function () {
    var email = $("inviteEmail").value.trim().toLowerCase(), name = $("inviteName").value.trim(), role = $("inviteRole").value, st = $("inviteStatus");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { st.textContent = "Escribe un correo válido."; st.className = "status-line error"; return; }
    $("inviteBtn").disabled = true;
    try {
      await rpc("invite_member", { p_business: S.biz.id, p_email: email, p_role: role, p_name: name });
      st.textContent = "Invitación guardada. Pídele que entre a este panel y elija \"Crear cuenta\" con " + email + "."; st.className = "status-line ok";
      $("inviteEmail").value = ""; $("inviteName").value = ""; loadTeam();
    } catch (e) { st.textContent = T.errText(e); st.className = "status-line error"; }
    finally { $("inviteBtn").disabled = false; }
  });

  document.querySelector(".nav-chips").addEventListener("click", function (e) {
    var b = e.target.closest("[data-goto]"); if (b) $(b.dataset.goto).scrollIntoView({ behavior: "smooth", block: "start" });
  });

  start();
})();
