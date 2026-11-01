/* 目标页：全市场四条件扫描（策影目标页同源口径）。
 * 指标层（均线/量比/六分段/涨停次数）服务端一次算好按数据日缓存；
 * 条件层前端勾选 → 传参即时重筛；数据更新后缓存键变化自动重算。
 * 页面打开时加载，驻留期间 60s 轮询（数据更新即新结果）。 */
import { marketApi, type TargetItem } from "../api";
import { esc, fmt, fmtChg } from "../fmt";
import { createPager, slicePage, type Pager } from "../pager";
import { createDataTable, type DataTable, type DataTableCol } from "../table";
import { trendPalette } from "./kline";

type Cond = "vol" | "short" | "mid" | "up20" | "trend";
const CONDS: { k: Cond; label: string; title: string }[] = [
  { k: "trend", label: "趋势柱线", title: "STICKV 负转正或持续在零轴上方，可独立筛选或与其他条件同时满足" },
  { k: "vol", label: "40日均量", title: "当日成交量 ≥ 40日均量" },
  { k: "short", label: "短线趋势橙", title: "收盘站上 MA10（K 线短线趋势通道填橙同判定）" },
  { k: "mid", label: "中线趋势橙", title: "收盘站上 MA45（K 线中线趋势通道填橙同判定）" },
  { k: "up20", label: "20日内涨停", title: "近 20 个交易日有过涨停（主板 10% / 创业科创 20%）" },
];
let conds: Record<Cond, boolean> = { vol: true, short: true, mid: true, up20: true, trend: false };
try {
  const raw = localStorage.getItem("yc_tgt_conds");
  if (raw) conds = { ...conds, ...(JSON.parse(raw) as Partial<Record<Cond, boolean>>) };
} catch { /* 损坏回默认全勾 */ }
let timer: ReturnType<typeof setInterval> | null = null;
let revision = 0;
let trend = { mode: "cross", recent: 5, stillAbove: true, aboveDays: 1 };
try {
  const saved = JSON.parse(localStorage.getItem("yc_tgt_trend") || "null");
  if (saved && ["cross", "above"].includes(saved.mode) && [saved.recent, saved.aboveDays].every(n => Number.isInteger(n) && n >= 1 && n <= 250) && typeof saved.stillAbove === "boolean") trend = saved;
} catch { /* 损坏设置回默认 */ }
let totalHits = 0;

/* 分页（通用组件）：指标层一次算完返回全量，前端切片渲染 */
let pager: Pager | null = null;
let tbl: DataTable<TargetItem> | null = null;
let tableHasTrend = false;
let items: TargetItem[] = [];
let scanned = 0;

function condsParam(): string {
  return CONDS.filter((d) => conds[d.k]).map((d) => d.k).join(",");
}

async function load(resetPage = false): Promise<void> {
  const request = ++revision;
  const st = document.getElementById("tgt-status")!;
  st.textContent = "计算中…";
  try {
    const r = await marketApi.targets(condsParam(), 10000, trend);
    if (request !== revision) return;
    totalHits = r.total_hits;
    items = r.items;
    scanned = r.scanned;
    if (resetPage) pager?.reset();
    drawPage();
    st.textContent = r.as_of ? `数据截至 ${r.as_of}` : "";
  } catch {
    if (request !== revision) return;
    st.textContent = "计算失败，稍后自动重试";
  }
}

/* 主题色（retheme 后由 drawPage 刷新，列渲染取用） */
const PAL = { o: "", b: "" };

const TGT_COLS: DataTableCol<TargetItem>[] = [
  { label: "#", width: 34, mono: true, render: (_t, i) => `<span style="color:var(--faint)">${i + 1}</span>` },
  { label: "代码", mono: true, sort: "symbol", render: (t) => t.symbol },
  { label: "名称", sort: "name", render: (t) => `<span style="font-weight:600">${esc(t.name || t.symbol)}</span>` },
  { label: "现价", num: true, sort: "close", render: (t) => fmt(t.close ?? 0) },
  { label: "涨跌幅", num: true, sort: (t) => t.pct_chg ?? null, render: (t) => {
      const ch = t.pct_chg ?? 0;
      return `<span class="${ch >= 0 ? "up" : "down"}">${fmtChg(ch)}%</span>`; } },
  { label: "STICKV", num: true, sort: t => t.trend_value ?? null, render: t => t.trend_value == null ? "—" : `<span class="${t.trend_value > 0 ? "up" : "down"}">${t.trend_value.toFixed(2)}</span>${t.trend_provisional ? '<small> 盘中暂定</small>' : ''}` },
  { label: "最近转正", sort: t => t.trend_cross_date ?? "", render: t => t.trend_cross_date ?? "—" },
  { label: "距今交易日", num: true, sort: t => t.trend_cross_ago ?? null, render: t => t.trend_cross_ago == null ? "—" : t.trend_cross_ago === 0 ? "当日" : `${t.trend_cross_ago}日前` },
  { label: "连续上方", num: true, sort: t => t.trend_above_days, render: t => t.trend_value == null ? "—" : `${t.trend_above_days}日` },
  { label: "40日均量", num: true, title: "当日成交量 / 40日均量", sort: (t) => t.vol_ratio,
    render: (t) => `<span style="color:${t.vol_hit ? PAL.o : "var(--dim)"}">${t.vol_ratio == null ? "—" : `${t.vol_ratio.toFixed(2)}x`}</span>` },
  { label: "短线趋势", sort: (t) => (t.short_orange ? 1 : 0), render: (t) =>
      `<span style="color:${t.short_orange ? PAL.o : PAL.b}">●</span> ${t.short_orange ? "橙" : "蓝"}` },
  { label: "中线趋势", sort: (t) => (t.mid_orange ? 1 : 0), render: (t) =>
      `<span style="color:${t.mid_orange ? PAL.o : PAL.b}">●</span> ${t.mid_orange ? "橙" : "蓝"}` },
  { label: "20日涨停", num: true, title: "近 20 个交易日涨停次数", sort: (t) => t.limit_up_cnt,
    render: (t) => t.limit_up_20d ? `<span class="tag acc">${t.limit_up_cnt}次</span>` : `<span style="color:var(--faint)">—</span>` },
  { label: "六分段", sort: "seg", render: (t) =>
      `<span class="tag ${t.seg >= 4 ? "acc" : t.seg <= 1 ? "flat" : "p1"}">第${t.seg}段·${esc(t.seg_name)}</span>` },
  { label: "短线状态", sort: (t) => (t.pullback ? 0 : 1), render: (t) =>
      `<span style="font-size:11.5px;color:${t.short_orange ? PAL.o : PAL.b}">${t.pullback ? "回调中" : "上行"} · ${t.short_orange ? "橙" : "蓝"}</span>` },
];

function drawPage(): void {
  const empty = document.getElementById("tgt-empty")!;
  if (!pager) pager = createPager(document.getElementById("tgt-pager")!, "targets", drawPage);
  if (tableHasTrend !== conds.trend) { tbl = null; tableHasTrend = conds.trend; }
  const columns = conds.trend ? TGT_COLS : TGT_COLS.filter(column => !["STICKV", "最近转正", "距今交易日", "连续上方"].includes(column.label));
  if (!tbl) tbl = createDataTable(document.getElementById("tgt-wrap")!, columns, {
    rowKey: (t) => t.symbol,
    onRow: (t) => document.dispatchEvent(new CustomEvent("yc:open-stock", {
      detail: { symbol: t.symbol, name: t.name || t.symbol,
        trendFocus: conds.trend ? { date: t.trend_cross_date ?? t.trend_data_date } : undefined,
        from: { page: "targets", label: "目标监控" } } })),
  });
  pager.update(items.length);
  const start = (pager.page - 1) * pager.size;
  const pageRows = slicePage(pager, tbl.sort(items));
  const pal = trendPalette();
  PAL.o = `rgb(${pal.fr.join(",")})`;
  PAL.b = `rgb(${pal.sr.join(",")})`;
  tbl.render(pageRows, start);
  document.getElementById("tgt-hits")!.textContent =
    `命中 ${totalHits} / 扫描 ${scanned} 只${totalHits > items.length ? ` · 显示前 ${items.length} 只` : ""}`;
  empty.style.display = items.length ? "none" : "grid";
}

function renderConds(): void {
  const el = document.getElementById("tgt-conds")!;
  el.innerHTML = CONDS.map((d) =>
    `<button type="button" class="chip${conds[d.k] ? " on" : ""}" aria-pressed="${conds[d.k]}" data-c="${d.k}" title="${esc(d.title)}">${esc(d.label)}</button>`).join("") +
    `<span style="font-size:11.5px;color:var(--faint)">所有勾选条件同时满足 · ST 已剔除 · 未勾选不参与判定</span>`;
  if (conds.trend) {
    el.insertAdjacentHTML("beforeend", `<div style="width:100%;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0">
      <label>趋势柱线 <select id="tgt-trend-mode"><option value="cross" ${trend.mode === "cross" ? "selected" : ""}>负转正</option><option value="above" ${trend.mode === "above" ? "selected" : ""}>零轴上方</option></select></label>
      ${trend.mode === "cross" ? `<label>最近 <select id="tgt-trend-recent">${[1,3,5,10,20].map(n => `<option value="${n}" ${trend.recent === n ? "selected" : ""}>${n}</option>`).join('')}<option value="custom" ${![1,3,5,10,20].includes(trend.recent) ? "selected" : ""}>自定义</option></select> 个交易日</label>
      <label>天数 <input aria-label="最近交易日数" id="tgt-trend-days" type="number" min="1" max="250" step="1" value="${trend.recent}" style="width:65px"></label>
      <label><input id="tgt-trend-still" type="checkbox" ${trend.stillAbove ? "checked" : ""}>当前仍在零轴上方</label>` :
      `<label>连续至少 <input aria-label="连续上方交易日数" id="tgt-trend-days" type="number" min="1" max="250" step="1" value="${trend.aboveDays}" style="width:65px"> 个交易日</label>`}
      <span style="font-size:12px;color:var(--faint)">${trend.mode === "cross" ? "前值≤0、当日>0；窗口包含最新数据日" : "STICKV>0，零值不计入连续天数"} · 日K前复权</span></div>`);
    const save = () => { localStorage.setItem("yc_tgt_trend", JSON.stringify(trend)); renderConds(); void load(true); };
    el.querySelector<HTMLSelectElement>('#tgt-trend-mode')!.onchange = event => { trend.mode = (event.target as HTMLSelectElement).value; save(); };
    const recent = el.querySelector<HTMLSelectElement>('#tgt-trend-recent');
    if (recent) recent.onchange = () => { if (recent.value === "custom") { el.querySelector<HTMLInputElement>('#tgt-trend-days')!.focus(); return; } trend.recent = Number(recent.value); save(); };
    const days = el.querySelector<HTMLInputElement>('#tgt-trend-days')!;
    days.onchange = () => { if (!days.reportValidity()) return; if (trend.mode === "cross") trend.recent = Number(days.value); else trend.aboveDays = Number(days.value); save(); };
    const still = el.querySelector<HTMLInputElement>('#tgt-trend-still');
    if (still) still.onchange = () => { trend.stillAbove = still.checked; save(); };
  }
  el.querySelectorAll<HTMLElement>(".chip[data-c]").forEach((c) =>
    c.addEventListener("click", () => {
      const k = c.dataset.c as Cond;
      conds[k] = !conds[k];
      localStorage.setItem("yc_tgt_conds", JSON.stringify(conds));
      renderConds();
      void load(true);                   // 改条件 → 即时重筛（指标层缓存，毫秒级）
    }));
}

export function loadTargets(): void {
  renderConds();
  void load();
  if (!timer) {                          // 驻留轮询：数据更新（缓存键变化）即出新结果
    timer = setInterval(() => {
      if (document.getElementById("page-targets")?.classList.contains("on")) void load();
    }, 60_000);
  }
}

export function initTargets(): void {
  document.getElementById("tgt-refresh")!.addEventListener("click", () => void load());
}
