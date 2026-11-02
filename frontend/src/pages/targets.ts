/* 目标页：全市场多条件叠加选股（策影目标页同源口径）。
 * 指标层（均线/量比/六分段/涨停次数…）服务端后台定时预计算落表，端点只读；
 * 条件层由 GET /market/targets/conditions 下发元数据驱动条件栏渲染——
 * 后端 screening.CONDITIONS 新增指标（如主力吸筹）后前端自动出现，
 * 勾选/改阈值即时重筛（毫秒级），数据更新才重算指标层。 */
import { marketApi, type TargetCond, type TargetItem } from "../api";
import { esc, fmt, fmtChg } from "../fmt";
import { createPager, slicePage, type Pager } from "../pager";
import { createDataTable, type DataTable, type DataTableCol } from "../table";
import { trendPalette } from "./kline";

/* 后端不可达时的兜底登记（与 screening.CONDITIONS 同构，仅为首屏不空） */
const FALLBACK_CONDS: TargetCond[] = [
  { key: "trend", label: "趋势柱线", kind: "trend", default_on: false,
    title: "STICKV 负转正或持续在零轴上方，可独立筛选或与其他条件同时满足" },
  { key: "vol", label: "40日均量", kind: "value", op: ">=", default: 1.0,
    min: 0.0, max: 10.0, step: 0.1, unit: "x", default_on: true,
    title: "当日成交量 / 40日均量 不小于阈值" },
  { key: "short", label: "短线趋势橙", kind: "flag", default_on: true,
    title: "收盘站上 MA10（K 线短线趋势通道填橙同判定）" },
  { key: "mid", label: "中线趋势橙", kind: "flag", default_on: true,
    title: "收盘站上 MA45（K 线中线趋势通道填橙同判定）" },
  { key: "up20", label: "20日内涨停", kind: "flag", default_on: true,
    title: "近 20 个交易日有过涨停（主板 10% / 创业科创 20%）" },
];

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}

function clampVal(c: TargetCond, v: number): number {
  const lo = c.min ?? -Infinity, hi = c.max ?? Infinity;
  return Math.min(hi, Math.max(lo, v));
}

let meta: TargetCond[] = FALLBACK_CONDS;
let conds: Record<string, boolean> = {};
let tvals: Record<string, number> = {};
let metaLoaded = false;

function applyMeta(list: TargetCond[]): void {
  meta = list.length ? list : FALLBACK_CONDS;
  const savedC = readJSON<Record<string, boolean>>("yc_tgt_conds", {});
  const savedV = readJSON<Record<string, number>>("yc_tgt_vals", {});
  conds = {};
  tvals = {};
  for (const c of meta) {
    conds[c.key] = typeof savedC[c.key] === "boolean" ? savedC[c.key] : c.default_on;
    if (c.kind === "value") {
      const v = Number(savedV[c.key]);
      tvals[c.key] = Number.isFinite(v) ? clampVal(c, v) : Number(c.default ?? 0);
    }
  }
}

async function ensureMeta(): Promise<void> {
  if (metaLoaded) return;
  metaLoaded = true;
  try {
    applyMeta(await marketApi.targetConds());
  } catch { applyMeta(FALLBACK_CONDS); }
}

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
  return meta.filter((d) => conds[d.key]).map((d) => d.key).join(",");
}

/* 数值条件的阈值只随启用条件下发；未勾选的不参与判定 */
function valuesParam(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of meta) if (d.kind === "value" && conds[d.key]) out[d.key] = tvals[d.key];
  return out;
}

async function load(resetPage = false): Promise<void> {
  const request = ++revision;
  const st = document.getElementById("tgt-status")!;
  st.textContent = "计算中…";
  try {
    const r = await marketApi.targets(condsParam(), 10000, trend, valuesParam());
    if (request !== revision) return;
    totalHits = r.total_hits;
    items = r.items;
    scanned = r.scanned;
    if (resetPage) pager?.reset();
    drawPage();
    const at = r.computed_at || "";
    st.textContent = at
      ? `计算于 ${at}｜数据截至 ${r.as_of}${r.provisional ? "（含实时快照）" : ""}`
      : (r.as_of ? `数据截至 ${r.as_of}${r.provisional ? "（今日 K 线未落库，按实时快照暂定）" : ""}` : "");
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
  { label: "负柱收敛", num: true, title: "STICKV 连续为负且逐日收窄的天数（绿柱缩短，提前捕捉上穿零轴）",
    sort: t => t.neg_run ?? 0, render: t => t.neg_run
      ? `<span class="tag ${t.neg_run >= 3 ? "acc" : "p1"}">${t.neg_run}日</span>`
      : `<span style="color:var(--faint)">—</span>` },
  { label: "距零轴", num: true, title: "当前负柱幅度 |STICKV|，越小越贴近零轴",
    sort: t => t.neg_abs ?? null,
    render: t => t.neg_abs == null ? `<span style="color:var(--faint)">—</span>` : t.neg_abs.toFixed(1) },
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
  const wantTrend = !!(conds["trend"] || conds["negshrink"] || conds["nearzero"]);
  if (!pager) pager = createPager(document.getElementById("tgt-pager")!, "targets", drawPage);
  if (tableHasTrend !== wantTrend) { tbl = null; tableHasTrend = wantTrend; }
  const columns = wantTrend ? TGT_COLS : TGT_COLS.filter(column =>
    !["STICKV", "最近转正", "距今交易日", "连续上方", "负柱收敛", "距零轴"].includes(column.label));
  if (!tbl) tbl = createDataTable(document.getElementById("tgt-wrap")!, columns, {
    rowKey: (t) => t.symbol,
    onRow: (t) => document.dispatchEvent(new CustomEvent("yc:open-stock", {
      detail: { symbol: t.symbol, name: t.name || t.symbol,
        trendFocus: wantTrend ? { date: t.trend_cross_date ?? t.trend_data_date } : undefined,
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
  el.innerHTML = meta.map((d) => {
    const on = !!conds[d.key];
    const chip = `<button type="button" class="chip${on ? " on" : ""}" aria-pressed="${on}" data-c="${d.key}" title="${esc(d.title || "")}">${esc(d.label)}</button>`;
    if (d.kind !== "value") return chip;
    const unit = d.unit ? ` ${esc(d.unit)}` : "";
    return `<span class="tgt-val${on ? "" : " off"}">${chip}<label>${d.op === "<=" ? "≤" : "≥"}` +
      `<input type="number" data-v="${d.key}" aria-label="${esc(d.label)}阈值"` +
      `${d.min == null ? "" : ` min="${d.min}"`}${d.max == null ? "" : ` max="${d.max}"`}` +
      ` step="${d.step ?? "any"}" value="${tvals[d.key]}"${on ? "" : " disabled"}>${unit}</label></span>`;
  }).join("") +
    `<span style="font-size:11.5px;color:var(--faint)">所有勾选条件同时满足 · ST 已剔除 · 未勾选不参与判定</span>`;
  if (conds["trend"]) {
    el.insertAdjacentHTML("beforeend", `<div class="tgt-trend-set">
      <label>趋势柱线 <select id="tgt-trend-mode"><option value="cross" ${trend.mode === "cross" ? "selected" : ""}>负转正</option><option value="above" ${trend.mode === "above" ? "selected" : ""}>零轴上方</option></select></label>
      ${trend.mode === "cross" ? `<label>最近 <select id="tgt-trend-recent">${[1,3,5,10,20].map(n => `<option value="${n}" ${trend.recent === n ? "selected" : ""}>${n}</option>`).join('')}<option value="custom" ${![1,3,5,10,20].includes(trend.recent) ? "selected" : ""}>自定义</option></select> 个交易日</label>
      <label>天数 <input aria-label="最近交易日数" id="tgt-trend-days" type="number" min="1" max="250" step="1" value="${trend.recent}"></label>
      <label><input id="tgt-trend-still" type="checkbox" ${trend.stillAbove ? "checked" : ""}>当前仍在零轴上方</label>` :
      `<label>连续至少 <input aria-label="连续上方交易日数" id="tgt-trend-days" type="number" min="1" max="250" step="1" value="${trend.aboveDays}"> 个交易日</label>`}
      <span class="tgt-trend-hint">${trend.mode === "cross" ? "前值≤0、当日>0；窗口包含最新数据日" : "STICKV>0，零值不计入连续天数"} · 日K前复权</span></div>`);
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
      const k = c.dataset.c!;
      conds[k] = !conds[k];
      localStorage.setItem("yc_tgt_conds", JSON.stringify(conds));
      renderConds();
      void load(true);                   // 改条件 → 即时重筛（指标层只读，毫秒级）
    }));
  /* 数值阈值：失焦/回车提交，clamp 回登记范围后即时重筛 */
  el.querySelectorAll<HTMLInputElement>("input[data-v]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const d = meta.find((x) => x.key === inp.dataset.v);
      if (!d || !inp.reportValidity()) return;
      const v = Number(inp.value);
      if (!Number.isFinite(v)) return;
      tvals[d.key] = clampVal(d, v);
      inp.value = String(tvals[d.key]);
      localStorage.setItem("yc_tgt_vals", JSON.stringify(tvals));
      void load(true);
    });
  });
}

export function loadTargets(): void {
  void ensureMeta().then(() => {
    renderConds();
    void load();
  });
  if (!timer) {                          // 驻留轮询：数据更新（缓存键变化）即出新结果
    timer = setInterval(() => {
      if (document.getElementById("page-targets")?.classList.contains("on")) void load();
    }, 60_000);
  }
}

export function initTargets(): void {
  document.getElementById("tgt-refresh")!.addEventListener("click", () => void load());
  document.getElementById("tgt-export")!.addEventListener("click", () => void exportExcel());
}

/* 导出当前条件命中的全量列表（后端生成 xlsx，前端按响应头文件名落地） */
async function exportExcel(): Promise<void> {
  const btn = document.getElementById("tgt-export") as HTMLButtonElement;
  const st = document.getElementById("tgt-status")!;
  if (btn.disabled) return;
  btn.disabled = true;
  st.textContent = "正在生成 Excel…";
  try {
    const res = await marketApi.targetExport(condsParam(), trend, valuesParam());
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const name = m ? decodeURIComponent(m[1]) : "目标监控.xlsx";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    st.textContent = `已导出 ${name}（命中 ${totalHits} 只）`;
  } catch {
    st.textContent = "导出失败，请稍后重试";
  } finally {
    btn.disabled = false;
  }
}
