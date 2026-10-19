/* =====================================================================
   Notas Fiscais - US Vale Verde
   Lê em tempo real a planilha Google Sheets (gviz) e renderiza os gráficos.
   Atualiza a cada acesso — sem servidor, sem build.

   Gráficos: passe o mouse para detalhes; clique em um mês, produto ou
   origem para filtrar o painel inteiro (mesmo estado dos filtros laterais).
   ===================================================================== */

const SHEET_ID = "14Z-nzXSWC4iaqJcLWmaPOgYjGU2pOJeT";
const GVIZ_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&headers=1`;
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

/* Paleta do hub (Enaex) */
const C = {
  ink: "#38424B",
  neutral: "#E20613",
  grid: "#ECEDEF",
  axis: "#D5D8DC",
  text: "#8A8F96",
  green: "#107c10",
};
const PRODUCT_COLORS = [
  "#E20613", "#38424B", "#1f6feb", "#6f42c1", "#107c10", "#c47b00",
  "#0d8a8a", "#b9387a", "#5a6c00", "#7a4b11", "#2c5f8d", "#8a2c2c",
];

/* Limites de sanidade: valores fora disso são tratados como erro de digitação */
const MAX_MONEY = 1e9;
const MAX_QTY = 1e8;

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
const fmtPct = (n, signed = false) => {
  if (n == null || !isFinite(n)) return "—";
  const s = fmtNum(Math.abs(n), 1) + "%";
  if (!signed) return (n < 0 ? "−" : "") + s;
  return (n > 0 ? "+" : n < 0 ? "−" : "") + s;
};
/** Versão compacta para KPIs e tooltips: R$ 3,05 mi / R$ 76,10 mil */
const fmtBRLcompact = (n) => {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return "R$ " + dec2.format(n / 1e6) + " mi";
  if (a >= 1e3) return "R$ " + dec2.format(n / 1e3) + " mil";
  return "R$ " + dec2.format(n);
};
/** Versão compacta para quantidades (sem R$) */
const fmtQtyCompact = (n) => {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return dec2.format(n / 1e6) + " mi";
  if (a >= 1e3) return dec2.format(n / 1e3) + " mil";
  return dec2.format(n);
};
/** Ticks dos eixos: poucos dígitos (R$ 2 mi, R$ 500 mil) */
const axisNum = (x) => { const r = Math.round(x * 10) / 10; return fmtNum(r, r % 1 ? 1 : 0); };
const axisMoney = (v) => {
  const a = Math.abs(v);
  if (a >= 1e6) return "R$ " + axisNum(v / 1e6) + " mi";
  if (a >= 1e3) return "R$ " + axisNum(v / 1e3) + " mil";
  return "R$ " + axisNum(v);
};
const axisQty = (v) => {
  const a = Math.abs(v);
  if (a >= 1e6) return axisNum(v / 1e6) + " mi";
  if (a >= 1e3) return axisNum(v / 1e3) + " mil";
  return axisNum(v);
};

const meses = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const mesesLongos = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
function fmtDate(d) { return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear(); }
function monthKey(r) { return r.ano + "-" + String(r.mes).padStart(2, "0"); }
function monthLabel(k) { const [y, m] = k.split("-"); return meses[+m - 1] + "/" + y.slice(2); }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((v) => (v - m) * (v - m))));
}
function sum(arr) { return arr.reduce((a, b) => a + (b || 0), 0); }
const pct = (part, whole) => (whole ? (part / whole) * 100 : 0);
const arrowFor = (d, th = 2) => (d == null || !isFinite(d) || Math.abs(d) < th ? "►" : d > 0 ? "▲" : "▼");
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

/**
 * Lê número pt-BR de forma tolerante:
 *  - "R$ 8.449,20" -> 8449.2   (vírgula é sempre decimal; pontos são milhar)
 *  - "2988,000"    -> 2988     (decimal com casas extras)
 *  - "3.880.00"    -> 3880     (ponto final com 1-2 dígitos = decimal)
 *  - "1.234"       -> 1234     (ponto com 3 dígitos = milhar)
 *  - "30.000.,100" -> 30000.1
 *  Texto sem dígitos (ou vazio) retorna null.
 */
function br(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const raw = String(v).trim();
  if (!/\d/.test(raw)) return null;
  const neg = raw.includes("-");
  const s = raw.replace(/[^\d,.]/g, "");
  let intPart = s, fracPart = "";
  const lastComma = s.lastIndexOf(",");
  if (lastComma >= 0) {
    intPart = s.slice(0, lastComma);
    fracPart = s.slice(lastComma + 1);
  } else {
    const lastDot = s.lastIndexOf(".");
    const after = lastDot >= 0 ? s.length - lastDot - 1 : -1;
    if (after === 1 || after === 2) {
      intPart = s.slice(0, lastDot);
      fracPart = s.slice(lastDot + 1);
    }
  }
  const intDigits = intPart.replace(/\D/g, "");
  const fracDigits = fracPart.replace(/\D/g, "");
  if (!intDigits && !fracDigits) return null;
  let n = parseFloat((intDigits || "0") + (fracDigits ? "." + fracDigits : ""));
  if (!isFinite(n)) return null;
  if (neg) n = -n;
  return n;
}

/** Valor plausível ou null (negativos e absurdos são descartados). */
function clean(n, max) {
  return n != null && isFinite(n) && n >= 0 && n <= max ? n : null;
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

    const vfrete = clean(num(f.vfrete), MAX_MONEY);
    const vtotal = clean(num(f.vtotal), MAX_MONEY);
    const qty = clean(num(f.qtde), MAX_QTY);
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
      vunit: clean(num(f.vunit), MAX_MONEY),
      vprod: clean(num(f.vprod), MAX_MONEY),
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

  const ySel = el("filter-year");
  const mSel = el("filter-month");
  const oSel = el("filter-origin");
  const pSel = el("filter-product");
  // preserva a seleção atual quando a planilha é recarregada
  const keep = [ySel, mSel, oSel, pSel].map((s) => s.value);

  ySel.innerHTML = `<option value="">Todos os anos</option>` +
    years.map((y) => `<option value="${y}">${y}</option>`).join("");
  mSel.innerHTML = `<option value="">Todos os meses</option>` +
    meses.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  oSel.innerHTML = `<option value="">Todas as origens</option>` +
    origins.map((o) => `<option value="${escapeAttr(o)}">${escapeText(o)}</option>`).join("");
  pSel.innerHTML = `<option value="">Todos os produtos</option>` +
    products.map((p) => `<option value="${escapeAttr(p)}">${escapeText(p)}</option>`).join("");
  [ySel, mSel, oSel, pSel].forEach((s, i) => {
    if (Array.from(s.options).some((o) => o.value === keep[i])) s.value = keep[i];
  });

  [ySel, mSel, oSel, pSel].forEach((s) => (s.onchange = render));
  el("filter-reset").onclick = () => {
    ySel.value = ""; mSel.value = ""; oSel.value = ""; pSel.value = "";
    STATE.page = 1; STATE.search = "";
    el("table-search").value = "";
    render();
  };
}

const el = (id) => document.getElementById(id);

function filtered() {
  const y = el("filter-year").value;
  const mo = el("filter-month").value;
  const o = el("filter-origin").value;
  const p = el("filter-product").value;
  return RECORDS.filter((r) =>
    (!y || String(r.ano) === y) &&
    (!mo || String(r.mes) === mo) &&
    (!o || r.origem === o) &&
    (!p || r.produto === p)
  );
}

/* Clique nos gráficos: alterna o filtro (clicar de novo limpa) e sincroniza com a barra lateral */
function filtersChanged() {
  STATE.page = 1;
  render();
}
function toggleSelect(id, value) {
  const s = el(id);
  if (!s) return;
  s.value = s.value === String(value) ? "" : String(value);
  filtersChanged();
}
function toggleMonth(key) {
  const [y, m] = key.split("-");
  const ySel = el("filter-year"), mSel = el("filter-month");
  const on = ySel.value === String(+y) && mSel.value === String(+m);
  ySel.value = on ? "" : String(+y);
  mSel.value = on ? "" : String(+m);
  filtersChanged();
}

const FILTER_DEFS = [
  { id: "filter-year", label: "Ano" },
  { id: "filter-month", label: "Mês", name: (v) => meses[+v - 1] },
  { id: "filter-origin", label: "Origem" },
  { id: "filter-product", label: "Produto" },
];

function updateActiveFilters() {
  const box = el("active-filters");
  if (!box) return;
  const chips = [];
  FILTER_DEFS.forEach((fd) => {
    const sel = el(fd.id);
    if (sel && sel.value) {
      const display = fd.name ? fd.name(sel.value) : sel.value;
      chips.push(
        `<button class="chip" data-id="${fd.id}" type="button" aria-label="Remover filtro ${fd.label}: ${escapeAttr(display)}">` +
        `<span class="chip__k">${fd.label}:</span> <span class="chip__v">${escapeText(display)}</span>` +
        `<span class="chip__x" aria-hidden="true">×</span></button>`
      );
    }
  });
  box.innerHTML = chips.join("");
  box.style.display = chips.length ? "" : "none";
  box.querySelectorAll(".chip").forEach((btn) => {
    btn.onclick = () => {
      const s = el(btn.dataset.id);
      if (s) { s.value = ""; filtersChanged(); }
    };
  });
}

/* ===================== Render ===================== */
function render() {
  const data = filtered();
  renderKpis(data);
  renderFreteMonthly(data);
  renderTotalMonthly(data);
  renderProductsMonthly(data);
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

  el("kpi-count").textContent = fmtInt(data.length);

  el("kpi-frete").textContent = fmtBRLcompact(freteTotal);

  el("kpi-total").textContent = fmtBRLcompact(nfTotal);

  el("kpi-products").textContent = fmtBRLcompact(sum(data.map((r) => r.vprod || 0)));
  el("kpi-ticket").textContent = freteVals.length ? fmtBRLcompact(ticket) : "—";
}

/* Agrupa por mês mantendo todos os meses do intervalo (inclusive vazios). */
function monthlyGroups(data, valFn) {
  const groups = {};
  data.forEach((r) => {
    const k = monthKey(r);
    (groups[k] = groups[k] || []).push(valFn(r));
  });
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

function monthSeries(data) {
  const months = monthlyGroups(data, (r) => r);
  return {
    keys: months.map((m) => m.k),
    labels: months.map((m) => monthLabel(m.k)),
    groups: months.map((m) => m.vals),
  };
}

/* Linhas de apoio para tooltips de séries mensais */
function shareLine(values, i) {
  const total = sum(values.map((v) => v || 0));
  if (!total) return null;
  return `${fmtPct(pct(values[i] || 0, total))} do total do filtro`;
}
function changeLines(values, i, fmt) {
  const out = [];
  const v = values[i];
  if (v == null || !isFinite(v)) return out;
  const prev = i > 0 ? values[i - 1] : null;
  if (prev != null && prev !== 0) {
    const d = ((v - prev) / Math.abs(prev)) * 100;
    out.push(`${arrowFor(d)} ${fmtPct(d, true)} vs mês anterior`);
  }
  const avg = mean(values.filter((x) => x != null && isFinite(x)));
  if (avg) {
    const d = ((v - avg) / Math.abs(avg)) * 100;
    out.push(`${fmtPct(d, true)} vs média mensal (${fmt(avg)})`);
  }
  return out;
}

function shortName(s, max) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/* ===================== Gráficos ===================== */
function renderFreteMonthly(data) {
  const s = monthSeries(data);
  const freteM = s.groups.map((g) => sum(g.map((r) => r.vfrete || 0)));
  const avg = mean(freteM);
  const sd = stdev(freteM);
  const isHigh = (i) => s.keys.length >= 4 && sd > 0 && freteM[i] > avg + 2 * sd;
  buildChart("chart-value", {
    type: "bar",
    data: {
      labels: s.labels,
      datasets: [
        { label: "Frete no mês", data: freteM, backgroundColor: C.neutral, borderRadius: 0, barPercentage: 0.72, categoryPercentage: 0.82 },
        { label: "Média mensal", type: "line", data: s.labels.map(() => avg), borderColor: C.ink, borderWidth: 1.2, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 0, fill: false, order: 0 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: legendTop(),
        tooltip: tip(
          (it) => it.datasetIndex === 0 ? `Frete: ${fmtBRL(it.parsed.y)}` : `Média mensal: ${fmtBRL(it.parsed.y)}`,
          (i) => [
            shareLine(freteM, i),
            ...changeLines(freteM, i, fmtBRLcompact),
            isHigh(i) ? "Acima do padrão (média + 2 desvios)" : null,
          ]
        ),
      },
      scales: { x: xCat(), y: yValue(axisMoney) },
    },
  }, { pick: (i) => toggleMonth(s.keys[i]), dim: true });
}

function renderTotalMonthly(data) {
  const s = monthSeries(data);
  const totalM = s.groups.map((g) => sum(g.map((r) => r.vtotal || 0)));
  buildChart("chart-total", {
    type: "bar",
    data: {
      labels: s.labels,
      datasets: [{ label: "Valor total das NFs", data: totalM, backgroundColor: C.ink, borderRadius: 0, barPercentage: 0.72, categoryPercentage: 0.82 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: tip(
          (it) => `Valor total das NFs: ${fmtBRL(it.parsed.y)}`,
          (i) => [shareLine(totalM, i), ...changeLines(totalM, i, fmtBRLcompact)]
        ),
      },
      scales: { x: xCat(), y: yValue(axisMoney) },
    },
  }, { pick: (i) => toggleMonth(s.keys[i]), dim: true });
}

function renderProductsMonthly(data) {
  const s = monthSeries(data);
  const prodM = s.groups.map((g) => sum(g.map((r) => r.vprod || 0)));
  const avg = mean(prodM);
  buildChart("chart-products", {
    type: "bar",
    data: {
      labels: s.labels,
      datasets: [
        { label: "Valor total dos produtos", data: prodM, backgroundColor: C.ink, borderRadius: 0, barPercentage: 0.72, categoryPercentage: 0.82 },
        { label: "Média mensal", type: "line", data: s.labels.map(() => avg), borderColor: C.neutral, borderWidth: 1.2, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 0, fill: false, order: 0 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: legendTop(),
        tooltip: tip(
          (it) => it.datasetIndex === 0 ? `Valor total dos produtos: ${fmtBRL(it.parsed.y)}` : `Média mensal: ${fmtBRL(it.parsed.y)}`,
          (i) => [shareLine(prodM, i), ...changeLines(prodM, i, fmtBRLcompact)]
        ),
      },
      scales: { x: xCat(), y: yValue(axisMoney) },
    },
  }, { pick: (i) => toggleMonth(s.keys[i]), dim: true });
}

function renderCount(data) {
  const s = monthSeries(data);
  const counts = s.groups.map((g) => g.length);
  buildChart("chart-count", {
    type: "bar",
    data: {
      labels: s.labels,
      datasets: [{ label: "Nº de NFs", data: counts, backgroundColor: C.ink, borderRadius: 0, barPercentage: 0.72, categoryPercentage: 0.82 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: tip(
          (it) => `${fmtInt(it.parsed.y)} NFs`,
          (i) => [shareLine(counts, i), ...changeLines(counts, i, fmtInt)]
        ),
      },
      scales: { x: xCat(), y: yValue(fmtInt) },
    },
  }, { pick: (i) => toggleMonth(s.keys[i]), dim: true });
}

function renderQty(data) {
  const s = monthSeries(data);
  const qty = s.groups.map((g) => sum(g.map((r) => r.qty || 0)));
  const unitsM = s.groups.map((g) => {
    const m = {};
    g.forEach((r) => { if (r.qty) m[r.unidade] = (m[r.unidade] || 0) + r.qty; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  });
  buildChart("chart-qty", {
    type: "bar",
    data: {
      labels: s.labels,
      datasets: [{ label: "Quantidade", data: qty, backgroundColor: "#8A8F96", borderRadius: 0, barPercentage: 0.72, categoryPercentage: 0.82 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: tip(
          (it) => `${fmtNum(it.parsed.y, 0)} unidades somadas`,
          (i) => [
            ...unitsM[i].map(([u, v]) => `${u}: ${fmtNum(v, 0)}`),
            ...changeLines(qty, i, fmtQtyCompact),
          ]
        ),
      },
      scales: { x: xCat(), y: yValue(axisQty) },
    },
  }, { pick: (i) => toggleMonth(s.keys[i]), dim: true });
}

function topProducts(data, metricFn, limit) {
  const groups = {};
  data.forEach((r) => { (groups[r.produto] = groups[r.produto] || []).push(r); });
  return Object.entries(groups)
    .map(([p, arr]) => ({ p, val: metricFn(arr), n: arr.length }))
    .sort((a, b) => b.val - a.val)
    .slice(0, limit);
}

function renderFreteByProduct(data) {
  const entries = topProducts(data, (arr) => sum(arr.map((r) => r.vfrete || 0)), 10);
  const totalFrete = sum(data.map((r) => r.vfrete || 0));
  buildChart("chart-frete-prod", {
    type: "bar",
    data: {
      labels: entries.map((e) => e.p),
      datasets: [{ label: "Frete (R$)", data: entries.map((e) => e.val), backgroundColor: C.neutral, borderRadius: 0, barPercentage: 0.7 }],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      interaction: { mode: "nearest", axis: "y", intersect: false },
      layout: { padding: { right: 78 } },
      plugins: {
        legend: { display: false },
        valueLabels: { formatter: (v) => fmtBRLcompact(v) },
        tooltip: tip(
          (it) => `Frete: ${fmtBRL(it.parsed.x)}`,
          (i) => [
            `${fmtPct(pct(entries[i].val, totalFrete))} do frete do filtro`,
            `${fmtInt(entries[i].n)} NFs · frete médio ${fmtBRL(entries[i].n ? entries[i].val / entries[i].n : 0)}`,
          ]
        ),
      },
      scales: { x: yValue(axisMoney), y: yCategory() },
    },
  }, { pick: (i) => toggleSelect("filter-product", entries[i].p), dim: true });
}

function renderCountByProduct(data) {
  const entries = topProducts(data, (arr) => arr.length, 10);
  const totalN = data.length;
  buildChart("chart-count-prod", {
    type: "bar",
    data: {
      labels: entries.map((e) => e.p),
      datasets: [{ label: "Nº de NFs", data: entries.map((e) => e.n), backgroundColor: C.ink, borderRadius: 0, barPercentage: 0.7 }],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      interaction: { mode: "nearest", axis: "y", intersect: false },
      layout: { padding: { right: 40 } },
      plugins: {
        legend: { display: false },
        valueLabels: { formatter: (v) => fmtInt(v) },
        tooltip: tip(
          (it) => `${fmtInt(it.parsed.x)} NFs`,
          (i) => [
            `${fmtPct(pct(entries[i].n, totalN))} das NFs do filtro`,
            `Frete: ${fmtBRL(entries[i].val || 0)}`,
          ]
        ),
      },
      scales: { x: yValue(fmtInt), y: yCategory() },
    },
  }, { pick: (i) => toggleSelect("filter-product", entries[i].p), dim: true });
}

function renderOrigin(data) {
  const groups = {};
  data.forEach((r) => { (groups[r.origem] = groups[r.origem] || []).push(r); });
  const entries = Object.entries(groups).map(([o, arr]) => ({
    o, n: arr.length, frete: sum(arr.map((r) => r.vfrete || 0)),
  })).sort((a, b) => b.frete - a.frete || b.n - a.n);
  const totalF = sum(entries.map((e) => e.frete));
  const totalN = sum(entries.map((e) => e.n));
  const shareF = entries.map((e) => pct(e.frete, totalF));
  const shareN = entries.map((e) => pct(e.n, totalN));

  buildChart("chart-origin", {
    type: "bar",
    data: {
      labels: entries.map((e) => e.o),
      datasets: [
        { label: "% do frete", data: shareF, backgroundColor: C.neutral, borderRadius: 0, barPercentage: 0.6, categoryPercentage: 0.7 },
        { label: "% das NFs", data: shareN, backgroundColor: C.ink, borderRadius: 0, barPercentage: 0.6, categoryPercentage: 0.7 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: legendTop(),
        valueLabels: { formatter: (v) => fmtPct(v) },
        tooltip: tip(
          (it) => it.datasetIndex === 0
            ? `Frete: ${fmtBRL(entries[it.dataIndex].frete)} (${fmtPct(shareF[it.dataIndex])})`
            : `NFs: ${fmtInt(entries[it.dataIndex].n)} (${fmtPct(shareN[it.dataIndex])})`,
          (i) => [`Frete médio por NF: ${fmtBRL(entries[i].n ? entries[i].frete / entries[i].n : 0)}`]
        ),
      },
      scales: {
        x: xCat(0),
        y: {
          beginAtZero: true, max: 115,
          ticks: { color: C.text, font: { size: 10 }, stepSize: 25, callback: (v) => (v > 100 ? "" : v + "%") },
          grid: { color: C.grid }, border: { display: false },
        },
      },
    },
  }, { pick: (i) => toggleSelect("filter-origin", entries[i].o), dim: true });
}

function renderTicket(data) {
  const s = monthSeries(data);
  const ticket = s.groups.map((g) => {
    const fr = g.map((r) => r.vfrete).filter((v) => v != null);
    return fr.length ? sum(fr) / fr.length : null;
  });
  const withFrete = data.filter((r) => r.vfrete != null);
  const avgAll = withFrete.length ? sum(withFrete.map((r) => r.vfrete)) / withFrete.length : 0;
  buildChart("chart-ticket", {
    type: "line",
    data: {
      labels: s.labels,
      datasets: [
        { label: "Frete médio por NF", data: ticket, borderColor: C.neutral, backgroundColor: "rgba(226,6,19,0.08)", borderWidth: 2, pointRadius: 2.5, pointHoverRadius: 5, tension: 0.25, fill: true, spanGaps: true },
        { label: "Média do período", data: s.labels.map(() => avgAll), borderColor: C.ink, borderWidth: 1.2, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 0, fill: false, spanGaps: true },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: legendTop(),
        tooltip: tip(
          (it) => it.datasetIndex === 1 ? `Média do período: ${fmtBRL(avgAll)}`
            : (it.parsed.y == null || !isFinite(it.parsed.y)) ? "Sem frete no mês" : `${fmtBRL(it.parsed.y)} por NF`,
          (i) => (ticket[i] == null ? [] : changeLines(ticket, i, fmtBRL))
        ),
      },
      scales: { x: xCat(), y: yValue(axisMoney) },
    },
  }, { pick: (i) => toggleMonth(s.keys[i]) });
}

function renderProductSeries(data) {
  const container = el("extra-charts");
  if (!container) return;
  container.innerHTML = "";
  // top 6 produtos por frete -> um card de evolução mensal cada
  const tops = topProducts(data, (arr) => sum(arr.map((r) => r.vfrete || 0)), 6);
  const n = tops.length;
  const wide = window.innerWidth >= 1500;
  const cols = n <= 4 ? Math.max(n, 1) : n === 5 ? (wide ? 5 : 3) : 3;
  container.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  tops.forEach((entry, i) => {
    const color = PRODUCT_COLORS[i % PRODUCT_COLORS.length];
    const subset = data.filter((r) => r.produto === entry.p);
    const s = monthSeries(subset);
    const freteM = s.groups.map((g) => sum(g.map((r) => r.vfrete || 0)));
    const card = document.createElement("div");
    card.className = "extra-card";
    const id = "extra-" + i;
    card.innerHTML =
      `<p class="extra-card__title"><span class="extra-card__swatch" style="background:${color}"></span>${escapeText(entry.p)}</p>` +
      `<div class="extra-card__canvas"><canvas id="${id}"></canvas></div>`;
    container.appendChild(card);
    if (!s.keys.length) return;
    buildChart(id, {
      type: "line",
      data: {
        labels: s.labels,
        datasets: [{ data: freteM, borderColor: color, backgroundColor: color + "22", borderWidth: 1.8, pointRadius: 1.5, pointHoverRadius: 4, tension: 0.25, fill: true }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: tip(
            (it) => `${fmtBRL(it.parsed.y)} de frete`,
            (idx) => changeLines(freteM, idx, fmtBRLcompact)
          ),
        },
        scales: {
          x: { ticks: { color: C.text, font: { size: 9 }, maxTicksLimit: 6, autoSkip: true, maxRotation: 0 }, grid: { display: false }, border: { color: C.axis } },
          y: yValue(axisMoney, 4),
        },
      },
    }, { pick: (idx) => toggleMonth(s.keys[idx]) });
  });
}

function renderBlastbags(data) {
  const section = el("blastbags-section");
  if (!section) return;

  const subset = data.filter((r) => norm(r.produto).includes(BLASTBAG_TOKEN));
  if (!subset.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;

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
    color: C.ink,
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
    color: C.neutral,
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

function productGroups(data, predicate = () => true) {
  const groups = {};
  data.filter(predicate).forEach((r) => {
    (groups[r.produto] = groups[r.produto] || []).push(r);
  });
  return Object.entries(groups)
    .map(([p, arr]) => ({ p, arr }))
    .sort((a, b) => a.p.localeCompare(b.p, "pt-BR"));
}

function renderBlastbagKpis(subset, entries) {
  const box = el("blastbag-kpis");
  if (!box) return;
  const totalQty = sum(entries.map((e) => e.qty));
  const totalProducts = sum(entries.map((e) => e.vprod));
  const leader = [...entries].sort((a, b) => b.vprod - a.vprod)[0];
  const leaderShare = leader && totalProducts ? leader.vprod / totalProducts * 100 : 0;
  const cards = [
    { label: "NFs Blastbag", value: fmtInt(subset.length) },
    { label: "Quantidade", value: fmtNum(totalQty, 0) },
    { label: "Valor produtos", value: fmtBRLcompact(totalProducts) },
    { label: "Maior participação", value: leader ? `${fmtNum(leaderShare, 1)}%` : "—" },
  ];
  box.innerHTML = cards.map((card) =>
    `<div class="blastbag-kpi">` +
    `<p class="blastbag-kpi__label">${escapeText(card.label)}</p>` +
    `<p class="blastbag-kpi__value">${escapeText(card.value)}</p>` +
    `</div>`
  ).join("");
}

function renderBlastbagBar(canvasId, entries, cfg) {
  const ranked = [...entries]
    .map((entry) => ({ ...entry, chartValue: cfg.value(entry) || 0 }))
    .sort((a, b) => b.chartValue - a.chartValue);
  const total = sum(ranked.map((e) => e.chartValue));
  buildChart(canvasId, {
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
      interaction: { mode: "nearest", axis: "y", intersect: false },
      layout: { padding: { right: 24 } },
      plugins: {
        legend: { display: false },
        blastbagValueLabels: {
          formatter: (value, dataIndex) => cfg.valueLabel(value, ranked[dataIndex], total),
          color: cfg.color,
        },
        tooltip: tip(
          (it) => cfg.tooltip(it.parsed.x, ranked[it.dataIndex], total),
          null
        ),
      },
      scales: {
        x: {
          ...yValue(cfg.compactAxis ? axisMoney : fmtInt),
          suggestedMax: Math.max(...ranked.map((e) => e.chartValue), 0) * 1.15,
        },
        y: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: C.ink,
            font: { size: 10 },
            autoSkip: false,
            callback: (_value, index) => shortName(ranked[index] ? ranked[index].p : "", 30),
          },
        },
      },
    },
  }, {
    pick: (i) => toggleSelect("filter-product", ranked[i].p),
    dim: true,
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

  const tbody = el("nf-tbody");
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

  el("table-info").textContent =
    rows.length ? `Mostrando ${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} de ${fmtInt(rows.length)} notas` : "Nenhuma nota";

  renderPager(totalPages);
}

function renderPager(totalPages) {
  const pager = el("pager");
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

/* ===================== Helpers de gráfico ===================== */
function withAlpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* Esmaece as barras não selecionadas ao passar o mouse (apenas datasets de barra com cor fixa) */
function applyDim(chart, idx) {
  if (chart._dimIdx === idx) return;
  chart._dimIdx = idx;
  chart.data.datasets.forEach((ds) => {
    if (ds.type && ds.type !== "bar") return;
    if (typeof ds._base !== "string") return;
    ds.backgroundColor = ds.data.map((_, i) => (idx == null || i === idx ? ds._base : withAlpha(ds._base, 0.28)));
  });
  chart.update("none");
}

/**
 * Cria o gráfico com interações:
 *  - hover: cursor pointer quando há ação de clique; barras não focadas são esmaecidas
 *  - clique: opts.pick(índice) aplica o filtro do painel
 */
function buildChart(canvasId, config, opts = {}) {
  if (CHARTS[canvasId]) {
    try { CHARTS[canvasId].stop(); CHARTS[canvasId].destroy(); } catch (e) { /* instância já encerrada */ }
    delete CHARTS[canvasId];
  }
  const canvas = el(canvasId);
  if (!canvas || !window.Chart) return;

  config.data.datasets.forEach((ds) => {
    if (typeof ds.backgroundColor === "string") ds._base = ds.backgroundColor;
  });

  const options = config.options || (config.options = {});
  options.onHover = (evt, els, chart) => {
    const hit = !!(els && els.length);
    canvas.style.cursor = hit && opts.pick ? "pointer" : "default";
    if (opts.dim) applyDim(chart, hit ? els[0].index : null);
  };
  options.onClick = (evt, els) => {
    if (!opts.pick || !els || !els.length) return;
    // adia: destruir o gráfico dentro do próprio evento do Chart.js quebra a animação
    const idx = els[0].index;
    setTimeout(() => opts.pick(idx), 0);
  };
  CHARTS[canvasId] = new Chart(canvas, config);
}

function tooltipCfg(extra) { return Object.assign({}, tooltipBase(), extra || {}); }
function tooltipBase() {
  return {
    enabled: true, backgroundColor: "rgba(56,66,75,0.96)", titleColor: "#ffffff", bodyColor: "#e8e8e8",
    borderColor: "#38424B", borderWidth: 0, padding: 10, cornerRadius: 2, caretSize: 6, caretPadding: 8,
    displayColors: true, boxWidth: 8, boxHeight: 8, boxPadding: 4,
    titleFont: { weight: "700", size: 12 }, bodyFont: { size: 11 }, bodySpacing: 4, footerFont: { size: 10 },
  };
}
/** Tooltip com linha principal + linhas de apoio (participação, comparação) */
function tip(labelFn, extraFn) {
  return tooltipCfg({
    callbacks: {
      label: (it) => labelFn(it),
      afterBody: (items) => {
        if (!extraFn || !items.length) return [];
        return (extraFn(items[0].dataIndex) || []).filter(Boolean);
      },
    },
  });
}
function legendTop() {
  return { display: true, position: "top", align: "start", labels: { color: C.text, boxWidth: 10, boxHeight: 10, font: { size: 10 }, padding: 14 } };
}
function xCat(rotation = 45) {
  return {
    ticks: { color: C.text, font: { size: 10 }, maxRotation: rotation, autoSkip: true, autoSkipPadding: 8 },
    grid: { display: false }, border: { color: C.axis },
  };
}
function yCategory() {
  return {
    grid: { display: false }, border: { display: false },
    ticks: {
      color: C.ink, font: { size: 10 }, autoSkip: false,
      callback: function (v) { return shortName(String(this.getLabelForValue(v)), 30); },
    },
  };
}
function yValue(fmt, maxTicks) {
  return {
    beginAtZero: true,
    ticks: { color: C.text, font: { size: 10 }, maxTicksLimit: maxTicks || 7, callback: (v) => fmt(v) },
    grid: { color: C.grid }, border: { display: false },
  };
}

/* Rótulos de valor: no fim das barras horizontais, acima das verticais */
const valueLabelsPlugin = {
  id: "valueLabels",
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.formatter) return;
    const { ctx } = chart;
    const horizontal = chart.options.indexAxis === "y";
    ctx.save();
    ctx.font = "600 10px " + Chart.defaults.font.family;
    ctx.fillStyle = C.ink;
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden || (ds.type && ds.type !== "bar")) return;
      meta.data.forEach((bar, i) => {
        const v = ds.data[i];
        if (v == null || !isFinite(v)) return;
        const label = opts.formatter(v, i, di);
        if (horizontal) {
          ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillText(label, bar.x + 6, bar.y);
        } else {
          ctx.textAlign = "center"; ctx.textBaseline = "bottom";
          ctx.fillText(label, bar.x, bar.y - 4);
        }
      });
    });
    ctx.restore();
  },
};

const blastbagValueLabelsPlugin = {
  id: "blastbagValueLabels",
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.formatter) return;
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
      const label = opts.formatter(value, i);
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
  const node = el("status");
  if (!node) return;
  node.classList.remove("is-loading", "is-ok", "is-error");
  if (kind === "loading") node.classList.add("is-loading");
  if (kind === "ok") node.classList.add("is-ok");
  if (kind === "error") node.classList.add("is-error");
  const t = el("status-text");
  if (t) t.textContent = text;
}
function nowBR() { return new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }); }

/* ===================== Barra lateral / flyouts ===================== */
function initSideNav() {
  const items = [...document.querySelectorAll(".side-item[data-flyout]")];
  if (!items.length) return;

  const closeAll = (returnFocus) => {
    items.forEach((item) => {
      if (!item.classList.contains("is-open")) return;
      item.classList.remove("is-open");
      const btn = item.querySelector(".side-btn");
      if (btn) btn.setAttribute("aria-expanded", "false");
      if (returnFocus && btn) btn.focus();
    });
  };

  items.forEach((item) => {
    const btn = item.querySelector(".side-btn");
    const closeBtn = item.querySelector(".flyout__close");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = !item.classList.contains("is-open");
      closeAll(false);
      if (willOpen) {
        item.classList.add("is-open");
        btn.setAttribute("aria-expanded", "true");
        const field = item.querySelector("select, input");
        if (field && window.matchMedia("(hover: hover)").matches) field.focus();
      }
    });
    if (closeBtn) closeBtn.addEventListener("click", () => closeAll(true));
  });

  // clique fora fecha qualquer flyout aberto
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".side-nav")) closeAll(false);
  });
  // Esc fecha e devolve o foco ao botão
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAll(true);
  });
}
document.addEventListener("DOMContentLoaded", initSideNav);

document.addEventListener("DOMContentLoaded", () => {
  if (!window.Chart) {
    setStatus("error", "Biblioteca de gráficos (Chart.js) não carregou. Verifique sua conexão.");
    return;
  }
  Chart.defaults.font.family = "'Segoe UI', -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif";
  Chart.defaults.font.size = 10;
  Chart.defaults.color = "#8A8F96";
  Chart.defaults.borderColor = "#D5D8DC";
  Chart.defaults.animation = false;
  Object.assign(Chart.defaults.plugins.tooltip, tooltipBase());
  Chart.register(blastbagValueLabelsPlugin, valueLabelsPlugin);

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
  const search = el("table-search");
  let t;
  search.oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => { STATE.search = search.value; STATE.page = 1; renderTable(filtered()); }, 180);
  };

  loadSheet().catch((e) => console.error(e));
  setInterval(() => loadSheet().catch(() => {}), 10 * 60 * 1000);
});
