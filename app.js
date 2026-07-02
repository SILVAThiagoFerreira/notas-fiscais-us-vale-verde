/* =====================================================================
   Notas Fiscais - US Vale Verde
   Lê em tempo real a planilha Google Sheets (gviz) e renderiza os gráficos.
   Atualiza a cada acesso — sem servidor, sem build.

   Aspectos cobertos: valor do frete, valor total das NFs, quantidade
   transportada e nº de notas — todos como séries temporais mensais,
   recortes por produto e por origem, KPIs financeiros e tabela
   detalhada com busca/ordenação/paginação.
   ===================================================================== */

const SHEET_ID = "14Z-nzXSWC4iaqJcLWmaPOgYjGU2pOJeT";
const GVIZ_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&headers=1`;
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

/* Paleta do hub + cores para os produtos */
const C = {
  ink: "#38424B",
  inkFill: "rgba(56,66,75,0.12)",
  neutral: "#E20613",
  grid: "rgba(56,66,75,0.08)",
  text: "#6c747b",
  blue: "#1f6feb",
  purple: "#6f42c1",
  green: "#107c10",
  amber: "#c47b00",
};
const PRODUCT_COLORS = [
  "#E20613", "#38424B", "#1f6feb", "#6f42c1", "#107c10", "#c47b00",
  "#0d8a8a", "#b9387a", "#5a6c00", "#7a4b11", "#2c5f8d", "#8a2c2c",
];

const norm = (s) =>
  (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/\s+/g, " ").trim();

const escapeText = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) => escapeText(s).replace(/"/g, "&quot;");

const nfBR = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const dec2 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n) => nfBR.format(n || 0);
const fmtNum = (n, d = 0) =>
  new Intl.NumberFormat("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);
const fmtBRL = (n) => "R$ " + dec2.format(n || 0);
/** Versão compacta para KPIs grandes: R$ 3,05 mi / R$ 76,10 mi */
const fmtBRLcompact = (n) => {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return "R$ " + dec2.format(n / 1e6) + " mi";
  if (a >= 1e3) return "R$ " + dec2.format(n / 1e3) + " mil";
  return "R$ " + dec2.format(n);
};

const meses = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
function fmtDate(d) { return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear(); }
function monthKey(r) { return r.ano + "-" + String(r.mes).padStart(2, "0"); }
function monthLabel(k) { const [y, m] = k.split("-"); return meses[+m - 1] + "/" + y.slice(2); }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function sum(arr) { return arr.reduce((a, b) => a + (b || 0), 0); }
function weightedMean(rows, valueKey, weightKey) {
  let total = 0, weight = 0;
  rows.forEach((r) => {
    const value = r[valueKey], w = r[weightKey];
    if (value != null && w != null && w > 0) {
      total += value * w;
      weight += w;
    }
  });
  return weight ? total / weight : mean(rows.map((r) => r[valueKey]).filter((v) => v != null));
}

let RECORDS = [];
let CHARTS = {};
let STATE = { sortKey: "date", sortDir: "desc", page: 1, search: "" };
const PAGE_SIZE = 15;
const BLASTBAG_TOKEN = "BLASTBAG";

/* ===================== Carregamento ===================== */
async function loadSheet() {
  setStatus("loading", "Carregando notas fiscais…");
  let table;
  try {
    const res = await fetch(GVIZ_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("gviz HTTP " + res.status);
    table = parseGviz(await res.text());
  } catch (e) {
    console.warn("gviz falhou, tentando CSV:", e);
    try {
      const res = await fetch(CSV_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("csv HTTP " + res.status);
      table = parseCsv(await res.text());
    } catch (e2) {
      setStatus("error", "Não foi possível acessar a planilha. Verifique se o link está público.");
      throw e2;
    }
  }
  RECORDS = buildRecords(table);
  if (!RECORDS.length) {
    setStatus("error", "Planilha acessada, mas nenhuma nota encontrada.");
    return;
  }
  populateFilters();
  setStatus("ok", `${fmtInt(RECORDS.length)} notas carregadas.`);
  document.getElementById("last-update").textContent = "Atualizado em " + nowBR();
  render();
}

function parseGviz(txt) {
  const m = txt.match(/setResponse\((\{.*\})\);?\s*$/s);
  const json = JSON.parse(m ? m[1] : txt);
  return json.table;
}

function parseCsv(text) {
  const rows = csvToRows(text);
  const headers = rows.shift();
  const cols = headers.map((label) => ({ id: label, label, type: "string" }));
  const tableRows = rows.map((r) => ({ c: headers.map((h, i) => ({ v: r[i] != null ? r[i] : null })) }));
  return { cols, rows: tableRows };
}

function csvToRows(text) {
  const out = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n") { row.push(cur); out.push(row); row = []; cur = ""; }
      else if (ch === "\r") { /* skip */ }
      else cur += ch;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); out.push(row); }
  return out;
}

/* ===================== Construção dos registros ===================== */
function parseDateCell(v) {
  if (!v) return null;
  // gviz: Date(ano, mes0, dia, ...) — mês já 0-based, igual ao Date do JS.
  const m = String(v).match(/Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?/);
  if (m) {
    const dt = new Date(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
    return isNaN(dt.getTime()) ? null : dt;
  }
  // CSV fallback: "M/D/YYYY" (formato da planilha — mês/dia/ano).
  const p = String(v).trim().split("/");
  if (p.length === 3) {
    const mo = +p[0], d = +p[1], y = +p[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y > 1990) {
      const dt = new Date(y, mo - 1, d);
      return isNaN(dt.getTime()) ? null : dt;
    }
  }
  return null;
}

/** Lê número pt-BR de string ("R$ 8.449,20" / "38.000,00" / 8449.2). */
function br(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const s = String(v).replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function buildRecords(table) {
  const idx = {};
  table.cols.forEach((c, i) => { idx[norm(c.label)] = i; });
  const g = (key) => { const i = idx[key]; return i === undefined ? -1 : i; };

  const f = {
    data: g("DATA EMISSAO"),
    nf: g("NF NUMERO"), serie: g("SERIE"),
    emit: g("EMITENTE - RAZAO SOCIAL"), dest: g("DESTINATARIO - RAZAO SOCIAL"),
    origem: g("ORIGEM (MUNICIPIO/UF)"), destino: g("DESTINO (MUNICIPIO/UF)"),
    produto: g("PRODUTO - DESCRICAO"),
    qtde: g("QTDE"), unidade: g("UNIDADE"),
    vunit: g("VALOR UNITARIO"), vprod: g("VALOR TOTAL PRODUTOS"),
    vfrete: g("VALOR FRETE"), vtotal: g("VALOR TOTAL NF"),
  };

  const recs = [];
  for (const r of table.rows) {
    const cell = (i) => (i < 0 ? null : (r.c[i] && r.c[i].v != null ? r.c[i].v : null));
    const num = (i) => br(cell(i));
    const str = (i) => { const v = cell(i); return v == null ? "" : String(v).trim(); };

    const dt = parseDateCell(cell(f.data));
    if (!dt) continue;

    const vfrete = num(f.vfrete);
    const vtotal = num(f.vtotal);
    const qty = num(f.qtde);
    if (vfrete == null && vtotal == null && qty == null) continue;

    let unidade = norm(str(f.unidade)) || "—";
    if (unidade === "KG" || unidade === "KGS") unidade = "KG";
    if (unidade === "PC" || unidade === "PCS") unidade = "PC";
    if (unidade === "M" || unidade === "MTS") unidade = "M";

    recs.push({
      date: dt,
      ano: dt.getFullYear(),
      mes: dt.getMonth() + 1,
      nf: str(f.nf),
      serie: str(f.serie),
      emitente: str(f.emit),
      destinatario: str(f.dest),
      origem: str(f.origem) || "—",
      destino: str(f.destino) || "—",
      produto: str(f.produto) || "—",
      qty,
      unidade,
      vunit: num(f.vunit),
      vprod: num(f.vprod),
      vfrete,
      vtotal,
    });
  }
  recs.sort((a, b) => a.date - b.date);
  return recs;
}

/* ===================== Filtros ===================== */
function populateFilters() {
  const years = [...new Set(RECORDS.map((r) => r.ano).filter(Boolean))].sort();
  const origins = [...new Set(RECORDS.map((r) => r.origem).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const products = [...new Set(RECORDS.map((r) => r.produto).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  const ySel = document.getElementById("filter-year");
  const mSel = document.getElementById("filter-month");
  const oSel = document.getElementById("filter-origin");
  const pSel = document.getElementById("filter-product");

  ySel.innerHTML = `<option value="">Todos os anos</option>` +
    years.map((y) => `<option value="${y}">${y}</option>`).join("");
  mSel.innerHTML = `<option value="">Todos os meses</option>` +
    meses.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  oSel.innerHTML = `<option value="">Todas as origens</option>` +
    origins.map((o) => `<option value="${escapeAttr(o)}">${escapeText(o)}</option>`).join("");
  pSel.innerHTML = `<option value="">Todos os produtos</option>` +
    products.map((p) => `<option value="${escapeAttr(p)}">${escapeText(p)}</option>`).join("");

  [ySel, mSel, oSel, pSel].forEach((s) => (s.onchange = render));
  document.getElementById("filter-reset").onclick = () => {
    ySel.value = ""; mSel.value = ""; oSel.value = ""; pSel.value = "";
    STATE.page = 1; STATE.search = "";
    document.getElementById("table-search").value = "";
    render();
  };
}

function filtered() {
  const y = document.getElementById("filter-year").value;
  const mo = document.getElementById("filter-month").value;
  const o = document.getElementById("filter-origin").value;
  const p = document.getElementById("filter-product").value;
  const data = RECORDS.filter((r) =>
    (!y || String(r.ano) === y) &&
    (!mo || String(r.mes) === mo) &&
    (!o || r.origem === o) &&
    (!p || r.produto === p)
  );
  return data;
}

const FILTER_DEFS = [
  { id: "filter-year", label: "Ano" },
  { id: "filter-month", label: "Mês", name: (v) => meses[+v - 1] },
  { id: "filter-origin", label: "Origem" },
  { id: "filter-product", label: "Produto" },
];

function updateActiveFilters() {
  const box = document.getElementById("active-filters");
  if (!box) return;
  const chips = [];
  FILTER_DEFS.forEach((fd) => {
    const sel = document.getElementById(fd.id);
    if (sel && sel.value) {
      const display = fd.name ? fd.name(sel.value) : sel.value;
      chips.push(
        `<button class="chip" data-id="${fd.id}" type="button">` +
        `<span class="chip__k">${fd.label}:</span> <span class="chip__v">${escapeText(display)}</span>` +
        `<span class="chip__x" aria-hidden="true">×</span></button>`
      );
    }
  });
  box.innerHTML = chips.join("");
  box.style.display = chips.length ? "" : "none";
  box.querySelectorAll(".chip").forEach((btn) => {
    btn.onclick = () => {
      const s = document.getElementById(btn.dataset.id);
      if (s) { s.value = ""; STATE.page = 1; render(); }
    };
  });
}

/* ===================== Render ===================== */
function render() {
  const data = filtered();
  renderKpis(data);
  renderValue(data);
  renderCount(data);
  renderQty(data);
  renderFreteByProduct(data);
  renderCountByProduct(data);
  renderOrigin(data);
  renderTicket(data);
  renderProductSeries(data);
  renderBlastbags(data);
  renderTable(data);
  updateActiveFilters();
}

function renderKpis(data) {
  const freteVals = data.map((r) => r.vfrete).filter((v) => v != null);
  const totalVals = data.map((r) => r.vtotal).filter((v) => v != null);
  const freteTotal = sum(freteVals);
  const nfTotal = sum(totalVals);
  const ticket = freteVals.length ? freteTotal / freteVals.length : 0;

  // meses distintos no filtro (para média/mês)
  const months = new Set(data.map(monthKey));

  document.getElementById("kpi-count").textContent = fmtInt(data.length);
  document.getElementById("kpi-count-hint").textContent =
    data.length ? `${fmtInt(data.length)} NFs · ${months.size} ${months.size === 1 ? "mês" : "meses"} · média ${fmtNum(data.length / (months.size || 1), 1)}/mês` : "—";

  document.getElementById("kpi-frete").textContent = fmtBRLcompact(freteTotal);
  document.getElementById("kpi-frete-hint").textContent =
    freteVals.length ? `${fmtInt(freteVals.length)} NFs com frete · média ${fmtBRL(ticket)}` : "Sem frete preenchido";

  document.getElementById("kpi-total").textContent = fmtBRLcompact(nfTotal);
  document.getElementById("kpi-total-hint").textContent =
    totalVals.length ? `Soma de ${fmtInt(totalVals.length)} NFs` : "—";

  const ticketEl = document.getElementById("kpi-ticket");
  ticketEl.textContent = freteVals.length ? fmtBRLcompact(ticket) : "—";
  document.getElementById("kpi-ticket-hint").textContent =
    freteVals.length ? `Frete médio por nota` : "—";
}

/* Agrupa por mês mantendo todos os meses do intervalo (inclusive vazios). */
function monthlyGroups(data, valFn) {
  const groups = {};
  data.forEach((r) => {
    const k = monthKey(r);
    (groups[k] = groups[k] || []).push(valFn(r));
  });
  // completa lacunas entre min e max
  if (data.length) {
    const dates = data.map((r) => r.date).sort((a, b) => a - b);
    let cur = new Date(dates[0].getFullYear(), dates[0].getMonth(), 1);
    const end = new Date(dates[dates.length - 1].getFullYear(), dates[dates.length - 1].getMonth(), 1);
    while (cur <= end) {
      const k = cur.getFullYear() + "-" + String(cur.getMonth() + 1).padStart(2, "0");
      if (!groups[k]) groups[k] = [];
      cur.setMonth(cur.getMonth() + 1);
    }
  }
  return Object.keys(groups).sort().map((k) => ({ k, vals: groups[k] }));
}

function renderValue(data) {
  const months = monthlyGroups(data, (r) => r);
  const freteByMonth = months.map((m) => sum(m.vals.map((r) => r.vfrete || 0)));
  const totalByMonth = months.map((m) => sum(m.vals.map((r) => r.vtotal || 0)));
  buildChart("chart-value", "line", {
    type: "line",
    data: {
      labels: months.map((m) => monthLabel(m.k)),
      datasets: [
        { label: "Valor do Frete (R$)", data: freteByMonth, yAxisID: "y",
          borderColor: C.neutral, backgroundColor: "rgba(226,6,19,0.12)", borderWidth: 2.2, pointRadius: 2.5, tension: 0.3, fill: true },
        { label: "Valor Total NF (R$)", data: totalByMonth, yAxisID: "y1",
          borderColor: C.ink, backgroundColor: "rgba(56,66,75,0.06)", borderWidth: 1.8, borderDash: [5, 3], pointRadius: 1.5, tension: 0.3, fill: false },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 14, font: { size: 10 }, padding: 10 } },
        tooltip: tooltipCfg({ callbacks: { label: (it) => `${it.dataset.label}: ${fmtBRL(it.parsed.y)}` } }),
      },
      scales: {
        x: { ticks: { color: C.text, font: { size: 8 }, maxRotation: 45, autoSkip: true }, grid: { display: false }, border: { color: C.grid } },
        y: { position: "left", title: { display: true, text: "Valor do Frete (R$)", color: C.neutral, font: { size: 9, weight: "bold" } },
             ticks: { color: C.text, font: { size: 8 }, callback: (v) => fmtBRLcompact(v) }, grid: { color: C.grid }, border: { color: C.grid } },
        y1: { position: "right", title: { display: true, text: "Valor Total NF (R$)", color: C.ink, font: { size: 9, weight: "bold" } },
              ticks: { color: C.text, font: { size: 8 }, callback: (v) => fmtBRLcompact(v) }, grid: { drawOnChartArea: false }, border: { color: C.grid } },
      },
    },
  });
}

function renderCount(data) {
  const months = monthlyGroups(data, (r) => r);
  buildChart("chart-count", "bar", {
    type: "bar",
    data: {
      labels: months.map((m) => monthLabel(m.k)),
      datasets: [{ label: "Nº de NFs", data: months.map((m) => m.vals.length), backgroundColor: C.ink, borderRadius: 2 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: tooltipCfg({ callbacks: { label: (it) => `${fmtInt(it.parsed.y)} NFs` } }) },
      scales: { x: { ticks: { color: C.text, font: { size: 7 }, maxRotation: 45, autoSkip: true }, grid: { display: false }, border: { color: C.grid } },
                y: scaleY("Nº de NFs") },
    },
  });
}

function renderQty(data) {
  const months = monthlyGroups(data, (r) => r);
  buildChart("chart-qty", "bar", {
    type: "bar",
    data: {
      labels: months.map((m) => monthLabel(m.k)),
      datasets: [{ label: "Quantidade", data: months.map((m) => sum(m.vals.map((r) => r.qty || 0))), backgroundColor: C.blue, borderRadius: 2 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: tooltipCfg({ callbacks: { label: (it) => `${fmtNum(it.parsed.y, 0)} unidades (KG·PC·M)` } }) },
      scales: { x: { ticks: { color: C.text, font: { size: 7 }, maxRotation: 45, autoSkip: true }, grid: { display: false }, border: { color: C.grid } },
                y: scaleY("Qtde (unidades)", true) },
    },
  });
}

function topProducts(data, metricFn, limit) {
  const groups = {};
  data.forEach((r) => { (groups[r.produto] = groups[r.produto] || []).push(r); });
  return Object.entries(groups)
    .map(([p, arr]) => ({ p, val: metricFn(arr), n: arr.length }))
    .sort((a, b) => b.val - a.val)
    .slice(0, limit);
}

function productGroups(data, predicate = () => true) {
  const groups = {};
  data.filter(predicate).forEach((r) => {
    (groups[r.produto] = groups[r.produto] || []).push(r);
  });
  return Object.entries(groups)
    .map(([p, arr]) => ({ p, arr }))
    .sort((a, b) => a.p.localeCompare(b.p, "pt-BR"));
}

function renderFreteByProduct(data) {
  const entries = topProducts(data, (arr) => sum(arr.map((r) => r.vfrete || 0)), 12);
  buildChart("chart-frete-prod", "bar", {
    type: "bar",
    data: {
      labels: entries.map((e) => e.p),
      datasets: [{ label: "Frete (R$)", data: entries.map((e) => e.val), backgroundColor: C.neutral, borderRadius: 2 }],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: tooltipCfg({ callbacks: { label: (it) => `${fmtBRL(it.parsed.x)} · ${fmtInt(entries[it.dataIndex].n)} NFs` } }) },
      scales: { x: scaleY("Valor do frete (R$)", true), y: { ...scaleTicks(), grid: { display: false } } },
    },
  });
}

function renderCountByProduct(data) {
  const entries = topProducts(data, (arr) => arr.length, 12);
  buildChart("chart-count-prod", "bar", {
    type: "bar",
    data: {
      labels: entries.map((e) => e.p),
      datasets: [{ label: "Nº de NFs", data: entries.map((e) => e.n), backgroundColor: C.ink, borderRadius: 2 }],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: tooltipCfg({ callbacks: { label: (it) => `${fmtInt(it.parsed.x)} NFs · ${fmtBRL(entries[it.dataIndex].val || 0)} de frete` } }) },
      scales: { x: scaleY("Nº de NFs"), y: { ...scaleTicks(), grid: { display: false } } },
    },
  });
}

function renderOrigin(data) {
  const groups = {};
  data.forEach((r) => { (groups[r.origem] = groups[r.origem] || []).push(r); });
  const entries = Object.entries(groups).map(([o, arr]) => ({
    o, n: arr.length, frete: sum(arr.map((r) => r.vfrete || 0)),
  })).sort((a, b) => b.frete - a.frete);

  buildChart("chart-origin", "bar", {
    type: "bar",
    data: {
      labels: entries.map((e) => e.o),
      datasets: [
        { label: "Frete (R$)", data: entries.map((e) => e.frete), backgroundColor: C.neutral, borderRadius: 2, yAxisID: "y" },
        { label: "Nº de NFs", data: entries.map((e) => e.n), backgroundColor: C.ink, borderRadius: 2, yAxisID: "y1" },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 12, font: { size: 10 }, padding: 10 } },
        tooltip: tooltipCfg({ callbacks: { label: (it) => it.datasetIndex === 0 ? `Frete: ${fmtBRL(it.parsed.y)}` : `NFs: ${fmtInt(it.parsed.y)}` } }),
      },
      scales: {
        x: scaleTicks(),
        y: { position: "left", title: { display: true, text: "Frete (R$)", color: C.neutral, font: { size: 9, weight: "bold" } }, ticks: { color: C.text, font: { size: 8 }, callback: (v) => fmtBRLcompact(v) }, grid: { color: C.grid }, border: { color: C.grid } },
        y1: { position: "right", title: { display: true, text: "Nº de NFs", color: C.ink, font: { size: 9, weight: "bold" } }, ticks: { color: C.text, font: { size: 8 } }, grid: { drawOnChartArea: false }, border: { color: C.grid } },
      },
    },
  });
}

function renderTicket(data) {
  const months = monthlyGroups(data, (r) => r);
  const ticketByMonth = months.map((m) => {
    const fr = m.vals.map((r) => r.vfrete).filter((v) => v != null);
    return fr.length ? sum(fr) / fr.length : null;
  });
  buildChart("chart-ticket", "line", {
    type: "line",
    data: {
      labels: months.map((m) => monthLabel(m.k)),
      datasets: [{ label: "Frete médio/NF (R$)", data: ticketByMonth, borderColor: C.neutral, backgroundColor: "rgba(226,6,19,0.10)", borderWidth: 2, pointRadius: 2.5, tension: 0.3, fill: true, spanGaps: true }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: tooltipCfg({ callbacks: { label: (it) => it.parsed.y == null ? "Sem frete no mês" : `${fmtBRL(it.parsed.y)} por NF` } }) },
      scales: { x: { ticks: { color: C.text, font: { size: 7 }, maxRotation: 45, autoSkip: true }, grid: { display: false }, border: { color: C.grid } },
                y: scaleY("Frete médio/NF (R$)", true) },
    },
  });
}

function renderProductSeries(data) {
  const container = document.getElementById("extra-charts");
  if (!container) return;
  container.innerHTML = "";
  // top 6 produtos por frete -> um card de evolução mensal cada
  const tops = topProducts(data, (arr) => sum(arr.map((r) => r.vfrete || 0)), 6);
  tops.forEach((entry, i) => {
    const color = PRODUCT_COLORS[i % PRODUCT_COLORS.length];
    const subset = data.filter((r) => r.produto === entry.p);
    const months = monthlyGroups(subset, (r) => r);
    const card = document.createElement("div");
    card.className = "extra-card";
    const id = "extra-" + i;
    card.innerHTML =
      `<p class="extra-card__title"><span class="extra-card__swatch" style="background:${color}"></span>${escapeText(entry.p)}</p>` +
      `<div class="extra-card__canvas"><canvas id="${id}"></canvas></div>`;
    container.appendChild(card);
    if (!months.length) return;
    buildChart(id, "line", {
      type: "line",
      data: {
        labels: months.map((m) => monthLabel(m.k)),
        datasets: [{ data: months.map((m) => sum(m.vals.map((r) => r.vfrete || 0))), borderColor: color, backgroundColor: color + "22", borderWidth: 1.8, pointRadius: 1.5, tension: 0.3, fill: true }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: tooltipCfg({ callbacks: { label: (it) => `${fmtBRL(it.parsed.y)} de frete` } }) },
        scales: {
          x: { ticks: { color: C.text, font: { size: 7 }, maxTicksLimit: 6, autoSkip: true }, grid: { display: false }, border: { color: C.grid } },
          y: { ticks: { color: C.text, font: { size: 7 }, callback: (v) => fmtBRLcompact(v) }, grid: { color: C.grid }, border: { color: C.grid }, title: { display: true, text: "Frete (R$)", color: C.text, font: { size: 8 } } },
        },
      },
    });
  });
}

function renderBlastbags(data) {
  const section = document.getElementById("blastbags-section");
  if (!section) return;

  const subset = data.filter((r) => norm(r.produto).includes(BLASTBAG_TOKEN));
  if (!subset.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  const meta = document.getElementById("blastbags-meta");
  const dates = subset.map((r) => r.date).sort((a, b) => a - b);
  const products = [...new Set(subset.map((r) => r.produto))];
  if (meta && dates.length) {
    const totalQty = sum(subset.map((r) => r.qty || 0));
    const totalProducts = sum(subset.map((r) => r.vprod || 0));
    meta.textContent =
      `${fmtInt(subset.length)} NFs · ${fmtInt(products.length)} produtos · ` +
      `${fmtDate(dates[0])} a ${fmtDate(dates[dates.length - 1])} · ` +
      `${fmtNum(totalQty, 0)} un. · ${fmtBRLcompact(totalProducts)} em produtos`;
  }

  const entries = productGroups(subset).map((entry) => {
    const qty = sum(entry.arr.map((r) => r.qty || 0));
    const vprod = sum(entry.arr.map((r) => r.vprod || 0));
    return {
      ...entry,
      qty,
      vprod,
      nfs: entry.arr.length,
      vunit: weightedMean(entry.arr, "vunit", "qty"),
      firstDate: entry.arr.map((r) => r.date).sort((a, b) => a - b)[0],
      lastDate: entry.arr.map((r) => r.date).sort((a, b) => b - a)[0],
    };
  });

  renderBlastbagKpis(subset, entries);

  renderBlastbagBar("chart-blastbag-qty", entries, {
    label: "Qtde",
    axisTitle: "Qtde total",
    color: C.blue,
    value: (entry) => entry.qty,
    rankBy: "qty",
    valueLabel: (value) => fmtNum(value, 0),
    tooltip: (value, entry) => [
      `${fmtNum(value, 0)} unidades`,
      `${fmtInt(entry.nfs)} NF${entry.nfs === 1 ? "" : "s"} · ${fmtBRLcompact(entry.vprod)} em produtos`,
      `Período: ${fmtDate(entry.firstDate)} a ${fmtDate(entry.lastDate)}`,
    ],
    compactAxis: false,
  });
  renderBlastbagBar("chart-blastbag-vunit", entries, {
    label: "Valor unitário ponderado (R$)",
    axisTitle: "R$ por unidade",
    color: C.green,
    value: (entry) => entry.vunit,
    rankBy: "vunit",
    valueLabel: (value) => fmtBRLcompact(value),
    tooltip: (value, entry) => [
      `${fmtBRL(value)} por unidade`,
      `Ponderado por ${fmtNum(entry.qty, 0)} unidades`,
      `${fmtInt(entry.nfs)} NF${entry.nfs === 1 ? "" : "s"} no filtro`,
    ],
    compactAxis: true,
  });
  renderBlastbagBar("chart-blastbag-vprod", entries, {
    label: "Valor total dos produtos (R$)",
    axisTitle: "Valor total dos produtos (R$)",
    color: C.neutral,
    value: (entry) => entry.vprod,
    rankBy: "vprod",
    valueLabel: (value, entry, total) => `${fmtBRLcompact(value)} · ${fmtNum(total ? value / total * 100 : 0, 1)}%`,
    tooltip: (value, entry, total) => [
      `${fmtBRL(value)} em produtos`,
      `${fmtNum(total ? value / total * 100 : 0, 1)}% do valor Blastbag`,
      `${fmtNum(entry.qty, 0)} unidades · ${fmtInt(entry.nfs)} NF${entry.nfs === 1 ? "" : "s"}`,
    ],
    compactAxis: true,
  });
}

function renderBlastbagKpis(subset, entries) {
  const box = document.getElementById("blastbag-kpis");
  if (!box) return;
  const totalQty = sum(entries.map((e) => e.qty));
  const totalProducts = sum(entries.map((e) => e.vprod));
  const leader = [...entries].sort((a, b) => b.vprod - a.vprod)[0];
  const leaderShare = leader && totalProducts ? leader.vprod / totalProducts * 100 : 0;
  const cards = [
    { label: "NFs Blastbag", value: fmtInt(subset.length), hint: `${fmtInt(entries.length)} produtos no filtro` },
    { label: "Quantidade", value: fmtNum(totalQty, 0), hint: "Soma de unidades Blastbag" },
    { label: "Valor produtos", value: fmtBRLcompact(totalProducts), hint: `Ticket médio ${fmtBRLcompact(subset.length ? totalProducts / subset.length : 0)}/NF` },
    { label: "Maior participação", value: leader ? `${fmtNum(leaderShare, 1)}%` : "—", hint: leader ? leader.p : "Sem produto" },
  ];
  box.innerHTML = cards.map((card) =>
    `<div class="blastbag-kpi">` +
    `<p class="blastbag-kpi__label">${escapeText(card.label)}</p>` +
    `<p class="blastbag-kpi__value">${escapeText(card.value)}</p>` +
    `<p class="blastbag-kpi__hint">${escapeText(card.hint)}</p>` +
    `</div>`
  ).join("");
}

function renderBlastbagBar(canvasId, entries, cfg) {
  const ranked = [...entries]
    .map((entry) => ({ ...entry, chartValue: cfg.value(entry) || 0 }))
    .sort((a, b) => b.chartValue - a.chartValue);
  const total = sum(ranked.map((e) => e.chartValue));
  buildChart(canvasId, "bar", {
    type: "bar",
    data: {
      labels: ranked.map((e) => e.p),
      datasets: [{
        label: cfg.label,
        data: ranked.map((e) => e.chartValue),
        backgroundColor: (ctx) => barGradient(ctx, cfg.color),
        borderColor: cfg.color,
        borderWidth: 1,
        borderRadius: 3,
        borderSkipped: false,
        barPercentage: 0.78,
        categoryPercentage: 0.72,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { right: 24 } },
      plugins: {
        legend: { display: false },
        blastbagValueLabels: {
          formatter: (value, dataIndex) => cfg.valueLabel(value, ranked[dataIndex], total),
          color: cfg.color,
        },
        tooltip: tooltipCfg({
          callbacks: {
            label: (it) => cfg.tooltip(it.parsed.x, ranked[it.dataIndex], total),
          },
        }),
      },
      scales: {
        x: {
          ...scaleY(cfg.axisTitle, cfg.compactAxis),
          suggestedMax: Math.max(...ranked.map((e) => e.chartValue), 0) * 1.15,
        },
        y: {
          ...scaleTicks(),
          grid: { display: false },
          ticks: {
            color: C.text,
            font: { size: 8 },
            autoSkip: false,
            callback: (_value, index) => {
              const label = ranked[index] ? ranked[index].p : "";
              return label.length > 24 ? label.slice(0, 24) + "…" : label;
            },
          },
        },
      },
    },
  });
}

function barGradient(ctx, color) {
  const chart = ctx.chart;
  const area = chart.chartArea;
  if (!area) return color;
  const gradient = chart.ctx.createLinearGradient(area.left, 0, area.right, 0);
  gradient.addColorStop(0, color + "cc");
  gradient.addColorStop(1, color);
  return gradient;
}

/* ===================== Tabela ===================== */
function renderTable(data) {
  // aplica busca textual
  const q = STATE.search.trim().toLowerCase();
  let rows = data;
  if (q) {
    rows = data.filter((r) =>
      [r.nf, r.produto, r.origem, r.destino, r.emitente, r.destinatario, r.serie]
        .some((v) => norm(v).includes(norm(q)))
    );
  }

  const dir = STATE.sortDir === "asc" ? 1 : -1;
  const key = STATE.sortKey;
  rows = [...rows].sort((a, b) => {
    let va, vb;
    switch (key) {
      case "date": va = a.date.getTime(); vb = b.date.getTime(); break;
      case "nf": va = +a.nf || 0; vb = +b.nf || 0; break;
      case "product": va = a.produto; vb = b.produto; break;
      case "route": va = a.origem + a.destino; vb = b.origem + b.destino; break;
      case "qty": va = a.qty || 0; vb = b.qty || 0; break;
      case "frete": va = a.vfrete || 0; vb = b.vfrete || 0; break;
      case "total": va = a.vtotal || 0; vb = b.vtotal || 0; break;
      default: va = 0; vb = 0;
    }
    if (typeof va === "string") return va.localeCompare(vb, "pt-BR") * dir;
    return (va - vb) * dir;
  });

  // marca indicador de ordenação no cabeçalho
  document.querySelectorAll(".nf-table thead th").forEach((th) => {
    const ind = th.querySelector(".sort-ind");
    if (!ind) return;
    if (th.dataset.key === key) {
      ind.textContent = STATE.sortDir === "asc" ? "▲" : "▼";
      th.classList.add("is-active");
    } else {
      ind.textContent = "";
      th.classList.remove("is-active");
    }
  });

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (STATE.page > totalPages) STATE.page = totalPages;
  const start = (STATE.page - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  const tbody = document.getElementById("nf-tbody");
  tbody.innerHTML = pageRows.map((r) =>
    `<tr>` +
    `<td>${fmtDate(r.date)}</td>` +
    `<td class="num-mono">${escapeText(r.nf)}<span style="color:#9aa1a7">/${escapeText(r.serie)}</span></td>` +
    `<td><div class="prod-cell" title="${escapeAttr(r.produto)}">${escapeText(r.produto)}</div></td>` +
    `<td class="route-cell"><strong>${escapeText(r.origem)}</strong> → ${escapeText(r.destino)}</td>` +
    `<td class="is-num">${r.qty != null ? fmtNum(r.qty, 0) : "—"} <span style="color:#9aa1a7">${escapeText(r.unidade)}</span></td>` +
    `<td class="is-money">${r.vfrete != null ? fmtBRL(r.vfrete) : "—"}</td>` +
    `<td class="is-money">${r.vtotal != null ? fmtBRL(r.vtotal) : "—"}</td>` +
    `</tr>`
  ).join("") || `<tr><td colspan="7" style="text-align:center;color:#9aa1a7;padding:24px">Nenhuma nota no filtro.</td></tr>`;

  document.getElementById("table-info").textContent =
    rows.length ? `Mostrando ${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} de ${fmtInt(rows.length)} notas` : "Nenhuma nota";

  renderPager(totalPages);
}

function renderPager(totalPages) {
  const pager = document.getElementById("pager");
  const p = STATE.page;
  const btn = (label, page, opts = {}) =>
    `<button type="button" class="${opts.active ? "is-active" : ""}" ${opts.disabled ? "disabled" : `data-page="${page}"`}>${label}</button>`;

  let html = btn("‹", p - 1, { disabled: p <= 1 });
  // janela de páginas
  const win = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= p - 1 && i <= p + 1)) win.push(i);
    else if (win[win.length - 1] !== "…") win.push("…");
  }
  win.forEach((i) => {
    if (i === "…") html += `<span class="pager__sep">…</span>`;
    else html += btn(i, i, { active: i === p });
  });
  html += btn("›", p + 1, { disabled: p >= totalPages });
  pager.innerHTML = html;
  pager.querySelectorAll("button[data-page]").forEach((b) => {
    b.onclick = () => { STATE.page = +b.dataset.page; renderTable(filtered()); };
  });
}

/* ===================== Helpers de chart ===================== */
function buildChart(canvasId, _kind, config) {
  if (CHARTS[canvasId]) CHARTS[canvasId].destroy();
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (!config.type) {
    const ds = config.data && config.data.datasets && config.data.datasets[0];
    config.type = (ds && ds.type) || _kind || "bar";
  }
  CHARTS[canvasId] = new Chart(ctx, config);
}

function tooltipCfg(extra) { return Object.assign({}, tooltipBase(), extra || {}); }
function tooltipBase() {
  return {
    enabled: true, backgroundColor: "rgba(56,66,75,0.95)", titleColor: "#ffffff", bodyColor: "#e8e8e8",
    borderColor: "#38424B", borderWidth: 0, padding: 12, cornerRadius: 4, caretSize: 8, caretPadding: 8,
    displayColors: true, boxWidth: 10, boxHeight: 10, boxPadding: 4,
    titleFont: { weight: "700", size: 12 }, bodyFont: { size: 11 }, bodySpacing: 5,
  };
}
function scaleTicks() { return { ticks: { color: C.text, font: { size: 7 }, maxRotation: 45, autoSkip: true }, border: { color: C.grid } }; }
function scaleY(title, compact) {
  return {
    title: { display: !!title, text: title, color: C.text, font: { size: 8, weight: "bold" } },
    ticks: { color: C.text, font: { size: 7 }, callback: compact ? (v) => fmtBRLcompact(v) : undefined },
    grid: { color: C.grid }, border: { color: C.grid },
  };
}

const blastbagValueLabelsPlugin = {
  id: "blastbagValueLabels",
  afterDatasetsDraw(chart, _args, opts) {
    const meta = chart.getDatasetMeta(0);
    const dataset = chart.data.datasets[0];
    if (!meta || meta.hidden || !dataset) return;
    const { ctx } = chart;
    ctx.save();
    ctx.font = "700 9px " + Chart.defaults.font.family;
    ctx.textBaseline = "middle";
    meta.data.forEach((bar, i) => {
      const value = dataset.data[i];
      if (value == null) return;
      const label = opts.formatter ? opts.formatter(value, i) : fmtNum(value, 0);
      const barWidth = bar.width || 0;
      const textWidth = ctx.measureText(label).width;
      if (barWidth < 44) return;
      if (barWidth >= textWidth + 18) {
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "right";
        ctx.fillText(label, bar.x - 8, bar.y);
        return;
      }
      if (barWidth >= textWidth + 8) {
        ctx.fillStyle = opts.color || C.ink;
        ctx.textAlign = "right";
        ctx.fillText(label, bar.x - 6, bar.y);
      }
    });
    ctx.restore();
  },
};

function setStatus(kind, text) {
  const el = document.getElementById("status");
  if (!el) return;
  el.classList.remove("is-loading", "is-ok", "is-error");
  if (kind === "loading") el.classList.add("is-loading");
  if (kind === "ok") el.classList.add("is-ok");
  if (kind === "error") el.classList.add("is-error");
  const t = document.getElementById("status-text");
  if (t) t.textContent = text;
}
function nowBR() { return new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }); }

document.addEventListener("DOMContentLoaded", () => {
  if (!window.Chart) {
    setStatus("error", "Biblioteca de gráficos (Chart.js) não carregou. Verifique sua conexão.");
    return;
  }
  Chart.defaults.font.family = "'Segoe UI', -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif";
  Chart.defaults.font.size = 8;
  Chart.defaults.color = "#6c747b";
  Chart.defaults.borderColor = "rgba(56,66,75,0.08)";
  Object.assign(Chart.defaults.plugins.tooltip, tooltipBase());
  Chart.register(blastbagValueLabelsPlugin);

  // ordenação ao clicar no cabeçalho
  document.querySelectorAll(".nf-table thead th").forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.key;
      if (STATE.sortKey === key) STATE.sortDir = STATE.sortDir === "asc" ? "desc" : "asc";
      else { STATE.sortKey = key; STATE.sortDir = (key === "product" || key === "route") ? "asc" : "desc"; }
      STATE.page = 1;
      renderTable(filtered());
    };
  });
  // busca
  const search = document.getElementById("table-search");
  let t;
  search.oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => { STATE.search = search.value; STATE.page = 1; renderTable(filtered()); }, 180);
  };

  loadSheet().catch((e) => console.error(e));
  setInterval(() => loadSheet().catch(() => {}), 10 * 60 * 1000);
});
