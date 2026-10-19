// Turno y Caja — utilidades compartidas (fechas en hora de Colombia, dinero, resumen de ventas, CSV).
(function (g) {
  "use strict";
  var TZ_OFFSET_MS = 5 * 3600 * 1000; // Colombia: UTC-5, sin horario de verano
  var METHODS = ["efectivo", "tarjeta", "transferencia"];
  var METHOD_LABEL = { efectivo: "Efectivo", tarjeta: "Tarjeta", transferencia: "Transferencia", mixto: "Mixto" };
  var DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
  var DOW_LABEL = { 0: "Dom", 1: "Lun", 2: "Mar", 3: "Mié", 4: "Jue", 5: "Vie", 6: "Sáb" };

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function toMs(x) { return x instanceof Date ? x.getTime() : (typeof x === "number" ? x : Date.parse(x)); }
  function bog(x) { return new Date(toMs(x == null ? Date.now() : x) - TZ_OFFSET_MS); }
  function dateKey(x) { var b = bog(x); return b.getUTCFullYear() + "-" + pad(b.getUTCMonth() + 1) + "-" + pad(b.getUTCDate()); }
  function fmtDate(x) { var b = bog(x); return pad(b.getUTCDate()) + "/" + pad(b.getUTCMonth() + 1) + "/" + b.getUTCFullYear(); }
  function fmtTime(x) { var b = bog(x); return pad(b.getUTCHours()) + ":" + pad(b.getUTCMinutes()); }
  function fmtDateTime(x) { return x ? fmtDate(x) + ", " + fmtTime(x) : "—"; }
  function keyToUTC(k) { var p = k.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function utcToKey(ms) { var d = new Date(ms); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  function addDaysKey(k, n) { return utcToKey(keyToUTC(k) + n * 86400000); }
  function fmtKey(k) { var p = k.split("-"); return p[2] + "/" + p[1] + "/" + p[0]; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(n) { return "$" + Math.round(num(n)).toLocaleString("es-CO"); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function normId(raw) { return raw ? String(raw).replace(/[^0-9]/g, "") : ""; }
  function maskId(id) { return id ? "•••" + String(id).slice(-3) : ""; }
  function normName(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim(); }

  function reportRange(type, baseKey) {
    var y = +baseKey.slice(0, 4), m = +baseKey.slice(5, 7);
    if (type === "dia") return { start: baseKey, end: baseKey, label: "Diario " + fmtKey(baseKey) };
    if (type === "semana") {
      var dow = new Date(keyToUTC(baseKey)).getUTCDay();
      var start = addDaysKey(baseKey, dow === 0 ? -6 : 1 - dow);
      var end = addDaysKey(start, 6);
      return { start: start, end: end, label: "Semanal " + fmtKey(start) + " a " + fmtKey(end) };
    }
    if (type === "anio") return { start: y + "-01-01", end: y + "-12-31", label: "Anual " + y };
    return { start: y + "-" + pad(m) + "-01", end: utcToKey(Date.UTC(y, m, 0)), label: "Mensual " + pad(m) + "/" + y };
  }

  // Fila de la base de datos (sales + sale_payments) -> objeto de trabajo.
  function normSale(r) {
    var pays = (r.sale_payments || []).map(function (p) { return { method: p.method, amount: num(p.amount) }; });
    if (!pays.length) pays = [{ method: "efectivo", amount: num(r.amount) + num(r.tip) }];
    var methods = pays.map(function (p) { return p.method; }).filter(function (m, i, a) { return a.indexOf(m) === i; });
    return {
      id: r.id, status: r.status, turnId: r.turn_id, legacyId: r.legacy_id,
      clientId: r.client_id, name: r.client_name || "", clientType: r.client_type,
      clientTier: r.client_tier || "general", tierDiscount: num(r.tier_discount),
      serviceId: r.service_id, serviceName: r.service_name, listPrice: num(r.list_price), discount: num(r.discount),
      amount: num(r.amount), tip: num(r.tip), pays: pays, method: methods.length === 1 ? methods[0] : "mixto",
      barberId: r.barber_id, arrivedAt: r.arrived_at, startedAt: r.started_at, completedAt: r.completed_at,
      dateKey: r.local_date, hour: r.local_hour, dow: r.local_dow, voidReason: r.void_reason || ""
    };
  }

  // Un solo cálculo para pantalla y reportes: las cifras siempre coinciden.
  function summarize(sales) {
    var s = { ventas: 0, propinas: 0, recaudo: 0, count: 0, nuevos: 0, recurrentes: 0, sinId: 0, anuladas: 0, descuentos: 0, tierDescuentos: 0, fundadores: 0,
      byMethod: { efectivo: 0, tarjeta: 0, transferencia: 0 }, byDate: {}, byDow: {}, byHour: {}, byService: {}, byClient: {} };
    sales.forEach(function (x) {
      if (x.status === "anulada") { s.anuladas++; return; }
      s.count++; s.ventas += x.amount; s.propinas += x.tip; s.descuentos += x.discount;
      s.tierDescuentos += x.tierDiscount; if (x.clientTier === "fundador") s.fundadores++;
      x.pays.forEach(function (p) { var m = METHODS.indexOf(p.method) >= 0 ? p.method : "efectivo"; s.byMethod[m] += p.amount; s.recaudo += p.amount; });
      if (x.clientType === "nuevo") s.nuevos++; else if (x.clientType === "recurrente") s.recurrentes++; else s.sinId++;
      if (x.dateKey) s.byDate[x.dateKey] = (s.byDate[x.dateKey] || 0) + 1;
      if (x.dow != null) s.byDow[x.dow] = (s.byDow[x.dow] || 0) + 1;
      if (x.hour != null) s.byHour[x.hour] = (s.byHour[x.hour] || 0) + 1;
      var svKey = normName(x.serviceName); // "Corte" y "corte" cuentan como el mismo servicio
      var sv = s.byService[svKey] || (s.byService[svKey] = { name: x.serviceName, count: 0, total: 0 });
      sv.count++; sv.total += x.amount;
      if (x.clientId) {
        var c = s.byClient[x.clientId] || (s.byClient[x.clientId] = { name: x.name || "Cliente", visits: 0, spent: 0, dows: {} });
        c.visits++; c.spent += x.amount; if (x.name) c.name = x.name;
        if (x.dow != null) c.dows[x.dow] = (c.dows[x.dow] || 0) + 1;
      }
    });
    s.ticket = s.count ? s.ventas / s.count : 0;
    return s;
  }
  function topKey(obj) {
    var best = null, bv = 0;
    Object.keys(obj).forEach(function (k) { if (obj[k] > bv) { bv = obj[k]; best = k; } });
    return best;
  }
  function csvCell(v) { var s = String(v == null ? "" : v); if (/[;"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'; return s; }
  function csvLine(arr) { return arr.map(csvCell).join(";"); }
  function downloadFile(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function makeClient() {
    var c = g.TYC_CONFIG || {};
    if (!g.supabase || !c.supabaseUrl || /PENDIENTE/.test(c.supabaseUrl)) return null;
    return g.supabase.createClient(c.supabaseUrl, c.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true } });
  }
  function errText(e) {
    if (!e) return "Ocurrió un error inesperado.";
    var m = e.message || String(e);
    if (/Failed to fetch|NetworkError|network/i.test(m)) return "Sin conexión a internet. Revisa la red e inténtalo de nuevo.";
    if (/JWT expired|invalid JWT/i.test(m)) return "Tu sesión venció. Vuelve a iniciar sesión.";
    if (/permission denied/i.test(m)) return "No tienes permiso para esta acción.";
    return m;
  }

  g.TYC = { METHODS: METHODS, METHOD_LABEL: METHOD_LABEL, DOW_ORDER: DOW_ORDER, DOW_LABEL: DOW_LABEL,
    pad: pad, toMs: toMs, dateKey: dateKey, fmtDate: fmtDate, fmtTime: fmtTime, fmtDateTime: fmtDateTime,
    addDaysKey: addDaysKey, fmtKey: fmtKey, num: num, money: money, esc: esc, normId: normId, maskId: maskId,
    normName: normName, reportRange: reportRange, normSale: normSale, summarize: summarize, topKey: topKey,
    csvLine: csvLine, downloadFile: downloadFile, makeClient: makeClient, errText: errText };
})(typeof window !== "undefined" ? window : globalThis);
